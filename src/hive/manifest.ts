/**
 * morton_hive.json manifest parsing (mortie spec v1.0 section 6).
 *
 * The manifest is the reader's bootstrap: with it every shard path is
 * computable arithmetically with zero requests, so malformed content is a
 * loud error, never a degradable cache. Versions are discriminated by the
 * `spec` string only (never by sniffing names): /1 bare leaves, /2
 * time-windowed leaves (a /1 store is a /2 store with schedule none), /3
 * window-only leaf naming (the reserved `all` token names schedule none).
 */

/** Manifest object name at a store/product root. */
export const MANIFEST_NAME = "morton_hive.json";

const HIVE_SPECS = ["morton-hive/1", "morton-hive/2", "morton-hive/3"] as const;

export type HiveSpec = (typeof HIVE_SPECS)[number];

export interface HiveManifest {
  spec: HiveSpec;
  /** 1, 2 or 3 -- the numeric half of `spec`. */
  version: number;
  /** HEALPix order of the cell coordinate inside each leaf. */
  cellOrder: number;
  /** HEALPix order the shard tree splits down to. */
  shardOrder: number;
  /** Digits per path component (spec section 6.1; absent reads as 1). */
  pathGrouping: number;
  /** Window schedule ("none" when the store is unwindowed). */
  schedule: string;
  /** Explicit window labels, when the temporal block declares them. */
  windows: string[] | null;
  /** The raw manifest payload, for fields this reader does not model. */
  raw: Record<string, unknown>;
}

function asInt(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `manifest ${key} must be an integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * The `path_grouping` chunk width. An ABSENT key reads as 1 (zagg D21:
 * existing stores are retroactively 1), matching moczarr's
 * `payload.get("path_grouping", 1)`; an explicit `null` -- like anything but a
 * positive integer -- is malformed and loud, so a serializer-nulled or
 * hand-edited manifest can't read differently in the browser than in Python.
 */
function pathGroupingOf(raw: Record<string, unknown>): number {
  const value = raw["path_grouping"];
  if (value === undefined) {
    return 1;
  }
  const grouping = asInt(value, "path_grouping");
  if (grouping < 1) {
    throw new Error(`manifest path_grouping must be >= 1 (got ${grouping})`);
  }
  return grouping;
}

/** The temporal block's schedule and explicit windows, version-checked. */
function temporalOf(
  raw: Record<string, unknown>,
  version: number,
): { schedule: string; windows: string[] | null } {
  const temporal = raw["temporal"];
  if (version === 1) {
    if (temporal !== undefined && temporal !== null) {
      throw new Error(
        "a morton-hive/1 manifest must not carry a temporal block",
      );
    }
    return { schedule: "none", windows: null };
  }
  const block = (temporal ?? {}) as Record<string, unknown>;
  const schedule = block["schedule"];
  if (typeof schedule !== "string" || schedule === "") {
    // /3 separates time into the basename; an absent block is schedule none.
    if (version === 3 && (temporal === undefined || temporal === null)) {
      return { schedule: "none", windows: null };
    }
    throw new Error(
      `a morton-hive/${version} manifest requires a temporal block with a schedule`,
    );
  }
  const windows = block["windows"];
  if (windows !== undefined && !Array.isArray(windows)) {
    throw new Error("manifest temporal.windows must be a list of labels");
  }
  return { schedule, windows: (windows as string[] | undefined) ?? null };
}

/**
 * Validate a morton_hive.json payload into a typed manifest. Loud on
 * malformed input: unknown spec, missing/non-integer orders, inverted
 * orders, a bad path_grouping, or a /2 manifest without its temporal block
 * all throw.
 */
export function parseHiveManifest(payload: unknown): HiveManifest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("morton_hive.json is not a JSON object");
  }
  const raw = payload as Record<string, unknown>;
  const spec = raw["spec"];
  if (!HIVE_SPECS.includes(spec as HiveSpec)) {
    throw new Error(
      `unknown manifest spec ${JSON.stringify(spec)} (expected one of ${HIVE_SPECS.join(", ")})`,
    );
  }
  const version = Number((spec as string).split("/")[1]);
  const cellOrder = asInt(raw["cell_order"], "cell_order");
  const shardOrder = asInt(raw["shard_order"], "shard_order");
  if (cellOrder < shardOrder) {
    throw new Error(
      `manifest cell_order ${cellOrder} is above shard_order ${shardOrder} ` +
        "(cells nest inside shards)",
    );
  }
  const { schedule, windows } = temporalOf(raw, version);
  return {
    spec: spec as HiveSpec,
    version,
    cellOrder,
    shardOrder,
    pathGrouping: pathGroupingOf(raw),
    schedule,
    windows,
    raw,
  };
}
