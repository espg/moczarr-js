/**
 * The vlen wire framing (englacial/zagg spec section 1.4, golden-pinned;
 * identical under section 6.2): within one chunk, little-endian
 * throughout,
 *
 *     u32  cell_count
 *     per cell:  u32 payload_length || payload_bytes
 *
 * i.e. numcodecs' VLenBytes framing. A payload is the raw little-endian
 * C-order bytes of the cell's `(n, ...innerShape)` array in the element
 * dtype; an empty cell has length 0. The chunk compresses through
 * zstd(level 3) on the way to disk (section 1.3), so a stored inner chunk
 * decodes as zstd -> frames -> typed cells.
 *
 * Decoders are strict about the envelope (a truncated frame, a payload that
 * is not a whole number of rows) and never guess: the framing carries no
 * per-element shape header, so the row count is `payload_bytes / rowBytes`.
 */

import { decompress } from "fzstd";

import {
  type ElementArray,
  type RaggedCell,
  type RaggedElement,
  elementCtor,
  rowBytes,
} from "./element.js";

/**
 * Split one framed chunk into its per-cell payload byte views (zero-copy
 * subarrays of `bytes`). Throws on a truncated frame.
 */
export function decodeVlenFrames(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength < 4) {
    throw new Error(
      `vlen chunk is ${bytes.byteLength} bytes: too short for the u32 cell count`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const cells: Uint8Array[] = new Array(count);
  let pos = 4;
  for (let i = 0; i < count; i++) {
    if (pos + 4 > bytes.byteLength) {
      throw new Error(
        `vlen chunk truncated: cell ${i} of ${count} has no length prefix ` +
          `(offset ${pos} of ${bytes.byteLength})`,
      );
    }
    const length = view.getUint32(pos, true);
    pos += 4;
    if (pos + length > bytes.byteLength) {
      throw new Error(
        `vlen chunk truncated: cell ${i} of ${count} claims ${length} bytes at ` +
          `offset ${pos} but the chunk holds ${bytes.byteLength}`,
      );
    }
    cells[i] = bytes.subarray(pos, pos + length);
    pos += length;
  }
  if (pos !== bytes.byteLength) {
    throw new Error(
      `vlen chunk has ${bytes.byteLength - pos} trailing bytes after ${count} cells`,
    );
  }
  return cells;
}

/**
 * One cell's `(n, ...innerShape)` typed array from its raw payload bytes
 * (the section 1.2 reconstruction). The view is over a fresh, aligned copy
 * of the payload -- typed arrays need element-aligned offsets, which the
 * framing does not guarantee. An empty payload is the `(0, ...innerShape)`
 * cell.
 */
export function decodeCell(
  payload: Uint8Array,
  element: RaggedElement,
): RaggedCell {
  const stride = rowBytes(element);
  if (stride === 0) {
    if (payload.byteLength !== 0) {
      throw new Error(
        `ragged cell carries ${payload.byteLength} bytes but its element has a ` +
          `zero-sized inner shape [${element.innerShape.join(", ")}]`,
      );
    }
    return {
      data: new (elementCtor(element.dtype))(new ArrayBuffer(0)),
      shape: [0, ...element.innerShape],
    };
  }
  if (payload.byteLength % stride !== 0) {
    throw new Error(
      `ragged cell payload of ${payload.byteLength} bytes is not a whole number ` +
        `of ${stride}-byte ${element.dtype}[${element.innerShape.join(", ")}] rows`,
    );
  }
  const copy = payload.slice().buffer as ArrayBuffer;
  const data: ElementArray = new (elementCtor(element.dtype))(copy);
  return { data, shape: [payload.byteLength / stride, ...element.innerShape] };
}

/** Every cell of one framed (uncompressed) chunk, decoded per `element`. */
export function decodeVlenNdarray(
  bytes: Uint8Array,
  element: RaggedElement,
): RaggedCell[] {
  return decodeVlenFrames(bytes).map((payload) => decodeCell(payload, element));
}

/** zstd-decode one stored chunk object (section 1.3's compressor). */
export function decodeZstd(compressed: Uint8Array): Uint8Array {
  return decompress(compressed);
}

/**
 * A stored inner chunk -- zstd frame -> vlen frames -> typed cells -- the
 * standalone decoder usable without zarrita's array layer.
 */
export function decodeRaggedChunk(
  compressed: Uint8Array,
  element: RaggedElement,
): RaggedCell[] {
  return decodeVlenNdarray(decodeZstd(compressed), element);
}
