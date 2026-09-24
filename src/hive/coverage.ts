/**
 * Root coverage-MOC parsing (mortie spec v1.0 section 7.3): the `ranges`
 * envelope a store/product root's coverage.moc declares -- inclusive
 * [first, last] runs of same-order shard cells within one base cell,
 * consecutive in base-4 digit-tail rank, endpoints as decimal STRINGS
 * (packed words exceed 2**53; JSON numbers would be float-mangled).
 *
 * Readers are MOC-first, always: the manifest plus this envelope yield
 * every leaf path arithmetically, and recursive enumeration is
 * out-of-contract for the viewer (issue #1 phase-6 amendment) -- there is
 * deliberately no LIST fallback here. The leaf bitmap tier (zstd) stays
 * server-side; the browser consumes the box/ranges tiers only.
 *
 * Posture split, mirroring moczarr's parse_root_coverage vs ranges_words
 * exactly: the tolerant (-> null) bucket gates on `spec` + `encoding` ONLY --
 * a missing/unknown envelope is a regenerable-cache miss, so the caller reports
 * no-coverage. Everything structural (the `order` shape, the `ranges` shape,
 * endpoint validity) is LOUD: a well-formed envelope carrying a corrupt body
 * must never silently read empty, because there is no LIST fallback to recover
 * the true coverage. A numeric-string `order` (e.g. "6") reads like a JSON
 * number, as moczarr's ranges_words does.
 */

import { decimalBase, decimalOrder, decimalRank, rankTail } from "./decimal.js";
import { leafPath } from "./hive.js";
import type { HiveManifest } from "./manifest.js";

/** Convention version of coverage envelopes. */
export const COVERAGE_SPEC = "morton-moc/1";
/** Root coverage object name at a store/product root. */
export const ROOT_COVERAGE_NAME = "coverage.moc";

export interface RootCoverage {
  spec: string;
  encoding: "ranges";
  /** Common HEALPix order of every range endpoint. */
  order: number;
  /** Inclusive [first, last] decimal-string runs. */
  ranges: [string, string][];
}

/**
 * The envelope's common order as an integer. Mirrors moczarr's ranges_words,
 * which reads a numeric-string `order` (e.g. "6") as readily as a JSON number;
 * a missing, non-numeric, or non-integer order is malformed and loud -- a
 * corrupt order inside a well-formed envelope must never silently drop
 * coverage.
 */
function coverageOrder(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(
    `coverage order must be an integer (got ${JSON.stringify(value)})`,
  );
}

/**
 * A usable store-root coverage envelope, or null. Tolerant ONLY at the
 * envelope gate (moczarr parse_root_coverage): a non-object payload, an
 * unknown `spec`, or a non-"ranges" `encoding` reads as absent -- the root MOC
 * is a regenerable cache. A well-formed envelope with a malformed `order` or a
 * non-list `ranges` is LOUD (moczarr ranges_words): a corrupt body must never
 * read as no-coverage. Per-range structural and endpoint checks stay loud at
 * expansion (checkRange).
 */
export function parseRootCoverage(payload: unknown): RootCoverage | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  if (raw["spec"] !== COVERAGE_SPEC || raw["encoding"] !== "ranges") {
    return null;
  }
  const order = coverageOrder(raw["order"]);
  const ranges = raw["ranges"];
  if (!Array.isArray(ranges)) {
    throw new Error(
      `coverage ranges must be a list of [first, last] pairs ` +
        `(got ${JSON.stringify(ranges)})`,
    );
  }
  return {
    spec: COVERAGE_SPEC,
    encoding: "ranges",
    order,
    ranges: ranges as [string, string][],
  };
}

/** Validated (base, loRank, hiRank) of one range; throws when malformed. */
function checkRange(range: unknown, order: number): [string, number, number] {
  if (!Array.isArray(range) || range.length !== 2) {
    // A mangled cache must be loud, never a plausible partial answer.
    throw new Error(
      `coverage range must be a [first, last] pair (got ${JSON.stringify(range)})`,
    );
  }
  const [lo, hi] = range;
  if (typeof lo !== "string" || typeof hi !== "string") {
    // Spec section 7.3: endpoints are decimal strings, never JSON numbers.
    throw new Error(
      `coverage range endpoints must be decimal strings ` +
        `(got [${JSON.stringify(lo)}, ${JSON.stringify(hi)}])`,
    );
  }
  const base = decimalBase(lo);
  const loRank = decimalRank(lo);
  const hiRank = decimalRank(hi);
  const ok =
    decimalBase(hi) === base &&
    loRank <= hiRank &&
    decimalOrder(lo) === order &&
    decimalOrder(hi) === order;
  if (!ok) {
    throw new Error(
      `malformed coverage range [${lo}, ${hi}] at order ${order}`,
    );
  }
  return [base, loRank, hiRank];
}

/**
 * The covered shard ids, expanded exactly from the envelope's ranges --
 * ascending within each range by construction (consecutive digit-tail
 * rank). O(covered shards); containment checks should use rangesContain.
 */
export function rangesShardIds(envelope: RootCoverage): string[] {
  const ids: string[] = [];
  for (const range of envelope.ranges) {
    const [base, loRank, hiRank] = checkRange(range, envelope.order);
    for (let r = loRank; r <= hiRank; r++) {
      ids.push(base + rankTail(r, envelope.order));
    }
  }
  return [...new Set(ids)];
}

/** Whether the envelope's ranges list one shard id -- O(ranges). */
export function rangesContain(
  envelope: RootCoverage,
  shardId: string,
): boolean {
  if (decimalOrder(shardId) !== envelope.order) {
    return false;
  }
  const base = decimalBase(shardId);
  const rank = decimalRank(shardId);
  return envelope.ranges.some((range) => {
    const [rangeBase, loRank, hiRank] = checkRange(range, envelope.order);
    return rangeBase === base && loRank <= rank && rank <= hiRank;
  });
}

/**
 * The store-relative leaf path of every covered shard -- the MOC-first
 * arithmetic enumeration (manifest + root MOC, zero LISTs) the phase-6c
 * data path consumes. `window` selects the windowed leaf under /2 and /3
 * manifests.
 */
export function coveredLeafPaths(
  manifest: HiveManifest,
  envelope: RootCoverage,
  window?: string | null,
): string[] {
  return rangesShardIds(envelope).map((id) => leafPath(manifest, id, window));
}
