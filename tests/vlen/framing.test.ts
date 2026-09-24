/**
 * Wire-framing parity with the Python oracle (espg/zarr-vlen-ndarray):
 * tests/data/vlen_goldens.json holds the framed chunk bytes (raw and
 * through zstd-3) the reference package writes for the golden framing case
 * (incl. the empty element), its seeded float32 (n, 2) and uint64 (n,)
 * cells, and an all-empty frame. Byte-exact decode is the contract
 * (englacial/zagg spec sections 1.4 and 6.2).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RaggedElement } from "../../src/vlen/element.js";
import {
  decodeCell,
  decodeRaggedChunk,
  decodeVlenFrames,
  decodeVlenNdarray,
  decodeZstd,
} from "../../src/vlen/framing.js";

interface GoldenCase {
  element: { dtype: string; shape: (number | null)[] };
  cells: (number | string)[][];
  shape_per_cell: number[][];
  raw_hex: string;
  zstd3_hex?: string;
}

const goldens = JSON.parse(
  readFileSync(new URL("../data/vlen_goldens.json", import.meta.url), "utf8"),
) as { cases: Record<string, GoldenCase> };

export function hex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

function elementOf(c: GoldenCase): RaggedElement {
  return {
    dtype: c.element.dtype as RaggedElement["dtype"],
    innerShape: c.element.shape.slice(1) as number[],
  };
}

function expectCells(
  decoded: ReturnType<typeof decodeVlenNdarray>,
  c: GoldenCase,
) {
  expect(decoded.map((cell) => cell.shape)).toEqual(c.shape_per_cell);
  decoded.forEach((cell, i) => {
    const values = Array.from(cell.data as ArrayLike<number | bigint>, (v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(values).toEqual(c.cells[i]);
  });
}

describe("decodeVlenFrames (spec section 1.4 framing)", () => {
  it("splits the golden frame into its three payloads, the middle one empty", () => {
    const frames = decodeVlenFrames(hex(goldens.cases.golden_framing.raw_hex));
    expect(frames.map((f) => f.byteLength)).toEqual([16, 0, 8]);
  });

  it("is loud on a truncated or over-long chunk", () => {
    const raw = hex(goldens.cases.golden_framing.raw_hex);
    expect(() => decodeVlenFrames(raw.subarray(0, 3))).toThrow(/too short/);
    expect(() => decodeVlenFrames(raw.subarray(0, 20))).toThrow(/truncated/);
    expect(() => decodeVlenFrames(raw.subarray(0, 6))).toThrow(/truncated/);
    const padded = new Uint8Array(raw.byteLength + 1);
    padded.set(raw);
    expect(() => decodeVlenFrames(padded)).toThrow(/trailing/);
  });
});

describe("decodeVlenNdarray parity with zarr-vlen-ndarray", () => {
  for (const [name, c] of Object.entries(goldens.cases)) {
    it(`decodes the ${name} raw frame to the oracle's cells`, () => {
      expectCells(decodeVlenNdarray(hex(c.raw_hex), elementOf(c)), c);
    });
    const zstd3 = c.zstd3_hex;
    if (zstd3 !== undefined) {
      it(`decodes the ${name} zstd-3 chunk identically (byte identity)`, () => {
        const compressed = hex(zstd3);
        expect(Buffer.from(decodeZstd(compressed)).toString("hex")).toBe(
          c.raw_hex,
        );
        expectCells(decodeRaggedChunk(compressed, elementOf(c)), c);
      });
    }
  }

  it("keeps float32 values bit-exact (a (2, 2) cell reads back 1,2,3,4)", () => {
    const [first] = decodeVlenNdarray(
      hex(goldens.cases.golden_framing.raw_hex),
      { dtype: "float32", innerShape: [2] },
    );
    expect(first.data).toBeInstanceOf(Float32Array);
    expect(Array.from(first.data as Float32Array)).toEqual([1, 2, 3, 4]);
  });

  it("decodes uint64 cells as BigUint64Array (words above 2**53 stay exact)", () => {
    const c = goldens.cases.uint64_flat;
    const cells = decodeVlenNdarray(hex(c.raw_hex), elementOf(c));
    expect(cells[0].data).toBeInstanceOf(BigUint64Array);
    expect(cells[0].shape).toEqual([5]);
    expect(cells[1].shape).toEqual([0]);
  });
});

describe("decodeCell", () => {
  const f32x2: RaggedElement = { dtype: "float32", innerShape: [2] };

  it("refuses a payload that is not a whole number of rows", () => {
    expect(() => decodeCell(new Uint8Array(12), f32x2)).toThrow(
      /not a whole number of 8-byte float32\[2\] rows/,
    );
  });

  it("copies to an aligned buffer so unaligned framing offsets still view", () => {
    const raw = hex(goldens.cases.golden_framing.raw_hex);
    const payload = raw.subarray(8, 24); // offset 8 is 4-aligned; force 1-off
    const shifted = new Uint8Array(payload.byteLength + 1);
    shifted.set(payload, 1);
    const cell = decodeCell(shifted.subarray(1), f32x2);
    expect(cell.data.byteOffset).toBe(0);
    expect(Array.from(cell.data as Float32Array)).toEqual([1, 2, 3, 4]);
  });

  it("decodes an empty payload as the (0, ...innerShape) cell", () => {
    const cell = decodeCell(new Uint8Array(0), f32x2);
    expect(cell.shape).toEqual([0, 2]);
    expect(cell.data.length).toBe(0);
  });
});
