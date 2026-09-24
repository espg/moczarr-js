import { describe, expect, it } from "vitest";

import {
  MAX_COVERAGE_IDS,
  coveredLeafPaths,
  parseRootCoverage,
  rangesContain,
  rangesShardIds,
} from "../../src/hive/coverage.js";
import { parseHiveManifest } from "../../src/hive/manifest.js";

// Wire-format keys (snake_case, per the mortie spec sections 6 and 7).
const Key = {
  CELL_ORDER: "cell_order",
  SHARD_ORDER: "shard_order",
  PATH_GROUPING: "path_grouping",
  GENERATED_AT: "generated_at",
} as const;

// Golden provenance: moczarr tests/data/serc_hive/coverage.moc -- the
// zagg-written root ranges MOC of the SERC fixture (shard order 6).
const SERC_COVERAGE = {
  spec: "morton-moc/1",
  encoding: "ranges",
  order: 6,
  source: "dispatcher",
  [Key.GENERATED_AT]: "2026-07-21T00:53:56+00:00",
  ranges: [
    ["4331244", "4331244"],
    ["4331421", "4331422"],
    ["4331424", "4331424"],
    ["4332133", "4332133"],
    ["4332311", "4332311"],
  ],
};

const SERC_SHARDS = [
  "4331244",
  "4331421",
  "4331422",
  "4331424",
  "4332133",
  "4332311",
];

function envelope(overrides: Record<string, unknown> = {}) {
  const parsed = parseRootCoverage({ ...SERC_COVERAGE, ...overrides });
  if (parsed === null) {
    throw new Error("fixture envelope must parse");
  }
  return parsed;
}

describe("parseRootCoverage", () => {
  it("parses the SERC fixture envelope", () => {
    const parsed = envelope();
    expect(parsed.order).toBe(6);
    expect(parsed.ranges).toHaveLength(5);
  });

  it("gates the tolerant-null bucket on spec/encoding only (moczarr)", () => {
    // Envelope-level miss reads as no-coverage (regenerable cache).
    expect(parseRootCoverage(null)).toBeNull();
    expect(parseRootCoverage([])).toBeNull();
    expect(parseRootCoverage("moc")).toBeNull();
    expect(
      parseRootCoverage({ ...SERC_COVERAGE, spec: "morton-moc/2" }),
    ).toBeNull();
    expect(
      parseRootCoverage({ ...SERC_COVERAGE, encoding: "bitmap" }),
    ).toBeNull();
  });

  it("reads a numeric-string order like moczarr's ranges_words", () => {
    const parsed = parseRootCoverage({ ...SERC_COVERAGE, order: "6" });
    expect(parsed?.order).toBe(6);
    expect(rangesShardIds(parsed!)).toEqual(SERC_SHARDS);
  });

  it("is loud on a structurally-corrupt body (never silent-empty)", () => {
    // A well-formed envelope with a mangled order/ranges must throw, not
    // read as no-coverage -- there is no LIST fallback to recover coverage.
    expect(() => parseRootCoverage({ ...SERC_COVERAGE, order: "six" })).toThrow(
      /coverage order/,
    );
    expect(() =>
      parseRootCoverage({ ...SERC_COVERAGE, order: undefined }),
    ).toThrow(/coverage order/);
    expect(() =>
      parseRootCoverage({ ...SERC_COVERAGE, ranges: undefined }),
    ).toThrow(/coverage ranges must be a list/);
    expect(() =>
      parseRootCoverage({ ...SERC_COVERAGE, ranges: "4331244" }),
    ).toThrow(/coverage ranges must be a list/);
  });
});

describe("rangesShardIds", () => {
  it("expands the SERC envelope to its covered shards", () => {
    expect(rangesShardIds(envelope())).toEqual(SERC_SHARDS);
  });

  it("expands a multi-cell run in ascending digit-tail rank", () => {
    const ids = rangesShardIds(envelope({ ranges: [["4331421", "4331424"]] }));
    expect(ids).toEqual(["4331421", "4331422", "4331423", "4331424"]);
  });

  it("throws on malformed ranges (corrupt cache, never a partial answer)", () => {
    const cases: [string, string][][] = [
      [["4331423", "4331422"]], // reversed
      [["4331422", "-4331423"]], // base-crossing
      [["4331422", "43314231"]], // order mismatch
    ];
    for (const ranges of cases) {
      expect(() => rangesShardIds(envelope({ ranges }))).toThrow(
        /malformed coverage range/,
      );
    }
    // Spec 7.3: endpoints are strings, never JSON numbers (2**53 mangling).
    expect(() =>
      rangesShardIds(envelope({ ranges: [[4331422, 4331423]] })),
    ).toThrow(/decimal strings/);
    // A non-array / wrong-arity range entry is loud, not a silent skip.
    expect(() =>
      rangesShardIds(
        envelope({ ranges: ["4331422"] as unknown as [string, string][] }),
      ),
    ).toThrow(/\[first, last\] pair/);
    expect(() =>
      rangesShardIds(
        envelope({ ranges: [["4331422"]] as unknown as [string, string][] }),
      ),
    ).toThrow(/\[first, last\] pair/);
  });

  it("refuses an over-wide envelope instead of hanging the tab", () => {
    // One full base cell at order 12: 4**12 = 16,777,216 ids (~1.4 GB of
    // strings). The width is summed before anything is allocated, so this
    // throws in microseconds rather than OOMing.
    const huge = envelope({
      order: 12,
      ranges: [["4111111111111", "4444444444444"]],
    });
    expect(() => rangesShardIds(huge)).toThrow(
      /coverage expands to 16777216 shard ids \(limit 1048576\)/,
    );
    expect(() => rangesShardIds(huge)).toThrow(/rangesContain/);
    // The ceiling is a parameter, and it sums widths across ranges.
    expect(() => rangesShardIds(envelope(), 5)).toThrow(
      /coverage expands to 6 shard ids \(limit 5\)/,
    );
    expect(rangesShardIds(envelope(), 6)).toEqual(SERC_SHARDS);
    expect(rangesShardIds(envelope())).toEqual(SERC_SHARDS);
    expect(MAX_COVERAGE_IDS).toBe(1024 * 1024);
  });
});

describe("rangesContain", () => {
  it("answers membership without expansion", () => {
    for (const id of SERC_SHARDS) {
      expect(rangesContain(envelope(), id)).toBe(true);
    }
    expect(rangesContain(envelope(), "4331423")).toBe(false);
    expect(rangesContain(envelope(), "-4331422")).toBe(false);
  });

  it("a wrong-order id is never contained", () => {
    expect(rangesContain(envelope(), "43314221")).toBe(false);
    expect(rangesContain(envelope(), "433142")).toBe(false);
  });

  it("throws on a non-id instead of reporting a silent miss", () => {
    // A typo'd id used to read as "not covered", indistinguishable from a
    // genuine miss -- and per coveredLeafPaths that is a leaf never fetched.
    expect(() => rangesContain(envelope(), "4331a22")).toThrow(
      /malformed decimal morton id/,
    );
    expect(() => rangesContain(envelope(), "")).toThrow(
      /malformed decimal morton id/,
    );
  });
});

describe("coveredLeafPaths (MOC-first arithmetic enumeration)", () => {
  const manifest = parseHiveManifest({
    spec: "morton-hive/1",
    [Key.CELL_ORDER]: 8,
    [Key.SHARD_ORDER]: 6,
    [Key.PATH_GROUPING]: 1,
  });

  it("computes the SERC fixture's leaf paths with zero requests", () => {
    // Golden provenance: the on-disk tree of moczarr tests/data/serc_hive.
    expect(coveredLeafPaths(manifest, envelope())).toEqual([
      "4/3/3/1/2/4/4/4331244.zarr",
      "4/3/3/1/4/2/1/4331421.zarr",
      "4/3/3/1/4/2/2/4331422.zarr",
      "4/3/3/1/4/2/4/4331424.zarr",
      "4/3/3/2/1/3/3/4332133.zarr",
      "4/3/3/2/3/1/1/4332311.zarr",
    ]);
  });

  it("threads path_grouping and windows through", () => {
    const grouped = parseHiveManifest({
      spec: "morton-hive/2",
      [Key.CELL_ORDER]: 8,
      [Key.SHARD_ORDER]: 6,
      [Key.PATH_GROUPING]: 3,
      temporal: { schedule: "yearly" },
    });
    expect(
      coveredLeafPaths(
        grouped,
        envelope({ ranges: [["4331422", "4331422"]] }),
        "2019",
      ),
    ).toEqual(["4/331/422/4331422_2019.zarr"]);
  });

  it("inherits the expansion ceiling", () => {
    expect(() => coveredLeafPaths(manifest, envelope(), null, 5)).toThrow(
      /coverage expands to 6 shard ids \(limit 5\)/,
    );
    expect(coveredLeafPaths(manifest, envelope(), null, 6)).toHaveLength(6);
  });
});
