/**
 * Store-direct reads of one `zagg-ragged/1` (or `/2`) array: the object
 * key from the chunk ordinal, the shard index suffix when sharded, the
 * ranged inner-chunk read, then zstd + vlen decode. Nothing here needs
 * zarrita -- its `DataType` union is closed, so a vlen array cannot open
 * through `zarrita.open` today; this is the bypass the tracking issue
 * names.
 *
 * Absent chunks (sentinel in the shard index, or no object when unsharded)
 * decode as all-empty cells: an inner chunk with no ragged data is omitted
 * from the store by contract (spec section 1.1), so absence is data, not
 * an error.
 */

import type { RaggedCell, RaggedElement } from "../vlen/element.js";
import { decodeVlenNdarray, decodeZstd, elementCtor } from "../vlen/index.js";
import { type ChunkSpan, readShardChunk, readShardIndex } from "./shard.js";
import type { RaggedGeometry, RaggedMetadata } from "./metadata.js";
import { parseRaggedMetadata } from "./metadata.js";
import {
  type AbsolutePath,
  type AsyncReadable,
  type GetOptions,
  type RangeReadable,
  absolutePath,
} from "../store/types.js";

export function emptyCell(element: RaggedElement): RaggedCell {
  return {
    data: new (elementCtor(element.dtype))(new ArrayBuffer(0)),
    shape: [0, ...element.innerShape],
  };
}

export class RaggedArray {
  readonly store: AsyncReadable;
  /** Store-absolute array path, e.g. `/1/1/2/1/3/11213.zarr/6/h_tdigest`. */
  readonly path: AbsolutePath;
  readonly metadata: RaggedMetadata;
  readonly #indexes = new Map<
    string,
    Promise<(ChunkSpan | null)[] | undefined>
  >();

  constructor(
    store: AsyncReadable,
    path: AbsolutePath,
    metadata: RaggedMetadata,
  ) {
    this.store = store;
    this.path = path;
    this.metadata = metadata;
  }

  /** Read and parse `<path>/zarr.json`, then construct. */
  static async open(
    store: AsyncReadable,
    path: AbsolutePath,
    opts?: GetOptions,
  ): Promise<RaggedArray> {
    const raw = await store.get(absolutePath(path, "zarr.json"), opts);
    if (raw === undefined) {
      throw new Error(`no array at ${path} (missing zarr.json)`);
    }
    const meta = JSON.parse(new TextDecoder().decode(raw)) as Record<
      string,
      unknown
    >;
    return new RaggedArray(store, path, parseRaggedMetadata(meta, path));
  }

  get element(): RaggedElement {
    return this.metadata.element;
  }

  get geometry(): RaggedGeometry {
    return this.metadata.geometry;
  }

  get length(): number {
    return this.geometry.length;
  }

  get cellsPerChunk(): number {
    return this.geometry.cellsPerChunk;
  }

  /** Number of inner chunks on the axis. */
  get chunkCount(): number {
    return Math.ceil(this.length / this.cellsPerChunk);
  }

  /** The stored object key holding inner chunk `k` (spec section 1.5). */
  objectKey(k: number): AbsolutePath {
    const ordinal = Math.floor(k / this.geometry.chunksPerObject);
    return absolutePath(this.path, `c${this.geometry.separator}${ordinal}`);
  }

  #rangeStore(): RangeReadable {
    if (typeof this.store.getRange !== "function") {
      throw new Error(
        `${this.path} is sharded: the store must implement getRange`,
      );
    }
    return this.store as RangeReadable;
  }

  /** The shard index of the object holding chunk `k` (cached per object). */
  async shardIndex(
    k: number,
    opts?: GetOptions,
  ): Promise<(ChunkSpan | null)[] | undefined> {
    const key = this.objectKey(k);
    let pending = this.#indexes.get(key);
    if (pending === undefined) {
      pending = readShardIndex(
        this.#rangeStore(),
        key,
        this.geometry.chunksPerObject,
        opts,
      ).catch((err) => {
        this.#indexes.delete(key);
        throw err;
      });
      this.#indexes.set(key, pending);
    }
    return pending;
  }

  /** Raw stored bytes of inner chunk `k` (still zstd-compressed), or undefined when absent. */
  async chunkBytes(
    k: number,
    opts?: GetOptions,
  ): Promise<Uint8Array | undefined> {
    if (!Number.isInteger(k) || k < 0 || k >= this.chunkCount) {
      throw new RangeError(`chunk ${k} outside 0..${this.chunkCount - 1}`);
    }
    const key = this.objectKey(k);
    if (!this.geometry.sharded) {
      return this.store.get(key, opts);
    }
    const index = await this.shardIndex(k, opts);
    const span = index?.[k % this.geometry.chunksPerObject] ?? null;
    return span === null
      ? undefined
      : readShardChunk(this.#rangeStore(), key, span, opts);
  }

  /** Cells of inner chunk `k`, decoded; an absent chunk is all-empty cells. */
  async readChunk(k: number, opts?: GetOptions): Promise<RaggedCell[]> {
    const stored = await this.chunkBytes(k, opts);
    const n = Math.min(
      this.cellsPerChunk,
      this.length - k * this.cellsPerChunk,
    );
    if (stored === undefined) {
      return Array.from({ length: n }, () => emptyCell(this.element));
    }
    const framed = this.geometry.zstd ? decodeZstd(stored) : stored;
    const cells = decodeVlenNdarray(framed, this.element);
    if (cells.length !== n) {
      throw new Error(
        `${this.objectKey(k)}: chunk ${k} framed ${cells.length} cells, the axis geometry says ${n}`,
      );
    }
    return cells;
  }

  /** Cells `[start, stop)`: only the covering chunks are fetched (spec section 1.5 spans). */
  async readCells(
    start: number,
    stop: number,
    opts?: GetOptions,
  ): Promise<RaggedCell[]> {
    if (!(0 <= start && start <= stop && stop <= this.length)) {
      throw new RangeError(
        `cell span [${start}, ${stop}) outside 0..${this.length}`,
      );
    }
    const first = Math.floor(start / this.cellsPerChunk);
    const last =
      stop === start ? first - 1 : Math.floor((stop - 1) / this.cellsPerChunk);
    const chunks: RaggedCell[][] = [];
    for (let k = first; k <= last; k++) {
      chunks.push(await this.readChunk(k, opts));
    }
    const base = first * this.cellsPerChunk;
    return chunks.flat().slice(start - base, stop - base);
  }

  /** One cell (the 2-GET random-access recipe when sharded). */
  async readCell(i: number, opts?: GetOptions): Promise<RaggedCell> {
    const [cell] = await this.readCells(i, i + 1, opts);
    return cell;
  }
}
