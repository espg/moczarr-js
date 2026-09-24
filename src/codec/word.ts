/**
 * INTERNAL -- not part of the public API. Packed-word codec ported from the
 * espg/gridlook fork (src/lib/morton/word.ts) so the decimal grammar and
 * coverage arithmetic can round-trip words; slated for replacement by
 * healpix-geo's `morton` scheme (GRID4EARTH/healpix-geo#299) once released.
 * Do not expand it: cell ids and geometry are healpix-geo's job.
 */

/**
 * Packed 64-bit morton word codec (mortie spec v1.0 section 1, BigInt).
 *
 * Layout (MSB -> LSB): [4-bit prefix][54-bit body (27 x 2-bit)][6-bit suffix].
 * The prefix stores the HEALPix base cell as base_id + 1 (0 is the empty
 * sentinel, 13..15 invalid); the body holds one stored 0..3 tuple per order
 * 1..27 (order 1 highest); the suffix is a preorder numbering of the path
 * tail past tuple 27 -- 0..27 area (order == suffix), 28..47 order-28/29
 * area (r = t28*5 + (t29 present ? t29 + 1 : 0)), 48..63 order-29 point
 * (r2 = t28*4 + t29). Kind is carried by the suffix range alone (spec
 * section 4) -- never by metadata. Words exceed 2**53, so everything here is
 * BigInt; only NESTED ids at order <= 24 are handed out as Numbers.
 */

/** Highest HEALPix order the packed word encodes. */
export const MAX_ORDER = 29;
/** Number of two-bit body tuples (orders 1..27). */
export const BODY_TUPLES = 27;
/**
 * Highest order whose NESTED ids stay below 2**53 (12 * 4**24 < 2**53) and
 * are therefore exact as JS Numbers -- the viewer-side cast bound of spec
 * section 4.
 */
export const FLOAT64_EXACT_MAX_ORDER = 24;

const PREFIX_SHIFT = 60n;
const SUFFIX_BITS = 6n;
const SUFFIX_MASK = 63n;
/** First suffix value of the order-28/29 area preorder region. */
const AREA_TAIL_BASE = 28;
/** First suffix value of the order-29 point region. */
const POINT_BASE = 28 + 20;

/** The 6-bit suffix as a plain number (0..63). */
function suffixOf(word: bigint): number {
  return Number(word & SUFFIX_MASK);
}

/**
 * HEALPix base cell (0..11) from the prefix. Throws on the empty sentinel
 * (prefix 0) and invalid prefixes (13..15) -- a corrupt word must not
 * silently place data.
 */
export function baseCellOf(word: bigint): number {
  const prefix = Number((word >> PREFIX_SHIFT) & 0xfn);
  if (prefix < 1 || prefix > 12) {
    throw new RangeError(
      `invalid morton word ${word}: base-cell prefix ${prefix} (valid 1..12)`,
    );
  }
  return prefix - 1;
}

/**
 * HEALPix order (0..29) carried by the suffix. Total over all 64 suffix
 * values: 0..27 is the order itself; in 28..47 a 5-block parent (r % 5 == 0)
 * is order 28, its children order 29; 48..63 is the order-29 point region.
 */
export function orderOf(word: bigint): number {
  const suffix = suffixOf(word);
  if (suffix <= BODY_TUPLES) {
    return suffix;
  }
  if (suffix < POINT_BASE) {
    return (suffix - AREA_TAIL_BASE) % 5 === 0 ? 28 : 29;
  }
  return MAX_ORDER;
}

/**
 * Kind predicate (spec section 4): suffix 48..63 is an order-29 point (no
 * area claim); everything below is an area cell at its encoded order.
 */
export function isPointWord(word: bigint): boolean {
  return suffixOf(word) >= POINT_BASE;
}

/**
 * Stored 0..3 tuples for orders 28/29 out of a tail suffix (28..63):
 * [t28, t29 | null]. Suffixes 0..27 carry no tail (caller handles).
 */
function decodeTail(suffix: number): [number, number | null] {
  if (suffix >= POINT_BASE) {
    const r2 = suffix - POINT_BASE;
    return [r2 >> 2, r2 & 3];
  }
  const r = suffix - AREA_TAIL_BASE;
  const pos = r % 5;
  return [Math.floor(r / 5), pos === 0 ? null : pos - 1];
}

/** The area suffix for order k with stored tail tuples (spec section 1). */
export function areaSuffix(order: number, t28: number, t29: number): number {
  if (order <= BODY_TUPLES) {
    return order;
  }
  if (order === 28) {
    return AREA_TAIL_BASE + t28 * 5;
  }
  return AREA_TAIL_BASE + t28 * 5 + t29 + 1;
}

/** The point suffix for stored order-28/29 tuples (spec section 1). */
export function pointSuffix(t28: number, t29: number): number {
  return POINT_BASE + t28 * 4 + t29;
}

/**
 * Clip (coarsen) a word to order k -- mortie's clip2order: keep the base
 * cell and the first k tuples, zero-fill below, rewrite the suffix. Returns
 * the word unchanged when k >= its native order (a point stays a point);
 * any real clip yields an area word (spec section 4: membership in a
 * coarser cell is a transient truncation).
 */
export function clipToOrder(word: bigint, k: number): bigint {
  baseCellOf(word); // reject empty/invalid prefixes
  if (!Number.isInteger(k) || k < 0 || k > MAX_ORDER) {
    throw new RangeError(`clip order ${k} outside 0..${MAX_ORDER}`);
  }
  const native = orderOf(word);
  if (k >= native) {
    return word;
  }
  const prefix = word & (0xfn << PREFIX_SHIFT);
  const keptBody = BigInt(Math.min(k, BODY_TUPLES));
  const keepBits = 2n * keptBody;
  const bodyMask =
    keptBody === 0n
      ? 0n
      : (((1n << keepBits) - 1n) << (54n - keepBits)) << SUFFIX_BITS;
  // k == 28 keeps the order-28 tuple out of the source tail (native is 29
  // here); every lower target uses the variable-length form.
  const suffix =
    k === 28
      ? areaSuffix(28, decodeTail(suffixOf(word))[0], 0)
      : areaSuffix(k, 0, 0);
  return prefix | (word & bodyMask) | BigInt(suffix);
}

/**
 * Morton -> HEALPix NESTED conversion (body-bit arithmetic, exact at every
 * order): nested = base * 4**order + within, where within packs the stored
 * tuples with order 1 in the most significant pair. Points convert like
 * area cells (the bare NESTED id does not carry kind).
 */
export function wordToNested(word: bigint): { order: number; nested: bigint } {
  const base = BigInt(baseCellOf(word));
  const order = orderOf(word);
  const bodyOrders = Math.min(order, BODY_TUPLES);
  let within = 0n;
  for (let n = 1; n <= bodyOrders; n++) {
    const pair = (word >> (SUFFIX_BITS + 2n * BigInt(BODY_TUPLES - n))) & 3n;
    within |= pair << (2n * BigInt(order - n));
  }
  if (order >= 28) {
    const [t28, t29] = decodeTail(suffixOf(word));
    within |= BigInt(t28) << (2n * BigInt(order - 28));
    if (t29 !== null) {
      within |= BigInt(t29);
    }
  }
  return { order, nested: base * (1n << (2n * BigInt(order))) + within };
}

/**
 * The viewer-side NESTED cast (spec section 4, "viewer-side float64
 * casts"): POINT-kind words clip 29 -> 24 first (Number-safe by
 * construction); AREA words never clip -- coarsening an area cell changes
 * the labelled thing -- so an area word above order 24 throws (that data
 * takes the proxy/virtual-store path, issue #1 phase 6d).
 */
export function viewNestedId(word: bigint): { order: number; cellId: number } {
  const cast = isPointWord(word)
    ? clipToOrder(word, FLOAT64_EXACT_MAX_ORDER)
    : word;
  const { order, nested } = wordToNested(cast);
  if (order > FLOAT64_EXACT_MAX_ORDER) {
    throw new RangeError(
      `area cell at order ${order}: NESTED ids above order ` +
        `${FLOAT64_EXACT_MAX_ORDER} exceed 2**53 and are unsafe as Numbers; ` +
        `render finer-than-24 area data through the hive virtual store instead`,
    );
  }
  return { order, cellId: Number(nested) };
}
