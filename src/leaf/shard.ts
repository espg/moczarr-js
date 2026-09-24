/**
 * The zarr v3 `sharding_indexed` object layout, read store-direct
 * (englacial/zagg spec section 1.5): one object per shard holding K inner
 * chunks, with an index at `index_location: end` of K `(offset, nbytes)`
 * u64 little-endian pairs followed by a crc32c over them (index codecs
 * `[bytes(little), crc32c]`). An inner chunk with no data is marked absent
 * by the `2^64 - 1` sentinel in both fields. The random-access recipe is
 * two ranged GETs: the `16*K + 4`-byte suffix, then the one inner chunk.
 */

import { crc32c } from "./crc32c.js";
import type {
  AbsolutePath,
  GetOptions,
  RangeReadable,
} from "../store/types.js";

const ABSENT = 0xffffffffffffffffn;

/** Byte window of one inner chunk inside its shard object. */
export interface ChunkSpan {
  offset: number;
  nbytes: number;
}

/** Bytes of the index suffix for K inner chunks under `[bytes, crc32c]`. */
export function shardIndexBytes(chunksPerShard: number): number {
  return 16 * chunksPerShard + 4;
}

/**
 * Parse an index suffix into per-chunk spans (`null` = absent). Verifies
 * the crc32c so a truncated or wrong-object read is loud, never a wild
 * range request.
 */
export function parseShardIndex(
  suffix: Uint8Array,
  chunksPerShard: number,
): (ChunkSpan | null)[] {
  const expected = shardIndexBytes(chunksPerShard);
  if (suffix.byteLength !== expected) {
    throw new Error(
      `shard index suffix is ${suffix.byteLength} bytes; K=${chunksPerShard} needs ${expected}`,
    );
  }
  const body = suffix.subarray(0, expected - 4);
  const view = new DataView(
    suffix.buffer,
    suffix.byteOffset,
    suffix.byteLength,
  );
  const stored = view.getUint32(expected - 4, true);
  const computed = crc32c(body);
  if (stored !== computed) {
    throw new Error(
      `shard index crc32c mismatch: stored ${stored.toString(16)}, computed ${computed.toString(16)}`,
    );
  }
  const spans: (ChunkSpan | null)[] = new Array(chunksPerShard);
  for (let k = 0; k < chunksPerShard; k++) {
    const offset = view.getBigUint64(16 * k, true);
    const nbytes = view.getBigUint64(16 * k + 8, true);
    if (offset === ABSENT && nbytes === ABSENT) {
      spans[k] = null;
    } else if (
      offset > BigInt(Number.MAX_SAFE_INTEGER) ||
      nbytes > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(`shard index entry ${k} exceeds the addressable range`);
    } else {
      spans[k] = { offset: Number(offset), nbytes: Number(nbytes) };
    }
  }
  return spans;
}

/** Ranged-read and parse one shard object's index; `undefined` = no object. */
export async function readShardIndex(
  store: RangeReadable,
  key: AbsolutePath,
  chunksPerShard: number,
  opts?: GetOptions,
): Promise<(ChunkSpan | null)[] | undefined> {
  const suffix = await store.getRange(
    key,
    { suffixLength: shardIndexBytes(chunksPerShard) },
    opts,
  );
  return suffix && parseShardIndex(suffix, chunksPerShard);
}

/** Ranged-read one inner chunk's bytes out of its shard object. */
export async function readShardChunk(
  store: RangeReadable,
  key: AbsolutePath,
  span: ChunkSpan,
  opts?: GetOptions,
): Promise<Uint8Array> {
  const bytes = await store.getRange(
    key,
    { offset: span.offset, length: span.nbytes },
    opts,
  );
  if (bytes === undefined || bytes.byteLength !== span.nbytes) {
    throw new Error(
      `shard ${key}: ranged read at ${span.offset}+${span.nbytes} returned ` +
        `${bytes === undefined ? "nothing" : `${bytes.byteLength} bytes`}`,
    );
  }
  return bytes;
}
