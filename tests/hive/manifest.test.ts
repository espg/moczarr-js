import { describe, expect, it } from "vitest";

import { parseHiveManifest } from "../../src/hive/manifest.js";

// Manifest wire-format keys (snake_case, per the mortie spec section 6).
const Key = {
  CELL_ORDER: "cell_order",
  SHARD_ORDER: "shard_order",
  PATH_GROUPING: "path_grouping",
  SPLIT_SCHEDULE: "split_schedule",
  SEMANTIC_HASH: "semantic_hash",
  SHORT_NAME: "short_name",
  TIME_FIELD: "time_field",
  GENERATED_AT: "generated_at",
} as const;

// Golden provenance: moczarr tests/data/serc_hive/morton_hive.json (the
// zagg-written SERC fixture manifest, post englacial/zagg#314), trimmed to
// the fields this reader models plus the fields it must carry through raw.
const SERC_MANIFEST = {
  spec: "morton-hive/1",
  dataset: { [Key.SHORT_NAME]: "ATL06", version: "007" },
  [Key.SEMANTIC_HASH]:
    "ab87989b37adbce3797f73fa1fd5d9b2a634538764e180aef05f5c6a7106870b",
  [Key.CELL_ORDER]: 8,
  [Key.SHARD_ORDER]: 6,
  [Key.SPLIT_SCHEDULE]: [1, 1, 1, 1, 1, 1],
  [Key.PATH_GROUPING]: 1,
  pyramid: { orders: [], aggregation: {} },
  [Key.GENERATED_AT]: "2026-07-21T00:53:56+00:00",
};

describe("parseHiveManifest", () => {
  it("parses the SERC fixture manifest", () => {
    const manifest = parseHiveManifest(SERC_MANIFEST);
    expect(manifest.spec).toBe("morton-hive/1");
    expect(manifest.version).toBe(1);
    expect(manifest.cellOrder).toBe(8);
    expect(manifest.shardOrder).toBe(6);
    expect(manifest.pathGrouping).toBe(1);
    expect(manifest.schedule).toBe("none");
    expect(manifest.windows).toBeNull();
    expect(manifest.raw[Key.SEMANTIC_HASH]).toBe(
      SERC_MANIFEST[Key.SEMANTIC_HASH],
    );
  });

  it("path_grouping absent reads as 1 (zagg D21 retroactive default)", () => {
    const rest: Record<string, unknown> = { ...SERC_MANIFEST };
    delete rest[Key.PATH_GROUPING];
    expect(parseHiveManifest(rest).pathGrouping).toBe(1);
  });

  it("rejects an explicit path_grouping: null (only absent defaults, moczarr)", () => {
    expect(() =>
      parseHiveManifest({ ...SERC_MANIFEST, [Key.PATH_GROUPING]: null }),
    ).toThrow(/path_grouping/);
  });

  it("accepts a grouped manifest (the path_grouping: 3 fixture case)", () => {
    const grouped = { ...SERC_MANIFEST, [Key.PATH_GROUPING]: 3 };
    expect(parseHiveManifest(grouped).pathGrouping).toBe(3);
  });

  it("rejects a non-positive or non-integer path_grouping", () => {
    for (const bad of [0, -1, 1.5, "3"]) {
      expect(() =>
        parseHiveManifest({ ...SERC_MANIFEST, [Key.PATH_GROUPING]: bad }),
      ).toThrow(/path_grouping/);
    }
  });
});

describe("parseHiveManifest temporal blocks", () => {
  it("parses a /2 manifest's temporal block", () => {
    const manifest = parseHiveManifest({
      ...SERC_MANIFEST,
      spec: "morton-hive/2",
      temporal: {
        schedule: "yearly",
        [Key.TIME_FIELD]: "delta_time",
        epoch: "2018-01-01T00:00:00Z",
      },
    });
    expect(manifest.version).toBe(2);
    expect(manifest.schedule).toBe("yearly");
    expect(manifest.windows).toBeNull();
  });

  it("carries a /2 explicit window list through", () => {
    const manifest = parseHiveManifest({
      ...SERC_MANIFEST,
      spec: "morton-hive/2",
      temporal: { schedule: "explicit", windows: ["melt-2019", "melt-2020"] },
    });
    expect(manifest.windows).toEqual(["melt-2019", "melt-2020"]);
  });

  it("requires a schedule on /2 and refuses temporal on /1", () => {
    expect(() =>
      parseHiveManifest({ ...SERC_MANIFEST, spec: "morton-hive/2" }),
    ).toThrow(/temporal block with a schedule/);
    expect(() =>
      parseHiveManifest({ ...SERC_MANIFEST, temporal: { schedule: "yearly" } }),
    ).toThrow(/must not carry a temporal block/);
  });

  it("treats an absent /3 temporal block as schedule none", () => {
    const manifest = parseHiveManifest({
      ...SERC_MANIFEST,
      spec: "morton-hive/3",
    });
    expect(manifest.version).toBe(3);
    expect(manifest.schedule).toBe("none");
  });
});

describe("parseHiveManifest validation", () => {
  it("rejects unknown specs, bad orders, and non-objects", () => {
    expect(() =>
      parseHiveManifest({ ...SERC_MANIFEST, spec: "morton-hive/4" }),
    ).toThrow(/unknown manifest spec/);
    expect(() =>
      parseHiveManifest({ ...SERC_MANIFEST, [Key.CELL_ORDER]: "8" }),
    ).toThrow(/cell_order/);
    expect(() =>
      parseHiveManifest({ ...SERC_MANIFEST, [Key.CELL_ORDER]: 5 }),
    ).toThrow(/cells nest inside shards/);
    for (const bad of [null, [], "spec", 7]) {
      expect(() => parseHiveManifest(bad)).toThrow(/not a JSON object/);
    }
  });
});
