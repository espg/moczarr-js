import { describe, expect, it } from "vitest";

import {
  classifyStoreRoot,
  hiveComponents,
  isProductName,
  leafPath,
  shardIdFromPath,
  splitLeafName,
} from "../../src/hive/hive.js";
import { parseHiveManifest } from "../../src/hive/manifest.js";

// Manifest wire-format keys (snake_case, per the mortie spec section 6).
const Key = {
  CELL_ORDER: "cell_order",
  SHARD_ORDER: "shard_order",
  PATH_GROUPING: "path_grouping",
} as const;

function manifest(overrides: Record<string, unknown> = {}) {
  return parseHiveManifest({
    spec: "morton-hive/1",
    [Key.CELL_ORDER]: 8,
    [Key.SHARD_ORDER]: 6,
    [Key.PATH_GROUPING]: 1,
    ...overrides,
  });
}

const V2 = {
  spec: "morton-hive/2",
  temporal: { schedule: "yearly" },
};

describe("leafPath (path_grouping as the only construction path)", () => {
  it("matches the moczarr leaf-path goldens at path_grouping 1", () => {
    // Golden provenance: moczarr tests/test_convention.py
    // TestLeafPath::test_south_and_north (the "-5112333" family).
    expect(leafPath(manifest(), "-5112333")).toBe(
      "-5/1/1/2/3/3/3/-5112333.zarr",
    );
    expect(leafPath(manifest(), "5112333")).toBe("5/1/1/2/3/3/3/5112333.zarr");
  });

  it("matches the SERC fixture tree layout", () => {
    // Golden provenance: moczarr tests/data/serc_hive (zagg-written).
    expect(leafPath(manifest(), "4331422")).toBe("4/3/3/1/4/2/2/4331422.zarr");
  });

  it("chunks per path_grouping: 3, last component carrying the remainder", () => {
    const grouped = manifest({ [Key.PATH_GROUPING]: 3 });
    expect(leafPath(grouped, "-5112333")).toBe("-5/112/333/-5112333.zarr");
    expect(leafPath(grouped, "43314224")).toBe("4/331/422/4/43314224.zarr");
    expect(hiveComponents("43314224", 3)).toEqual(["4", "331", "422", "4"]);
  });

  it("keeps component boundaries as shared ancestor prefixes", () => {
    // A deeper shard's leading components equal its ancestor's components.
    const parent = hiveComponents("4331422", 3);
    const child = hiveComponents("433142211", 3);
    expect(child.slice(0, 2)).toEqual(parent.slice(0, 2));
  });

  it("names /2 windowed leaves and /3 window-only leaves", () => {
    // Golden provenance: moczarr tests/test_convention.py leaf_name/2019.
    expect(leafPath(manifest(V2), "-5112333", "2019")).toBe(
      "-5/1/1/2/3/3/3/-5112333_2019.zarr",
    );
    const v3 = manifest({ spec: "morton-hive/3" });
    expect(leafPath(v3, "-5112333", "2019")).toBe("-5/1/1/2/3/3/3/2019.zarr");
    expect(leafPath(v3, "-5112333")).toBe("-5/1/1/2/3/3/3/all.zarr");
  });

  it("rejects marked, malformed, or negative-int-shaped ids", () => {
    for (const bad of ["-5112333p", "7112333", "-51123335", ""]) {
      expect(() => leafPath(manifest(), bad)).toThrow(/malformed shard id/);
    }
    expect(() => leafPath(manifest(V2), "-5112333", "20_19")).toThrow(/frozen/);
  });
});

describe("splitLeafName (first-underscore split)", () => {
  it("matches the moczarr split goldens", () => {
    // Golden provenance: moczarr tests/test_convention.py TestLeafNames.
    expect(splitLeafName("-5112333.zarr")).toEqual({
      fullId: "-5112333",
      window: null,
    });
    expect(splitLeafName("-5112333_2019.zarr")).toEqual({
      fullId: "-5112333",
      window: "2019",
    });
  });

  it("rejects non-zarr names and malformed labels", () => {
    expect(() => splitLeafName("-5112333")).toThrow(/not a leaf zarr name/);
    expect(() => splitLeafName("-5112333_20_19.zarr")).toThrow(/frozen/);
  });
});

describe("shardIdFromPath", () => {
  it("recovers ids across groupings and versions", () => {
    expect(shardIdFromPath("-5/1/1/2/3/3/3/-5112333.zarr")).toBe("-5112333");
    expect(shardIdFromPath("-5/112/333/2019.zarr")).toBe("-5112333");
    expect(shardIdFromPath("4/331/422/4/all.zarr")).toBe("43314224");
  });

  it("rejects paths violating the node invariant", () => {
    for (const bad of [
      "-5112333.zarr",
      "x/1/leaf.zarr",
      "-5/15/x.zarr",
      "-5/1/leaf",
    ]) {
      expect(() => shardIdFromPath(bad)).toThrow(
        /node invariant|not a hive leaf path/,
      );
    }
  });
});

describe("classifyStoreRoot (D19 product discovery)", () => {
  it("a root manifest means a bare store", () => {
    expect(
      classifyStoreRoot(["morton_hive.json", "coverage.moc"], ["4"]),
    ).toEqual({ kind: "store" });
  });

  it("name-shaped children are the product entries, sorted", () => {
    expect(
      classifyStoreRoot(
        ["coverage.moc"],
        ["atl06_q50/", "atl03_counts/", "-5/", "README", "4/"],
      ),
    ).toEqual({ kind: "products", products: ["atl03_counts", "atl06_q50"] });
  });

  it("neither form is not a morton-hive root", () => {
    expect(() => classifyStoreRoot([], ["-5/", "4/"])).toThrow(
      /not a morton-hive root/,
    );
  });

  it("excludes base components and enforces the grammar", () => {
    expect(isProductName("atl06_q50")).toBe(true);
    expect(isProductName("a".repeat(192))).toBe(true);
    for (const bad of ["-5", "4", "Upper", "dots.", "a".repeat(193), ""]) {
      expect(isProductName(bad)).toBe(false);
    }
  });
});
