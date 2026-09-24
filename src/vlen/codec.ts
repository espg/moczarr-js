/**
 * The vlen codecs for zarrita's codec registry, modelled on zarrita's own
 * `vlen-utf8`: an `array_to_bytes` codec whose decode returns one entry per
 * cell.
 *
 * - `vlen-ndarray` (zarr-extensions#71 / zarr-vlen-ndarray): when the chunk
 *   metadata's data type is the typed `ndarray` extension, cells decode to
 *   typed `(n, ...innerShape)` views (`RaggedCell`).
 * - `vlen-bytes` (the zagg-ragged/1 spelling): the same framing over a
 *   `variable_length_bytes` array; without an element declaration in the
 *   data type the cells decode to their raw payload bytes (`Uint8Array`).
 *   Pass an explicit element to `new VlenNdarrayCodec(shape, element)` to
 *   get typed cells on a /1 array (the element lives in attrs there, which
 *   the codec pipeline does not see).
 *
 * Registering is opt-in (`registerVlenCodecs(zarr.registry)`) so this
 * module never touches zarrita at import time; zarrita stays an optional
 * peer. zarrita 0.7's `DataType` union is closed, so until upstream adds
 * the dtype these codecs cannot be reached through `zarrita.open` -- the
 * store-direct leaf reader is the working path; this is the upstream-ready
 * piece.
 */

import {
  type RaggedCell,
  type RaggedElement,
  parseNdarrayDataType,
} from "./element.js";
import { decodeCell, decodeVlenFrames } from "./framing.js";

export const VLEN_NDARRAY_CODEC = "vlen-ndarray";
export const VLEN_BYTES_CODEC = "vlen-bytes";

/** Chunk metadata zarrita hands `fromConfig` (its `ChunkMetadata`). */
export interface VlenChunkMetadata {
  dataType: unknown;
  shape: number[];
}

/** A decoded chunk in zarrita's `Chunk` shape (C-order strides). */
export interface VlenChunk<Cell> {
  data: Cell[];
  shape: number[];
  stride: number[];
}

/** The structural slice of zarrita's `registry` this module needs. */
export type CodecRegistry = Map<string, () => Promise<unknown>>;

function cStrides(shape: number[]): number[] {
  const strides = new Array<number>(shape.length);
  let step = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    strides[i] = step;
    step *= shape[i];
  }
  return strides;
}

export class VlenNdarrayCodec {
  readonly kind = "array_to_bytes";
  readonly shape: number[];
  readonly element: RaggedElement | null;

  constructor(shape: number[], element: RaggedElement | null = null) {
    this.shape = shape;
    this.element = element;
  }

  /** zarrita's codec factory: `(configuration, chunkMetadata)`. */
  static fromConfig(
    _config: unknown,
    meta: VlenChunkMetadata,
  ): VlenNdarrayCodec {
    return new VlenNdarrayCodec(
      meta.shape,
      parseNdarrayDataType(meta.dataType, "chunk"),
    );
  }

  encode(): never {
    throw new Error(`${VLEN_NDARRAY_CODEC} encode is not implemented`);
  }

  decode(bytes: Uint8Array): VlenChunk<RaggedCell> | VlenChunk<Uint8Array> {
    const payloads = decodeVlenFrames(bytes);
    const expected = this.shape.reduce((n, d) => n * d, 1);
    if (payloads.length !== expected) {
      throw new Error(
        `${VLEN_NDARRAY_CODEC}: framed element count ${payloads.length} must ` +
          `equal the product of the chunk shape [${this.shape.join(", ")}] (${expected})`,
      );
    }
    const stride = cStrides(this.shape);
    if (this.element === null) {
      return { data: payloads, shape: this.shape, stride };
    }
    const element = this.element;
    return {
      data: payloads.map((payload) => decodeCell(payload, element)),
      shape: this.shape,
      stride,
    };
  }
}

/**
 * Register the codecs under both names on a zarrita registry:
 * `registerVlenCodecs(zarr.registry)`.
 */
export function registerVlenCodecs(registry: CodecRegistry): void {
  const entry = () => Promise.resolve(VlenNdarrayCodec);
  registry.set(VLEN_NDARRAY_CODEC, entry);
  registry.set(VLEN_BYTES_CODEC, entry);
}
