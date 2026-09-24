/**
 * Decimal morton string grammar (mortie spec v1.0 sections 2 and 4).
 *
 * Grammar: ["-"] base-digit *order-digit ["p"], base-digit 1..6, order
 * digits 1..4, one per order. The sign renders the southern base cells
 * (base cells 6..11); the string length past the sign+base component IS the
 * order; a string prefix is a spatial ancestor. The terminal "p" kind
 * suffix is legal only on a full order-29 string (points exist only at
 * order 29) and is render/interchange-only -- paths never carry it. The
 * section-4 tie-break: a p-marked string yields the POINT word, an unmarked
 * order-29 string always yields the AREA word.
 */

import {
  BODY_TUPLES,
  MAX_ORDER,
  areaSuffix,
  baseCellOf,
  isPointWord,
  pointSuffix,
  wordToNested,
} from "../codec/word.js";

const DECIMAL_RE = /^(-?)([1-6])([1-4]*)(p?)$/;

const PREFIX_SHIFT = 60n;
const SUFFIX_BITS = 6n;

/** HEALPix order of a decimal id: one digit per level past the base. */
export function decimalOrder(id: string): number {
  return id.length - (id.startsWith("-") ? 2 : 1);
}

/** The {sign+base} component of a decimal id ("-5" of "-5112333"). */
export function decimalBase(id: string): string {
  return id.slice(0, id.startsWith("-") ? 2 : 1);
}

/**
 * Base-4 value of a decimal id's digit tail (digits 1..4 -> 0..3): the
 * rank convention of the coverage encodings -- ascending packed-word
 * (Z-)order within one base cell at a fixed order. Number-valued, so only
 * valid through order 24 tails (4**24 < 2**53) -- coverage endpoints live
 * at shard orders, far below that.
 */
export function decimalRank(id: string): number {
  let rank = 0;
  for (const ch of id.slice(decimalBase(id).length)) {
    rank = rank * 4 + (Number(ch) - 1);
  }
  return rank;
}

/** Inverse of decimalRank: the width-`depth` digit tail of a rank. */
export function rankTail(rank: number, depth: number): string {
  const digits: string[] = [];
  for (let i = 0; i < depth; i++) {
    digits.push(String((rank % 4) + 1));
    rank = Math.floor(rank / 4);
  }
  return digits.reverse().join("");
}

/**
 * Parse a decimal morton string to its packed word (BigInt). Enforces the
 * grammar, the order cap (29), and the p rules: "p" is legal solely on a
 * full order-29 string and selects the POINT word; an unmarked order-29
 * string parses as the AREA word (the section-4 tie-break).
 */
export function parseMortonDecimal(id: string): bigint {
  const m = DECIMAL_RE.exec(id);
  if (!m) {
    throw new Error(`malformed decimal morton id ${JSON.stringify(id)}`);
  }
  const [, sign, baseDigit, digits, mark] = m;
  const order = digits.length;
  if (order > MAX_ORDER) {
    throw new Error(`decimal morton id ${id} exceeds order ${MAX_ORDER}`);
  }
  if (mark === "p" && order !== MAX_ORDER) {
    throw new Error(
      `the "p" kind suffix is legal only at order ${MAX_ORDER} (got order ${order})`,
    );
  }
  // North bases 0..5 render 1..6; south bases 6..11 render -1..-6.
  const baseCell = sign === "-" ? Number(baseDigit) + 5 : Number(baseDigit) - 1;
  let word = BigInt(baseCell + 1) << PREFIX_SHIFT;
  const bodyOrders = Math.min(order, BODY_TUPLES);
  for (let n = 1; n <= bodyOrders; n++) {
    const stored = BigInt(digits.charCodeAt(n - 1) - 0x31); // "1".."4" -> 0..3
    word |= stored << (SUFFIX_BITS + 2n * BigInt(BODY_TUPLES - n));
  }
  const t28 = order >= 28 ? digits.charCodeAt(27) - 0x31 : 0;
  const t29 = order >= 29 ? digits.charCodeAt(28) - 0x31 : 0;
  const suffix =
    mark === "p" ? pointSuffix(t28, t29) : areaSuffix(order, t28, t29);
  return word | BigInt(suffix);
}

/**
 * Render a packed word as its decimal string (decode-through-kernel). Area
 * words render unmarked; POINT words carry the terminal "p", making the
 * decimal round-trip lossless for both kinds. Throws on the empty sentinel
 * or an invalid prefix.
 */
export function renderMortonDecimal(word: bigint): string {
  const baseCell = baseCellOf(word);
  const { order, nested } = wordToNested(word);
  const within = nested - BigInt(baseCell) * (1n << (2n * BigInt(order)));
  const southern = baseCell >= 6;
  let s =
    (southern ? "-" : "") + String(southern ? baseCell - 5 : baseCell + 1);
  for (let n = order - 1; n >= 0; n--) {
    s += String(Number((within >> (2n * BigInt(n))) & 3n) + 1);
  }
  return isPointWord(word) ? s + "p" : s;
}
