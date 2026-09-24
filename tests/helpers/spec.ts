/** The zagg section-7 conformance fixtures (tests/data/spec, vendored). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SPEC_ROOT = fileURLToPath(
  new URL("../data/spec/", import.meta.url),
);

export interface ExpectedCell {
  index: number;
  morton: string;
  count: number;
  [field: string]: unknown;
}

export interface Expected {
  shard: string;
  leaf: string;
  group: string;
  cell_order: number;
  cells_per_chunk: number;
  chunks_per_shard: number;
  empty_chunk: number;
  cells: ExpectedCell[];
  /** The section 2.0 declaration, on the fixtures that carry one (flux/). */
  weights?: string;
  gain?: Record<string, unknown>;
  column?: { groups: Record<string, Record<string, unknown[]>> };
}

export function expected(name: string): Expected {
  return JSON.parse(
    readFileSync(`${SPEC_ROOT}${name}.expected.json`, "utf8"),
  ) as Expected;
}

/** A fixture's `(k, 2)` digest rows as the float32 bytes a decode yields. */
export function f32(rows: number[][]): Float32Array {
  return Float32Array.from(rows.flat());
}
