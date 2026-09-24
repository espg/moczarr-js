import { describe, expect, it } from "vitest";

import {
  decimalBase,
  decimalOrder,
  decimalRank,
  parseMortonDecimal,
  rankTail,
  renderMortonDecimal,
} from "../../src/hive/decimal.js";
import { isPointWord } from "../../src/codec/word.js";

// Golden provenance: the "-5112333" family of moczarr tests/conftest.py /
// tests/test_convention.py (the bitmap-encoding SERC-suite shard and its
// northern mirror). Packed words derived once with mortie 0.9.0.
const FAMILY: [string, bigint][] = [
  ["-5112333", 12711972898206646278n],
  ["5112333", 5794443870565564422n],
  ["-511", 12682136550675316738n],
  ["-5", 12682136550675316736n],
];

// Golden provenance: moczarr tests/test_ranges.py
// TestSouthernAndMultiBaseGoldens.SOUTH_WORDS -- the eight order-8 cells of
// the rank-adjacent southern shards -51111111 / -51111112, ascending.
const SOUTH_WORDS: [string, bigint][] = [
  ["-511111111", 12682136550675316744n],
  ["-511111112", 12682154142861361160n],
  ["-511111113", 12682171735047405576n],
  ["-511111114", 12682189327233449992n],
  ["-511111121", 12682206919419494408n],
  ["-511111122", 12682224511605538824n],
  ["-511111123", 12682242103791583240n],
  ["-511111124", 12682259695977627656n],
];

// Golden provenance: the cross-base shard ids of moczarr tests/test_ranges.py
// TestSouthernAndMultiBaseGoldens (SEAM_SHARDS + MULTI_SHARDS); packed words
// derived once with mortie 0.9.0. Unsigned word order sorts northern bases
// (1..6) before southern (-1..-6) -- the raw-sort Z-order property.
const CROSS_BASE: [string, bigint][] = [
  ["3444444", 4611404543450677254n],
  ["6111111", 6917529027641081862n],
  ["6444444", 8070169057271218182n],
  ["-1111111", 8070450532247928838n],
  ["-4444444", 12681855075698606086n],
];

const O29_AREA = "3" + "23142314231423142314231423142";

describe("parseMortonDecimal", () => {
  it("round-trips the -5112333 family", () => {
    for (const [id, word] of FAMILY) {
      expect(parseMortonDecimal(id)).toBe(word);
      expect(renderMortonDecimal(word)).toBe(id);
    }
  });

  it("round-trips the southern order-8 range goldens", () => {
    for (const [id, word] of SOUTH_WORDS) {
      expect(parseMortonDecimal(id)).toBe(word);
      expect(renderMortonDecimal(word)).toBe(id);
    }
  });

  it("round-trips the cross-base goldens in raw-sort order", () => {
    const words = CROSS_BASE.map(([id, word]) => {
      expect(parseMortonDecimal(id)).toBe(word);
      return word;
    });
    expect([...words].sort((a, b) => (a < b ? -1 : 1))).toEqual(words);
  });

  it("parses the SERC and order-19 fabrication goldens", () => {
    // moczarr tests/test_fabricate.py GOLDEN_WORD / GOLDEN_WORD_O19_SOUTH.
    expect(parseMortonDecimal("433142211")).toBe(5347180132572332040n);
    expect(parseMortonDecimal("-41132132113423444234")).toBe(
      11570383905173274643n,
    );
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "-", "7", "05", "4331520", "433142x", "5112333 "]) {
      expect(() => parseMortonDecimal(bad)).toThrow(/malformed/);
    }
    expect(() => parseMortonDecimal("1" + "1".repeat(30))).toThrow(/order 29/);
  });
});

describe("order-29 kind marking (spec section 4)", () => {
  it("unmarked order-29 strings parse AREA (the tie-break)", () => {
    const word = parseMortonDecimal(O29_AREA);
    expect(word).toBe(3906369333256140333n);
    expect(isPointWord(word)).toBe(false);
    expect(renderMortonDecimal(word)).toBe(O29_AREA);
  });

  it("p-marked order-29 strings parse POINT and render back marked", () => {
    const word = parseMortonDecimal(O29_AREA + "p");
    expect(word).toBe(3906369333256140349n); // spec band arithmetic golden
    expect(isPointWord(word)).toBe(true);
    expect(renderMortonDecimal(word)).toBe(O29_AREA + "p");
  });

  it("p below order 29 is illegal (points exist only at order 29)", () => {
    expect(() => parseMortonDecimal("-5112333p")).toThrow(/order 29/);
    expect(() => parseMortonDecimal("3p")).toThrow(/order 29/);
  });
});

describe("decimal helpers", () => {
  it("computes order and base component", () => {
    expect(decimalOrder("-5112333")).toBe(6);
    expect(decimalOrder("433142211")).toBe(8);
    expect(decimalOrder("-5")).toBe(0);
    expect(decimalBase("-5112333")).toBe("-5");
    expect(decimalBase("433142211")).toBe("4");
  });

  it("ranks digit tails in base 4 and inverts via rankTail", () => {
    expect(decimalRank("4331422")).toBe(
      2 * 4 ** 5 + 2 * 4 ** 4 + 0 * 4 ** 3 + 3 * 4 ** 2 + 1 * 4 + 1,
    );
    expect(decimalRank("-5")).toBe(0);
    for (const [id] of SOUTH_WORDS) {
      const tail = id.slice(2);
      expect(rankTail(decimalRank(id), tail.length)).toBe(tail);
    }
  });
});
