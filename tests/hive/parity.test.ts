/**
 * Cross-implementation parity: the frozen gridlook fixtures
 * (tests/data/shim_parity_*.json, generated against moczarr's
 * fabricate_cell_ids over the SERC shard and the golden order-29 point
 * words) pin that the packed-word decode reproduces the NESTED cell ids
 * and refinement level the Python reader served, word for word.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isPointWord, viewNestedId } from "../../src/codec/word.js";
import { renderMortonDecimal } from "../../src/hive/decimal.js";
import { parseHiveManifest } from "../../src/hive/manifest.js";
import { leafPath } from "../../src/hive/hive.js";

interface Parity {
  morton_words: string[];
  shim_cell_ids: number[];
  shim_refinement_level?: number;
  manifest_refinement_level?: number;
  shim_dggs?: { refinement_level: number };
  shard?: string;
}

function fixture(name: string): Parity {
  return JSON.parse(
    readFileSync(new URL(`../data/${name}.json`, import.meta.url), "utf8"),
  ) as Parity;
}

describe("word decode parity with moczarr (frozen gridlook fixtures)", () => {
  it("reproduces the SERC shard's NESTED ids and level", () => {
    const serc = fixture("shim_parity_serc");
    const decoded = serc.morton_words.map((w) => viewNestedId(BigInt(w)));
    expect(decoded.map((d) => d.cellId)).toEqual(serc.shim_cell_ids);
    expect(new Set(decoded.map((d) => d.order))).toEqual(
      new Set([serc.shim_dggs!.refinement_level]),
    );
    // Every cell sits in the fixture's shard (the decimal prefix invariant).
    for (const w of serc.morton_words) {
      expect(renderMortonDecimal(BigInt(w)).startsWith(serc.shard!)).toBe(true);
    }
  });

  it("reproduces the point-store clip (order 29 words serve at 24)", () => {
    const points = fixture("shim_parity_points");
    const decoded = points.morton_words.map((w) => viewNestedId(BigInt(w)));
    expect(decoded.map((d) => d.cellId)).toEqual(points.shim_cell_ids);
    for (const d of decoded) {
      expect(d.order).toBe(points.shim_refinement_level);
      expect(d.order).not.toBe(points.manifest_refinement_level);
    }
    expect(points.morton_words.every((w) => isPointWord(BigInt(w)))).toBe(true);
  });

  it("computes the SERC fixture leaf path from the manifest alone", () => {
    const serc = fixture("shim_parity_serc");
    const manifest = parseHiveManifest({
      spec: "morton-hive/1",
      cell_order: 8,
      shard_order: 6,
      path_grouping: 1,
    });
    expect(leafPath(manifest, serc.shard!)).toBe("4/3/3/1/4/2/2/4331422.zarr");
  });
});
