/**
 * Store-direct leaf reads against the zagg section-7 conformance fixtures
 * (tests/data/spec): every populated cell's decoded values must match the
 * committed expectations byte-exactly (float32 / uint64, no tolerance).
 * minimal/ pins the empty inner chunk (ordinal 2, absent from the shard
 * index) and empty cells inside populated chunks; kitchen_sink/ the
 * row-aligned located siblings of both strata and the composition word;
 * flux/ the section 2.0 `weights` / `gain` declaration; column/ the
 * unsharded per-chunk geometry.
 */
import { describe, expect, it } from "vitest";

import { openLeaf } from "../../src/leaf/leaf.js";
import { FileStore } from "../helpers/fileStore.js";
import { SPEC_ROOT, expected, f32 } from "../helpers/spec.js";

describe("openLeaf on minimal/", () => {
  const store = () => new FileStore(`${SPEC_ROOT}minimal`);
  const exp = expected("minimal");

  it("resolves the cell-order group from the commit stamp", async () => {
    const leaf = await openLeaf(store(), exp.leaf);
    expect(leaf.cellOrder).toBe(exp.cell_order);
    expect(leaf.group).toBe(exp.group);
    expect(leaf.arrayPath("count")).toBe(`/${exp.leaf}/6/count`);
  });

  it("prefers an explicit cellOrder / manifest over the stamp", async () => {
    const leaf = await openLeaf(store(), exp.leaf, { cellOrder: 4 });
    expect(leaf.group).toBe("4");
  });

  it("reads the dense count and morton arrays through zarrita", async () => {
    const leaf = await openLeaf(store(), exp.leaf);
    const count = await leaf.readDense("count");
    expect(count.shape).toEqual([16]);
    const counts = Array.from(count.data as Int32Array);
    for (const cell of exp.cells) {
      expect(counts[cell.index]).toBe(cell.count);
    }
    expect(counts.filter((c) => c !== 0)).toHaveLength(exp.cells.length);
    const morton = await leaf.readDense("morton");
    expect(morton.data).toBeInstanceOf(BigUint64Array);
    for (const cell of exp.cells) {
      expect(String((morton.data as BigUint64Array)[cell.index])).toBe(
        cell.morton,
      );
    }
  });

  it("decodes every populated digest byte-exactly, empties elsewhere", async () => {
    const leaf = await openLeaf(store(), exp.leaf);
    const digests = await leaf.ragged("h_tdigest");
    expect(digests.element).toEqual({ dtype: "float32", innerShape: [2] });
    expect(digests.geometry.sharded).toBe(true);
    expect(digests.geometry.chunksPerObject).toBe(exp.chunks_per_shard);
    const cells = await digests.readCells(0, digests.length);
    expect(cells).toHaveLength(16);
    const populated = new Map(
      exp.cells.map((c) => [c.index, c.h_tdigest as number[][]]),
    );
    cells.forEach((cell, i) => {
      const rows = populated.get(i);
      if (rows === undefined) {
        expect(cell.shape).toEqual([0, 2]);
      } else {
        expect(cell.shape).toEqual([rows.length, 2]);
        expect(cell.data).toEqual(f32(rows));
      }
    });
  });

  it("treats the absent inner chunk as data (all-empty), not an error", async () => {
    const leaf = await openLeaf(store(), exp.leaf);
    const digests = await leaf.ragged("h_tdigest");
    expect(await digests.chunkBytes(exp.empty_chunk)).toBeUndefined();
    const cells = await digests.readChunk(exp.empty_chunk);
    expect(cells.map((c) => c.shape)).toEqual([
      [0, 2],
      [0, 2],
      [0, 2],
      [0, 2],
    ]);
  });

  it("reads one cell with the 2-GET recipe and caches the shard index", async () => {
    const s = store();
    const leaf = await openLeaf(s, exp.leaf);
    const digests = await leaf.ragged("h_tdigest");
    s.log.length = 0;
    const cell = await digests.readCell(15);
    expect(cell.shape).toEqual([17, 2]);
    expect(s.log.map(([, r]) => r)).toEqual([
      { suffixLength: 68 },
      { offset: 203, length: 146 },
    ]);
    await digests.readCell(0);
    expect(s.log).toHaveLength(3); // index reused, one more ranged read
  });

  it("refuses a dense array on the ragged path and vice versa", async () => {
    const leaf = await openLeaf(store(), exp.leaf);
    await expect(leaf.ragged("count")).rejects.toThrow(
      /6\/count has data type "int32"/,
    );
    await expect(leaf.ragged("nope")).rejects.toThrow(/no array 6\/nope/);
  });
});

describe("openLeaf on kitchen_sink/ (located strata + composition)", () => {
  const exp = expected("kitchen_sink");

  for (const stratum of ["signal", "noise"] as const) {
    it(`binds the ${stratum} located sibling by attrs and keeps it row-aligned`, async () => {
      const leaf = await openLeaf(
        new FileStore(`${SPEC_ROOT}kitchen_sink`),
        exp.leaf,
      );
      const payload = await leaf.ragged(`h_tdigest_${stratum}`);
      expect(payload.metadata.locations).toBe(`h_tdigest_${stratum}_locations`);
      expect(payload.metadata.weights).toBe("counts");
      expect(payload.metadata.gain).toBeNull();
      const words = await leaf.ragged(payload.metadata.locations!);
      expect(words.element).toEqual({ dtype: "uint64", innerShape: [] });
      const digests = await payload.readCells(0, 16);
      const locations = await words.readCells(0, 16);
      for (const cell of exp.cells) {
        const rows = cell[`h_tdigest_${stratum}`] as number[][];
        expect(digests[cell.index].data).toEqual(f32(rows));
        expect(locations[cell.index].shape).toEqual([rows.length]);
        expect(
          Array.from(locations[cell.index].data as BigUint64Array, String),
        ).toEqual(cell[`h_tdigest_${stratum}_locations`]);
      }
    });
  }

  it("reads the composition words densely as uint64", async () => {
    const leaf = await openLeaf(
      new FileStore(`${SPEC_ROOT}kitchen_sink`),
      exp.leaf,
    );
    const composition = await leaf.readDense("composition");
    for (const cell of exp.cells) {
      expect(String((composition.data as BigUint64Array)[cell.index])).toBe(
        cell.composition,
      );
    }
  });
});

describe("openLeaf on flux/ (the section 2.0 weights declaration)", () => {
  const exp = expected("flux");

  it("surfaces weights and gain and decodes every populated cell", async () => {
    const leaf = await openLeaf(new FileStore(`${SPEC_ROOT}flux`), exp.leaf);
    const flux = await leaf.ragged("rx_flux");
    expect(flux.metadata.weights).toBe("flux");
    expect(flux.metadata.gain).toEqual(exp.gain);
    const cells = await flux.readCells(0, flux.length);
    expect(cells).toHaveLength(16);
    const populated = new Map(
      exp.cells.map((c) => [c.index, c.rx_flux as number[][]]),
    );
    cells.forEach((cell, i) => {
      const rows = populated.get(i);
      if (rows === undefined) {
        expect(cell.shape).toEqual([0, 2]);
      } else {
        expect(cell.shape).toEqual([rows.length, 2]);
        expect(cell.data).toEqual(f32(rows));
      }
    });
  });
});

describe("openLeaf on column/ (unsharded per-chunk geometry)", () => {
  const exp = expected("column");

  it("reads the single-chunk unsharded digest array from one object", async () => {
    const s = new FileStore(`${SPEC_ROOT}column`);
    const leaf = await openLeaf(
      s,
      exp.leaf.replace("11213.zarr", "all.pyramid.zarr"),
      {
        cellOrder: 5,
      },
    );
    const digests = await leaf.ragged("h_tdigest");
    expect(digests.geometry.sharded).toBe(false);
    expect(digests.geometry.cellsPerChunk).toBe(4);
    s.log.length = 0;
    const cells = await digests.readCells(0, 4);
    expect(s.log).toEqual([[`${leaf.arrayPath("h_tdigest")}/c/0`, null]]);
    const rows = exp.column!.groups["5"].h_tdigest as number[][][];
    cells.forEach((cell, i) => expect(cell.data).toEqual(f32(rows[i])));
  });
});

describe("readDense over a span", () => {
  it("fetches only the covering inner chunk", async () => {
    const exp = expected("minimal");
    const s = new FileStore(`${SPEC_ROOT}minimal`);
    const leaf = await openLeaf(s, exp.leaf);
    await leaf.dense("count"); // metadata
    s.log.length = 0;
    const tail = await leaf.readDense("count", [12, 16]);
    expect(tail.shape).toEqual([4]);
    expect(Array.from(tail.data as Int32Array)).toEqual([0, 0, 0, 300]);
    const ranged = s.log.filter(([, r]) => r !== null);
    expect(ranged).toHaveLength(2); // index suffix + one inner chunk
  });

  it("forwards an AbortSignal to the dense half", async () => {
    const exp = expected("minimal");
    const leaf = await openLeaf(new FileStore(`${SPEC_ROOT}minimal`), exp.leaf);
    await expect(
      leaf.readDense("count", [12, 16], { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});
