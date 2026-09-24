/**
 * The trailing partial chunk: zarr pads an edge chunk out to the full chunk
 * shape, so the section 1.4 framing of the last chunk of a `shape [6]` /
 * `chunk_shape [4]` array carries four cells -- two on the axis, two fill
 * pads. A hand-built unsharded array (no zstd, frames written here) pins
 * that `readCells` returns the six cells the axis holds.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RaggedArray } from "../../src/leaf/ragged.js";
import { FileStore } from "../helpers/fileStore.js";

const ZARR_JSON = {
  zarr_format: 3,
  node_type: "array",
  shape: [6],
  data_type: "variable_length_bytes",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [4] } },
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
  fill_value: "",
  codecs: [{ name: "vlen-bytes", configuration: {} }],
  attributes: {
    ragged: {
      spec: "zagg-ragged/1",
      element: { dtype: "float32", shape: [-1, 2] },
    },
  },
};

/** The inverse of `decodeVlenFrames`: u32le count, per cell u32le length + payload. */
function frame(cells: number[][][]): Uint8Array {
  const payloads = cells.map(
    (rows) => new Uint8Array(Float32Array.from(rows.flat()).buffer),
  );
  const total = 4 + payloads.reduce((n, p) => n + 4 + p.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, payloads.length, true);
  let pos = 4;
  for (const payload of payloads) {
    view.setUint32(pos, payload.byteLength, true);
    pos += 4;
    out.set(payload, pos);
    pos += payload.byteLength;
  }
  return out;
}

describe("RaggedArray on a trailing partial chunk", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "moczarr-ragged-"));
    await mkdir(join(root, "c"), { recursive: true });
    await writeFile(join(root, "zarr.json"), JSON.stringify(ZARR_JSON));
    // Chunk 0: the four cells of the full chunk.
    await writeFile(
      join(root, "c", "0"),
      frame([
        [[1, 2]],
        [],
        [
          [3, 4],
          [5, 6],
        ],
        [],
      ]),
    );
    // Chunk 1: two cells on the axis, then two fill pads.
    await writeFile(join(root, "c", "1"), frame([[[7, 8]], [[9, 10]], [], []]));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("drops the pad cells the axis does not have", async () => {
    const array = await RaggedArray.open(new FileStore(root), "/");
    expect(array.geometry.sharded).toBe(false);
    expect(array.cellsPerChunk).toBe(4);
    expect(array.chunkCount).toBe(2);
    const cells = await array.readCells(0, 6);
    expect(cells).toHaveLength(6);
    expect(cells.map((c) => c.shape)).toEqual([
      [1, 2],
      [0, 2],
      [2, 2],
      [0, 2],
      [1, 2],
      [1, 2],
    ]);
    expect(Array.from(cells[5].data as Float32Array)).toEqual([9, 10]);
    expect(await array.readChunk(1)).toHaveLength(2);
  });
});
