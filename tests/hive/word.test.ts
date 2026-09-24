import { describe, expect, it } from "vitest";

import {
  parseMortonDecimal,
  renderMortonDecimal,
} from "../../src/hive/decimal.js";
import {
  FLOAT64_EXACT_MAX_ORDER,
  baseCellOf,
  clipToOrder,
  isPointWord,
  orderOf,
  viewNestedId,
  wordToNested,
} from "../../src/codec/word.js";

// Golden provenance: moczarr tests/test_fabricate.py GOLDEN_WORD /
// GOLDEN_NESTED -- the first cell of the SERC fixture's shard 4331422
// (decimal "433142211", order 8) and its stored NESTED id.
const SERC_WORD = 5347180132572332040n;
const SERC_NESTED = 238416;

// Golden provenance: moczarr tests/test_fabricate.py GOLDEN_WORD_O19_SOUTH /
// GOLDEN_NESTED_O19_SOUTH -- production order (19), southern hemisphere,
// negative polar base (lat ~ -80). Decimal derived once with mortie 0.9.0.
const SOUTH_O19_WORD = 11570383905173274643n;
const SOUTH_O19_NESTED = 2483716583387n;
const SOUTH_O19_DECIMAL = "-41132132113423444234";

// Suffix-band family: one order-29 path ("3" + tail, t28=3 t29=1) encoded
// at orders 26..29. Words derived once with mortie 0.9.0; the expected
// suffixes are the spec section-1 band formulas (26, 27, 28+3*5=43,
// 28+3*5+1+1=45). The POINT twin (suffix 48+3*4+1=61) is derived from the
// same frozen formulas -- mortie 0.9.0 predates point emission (PR #121).
const TAIL29 = "23142314231423142314231423142";
const BAND_WORDS: [number, bigint, number][] = [
  [26, 3906369333256140314n, 26],
  [27, 3906369333256140315n, 27],
  [28, 3906369333256140331n, 43],
  [29, 3906369333256140333n, 45],
];
const POINT_WORD = 3906369333256140349n; // area o29 word - 45 + 61

describe("orderOf / baseCellOf / kind", () => {
  it("decodes the SERC golden word", () => {
    expect(orderOf(SERC_WORD)).toBe(8);
    expect(baseCellOf(SERC_WORD)).toBe(3); // base digit "4", northern
    expect(isPointWord(SERC_WORD)).toBe(false);
  });

  it("decodes the southern order-19 golden word", () => {
    expect(orderOf(SOUTH_O19_WORD)).toBe(19);
    expect(baseCellOf(SOUTH_O19_WORD)).toBe(9); // base "-4" -> cell 9
    expect(renderMortonDecimal(SOUTH_O19_WORD)).toBe(SOUTH_O19_DECIMAL);
  });

  it("walks the suffix bands (area 0..27, 28..47, point 48..63)", () => {
    for (const [order, word, suffix] of BAND_WORDS) {
      expect(Number(word & 63n)).toBe(suffix);
      expect(orderOf(word)).toBe(order);
      expect(isPointWord(word)).toBe(false);
    }
    expect(Number(POINT_WORD & 63n)).toBe(61);
    expect(orderOf(POINT_WORD)).toBe(29);
    expect(isPointWord(POINT_WORD)).toBe(true);
  });

  it("rejects the empty sentinel and invalid prefixes", () => {
    expect(() => baseCellOf(0n)).toThrow(/prefix 0/);
    expect(() => baseCellOf(13n << 60n)).toThrow(/prefix 13/);
    expect(() => orderOf(5n)).not.toThrow(); // order is prefix-independent
  });
});

describe("wordToNested", () => {
  it("matches the SERC fabrication golden", () => {
    expect(wordToNested(SERC_WORD)).toEqual({ order: 8, nested: 238416n });
  });

  it("matches the southern order-19 fabrication golden", () => {
    expect(wordToNested(SOUTH_O19_WORD)).toEqual({
      order: 19,
      nested: SOUTH_O19_NESTED,
    });
  });

  it("converts the deep suffix bands (goldens from mortie 0.9.0)", () => {
    expect(wordToNested(BAND_WORDS[3][1]).nested).toBe(688361957162323341n);
    expect(wordToNested(BAND_WORDS[2][1]).nested).toBe(172090489290580835n);
    // A point converts like its area twin: NESTED carries no kind.
    expect(wordToNested(POINT_WORD).nested).toBe(688361957162323341n);
  });

  it("handles order 0 (goldens from mortie 0.9.0)", () => {
    expect(wordToNested(parseMortonDecimal("3"))).toEqual({
      order: 0,
      nested: 2n,
    });
    expect(wordToNested(parseMortonDecimal("-3"))).toEqual({
      order: 0,
      nested: 8n,
    });
  });
});

describe("clipToOrder", () => {
  it("clips 29 -> 28 onto the encoded order-28 golden", () => {
    expect(clipToOrder(BAND_WORDS[3][1], 28)).toBe(BAND_WORDS[2][1]);
  });

  it("clips 29 -> 24 (mortie 0.9.0 clip2order golden)", () => {
    const clipped = clipToOrder(BAND_WORDS[3][1], 24);
    expect(clipped).toBe(3906369333256138776n);
    expect(renderMortonDecimal(clipped)).toBe("3" + TAIL29.slice(0, 24));
    expect(wordToNested(clipped).nested).toBe(672228473791331n);
  });

  it("returns the word unchanged at or above its native order", () => {
    expect(clipToOrder(SERC_WORD, 8)).toBe(SERC_WORD);
    expect(clipToOrder(SERC_WORD, 29)).toBe(SERC_WORD);
    expect(clipToOrder(POINT_WORD, 29)).toBe(POINT_WORD); // point stays point
  });

  it("clipping a point yields its containing area cell", () => {
    const clipped = clipToOrder(POINT_WORD, 24);
    expect(isPointWord(clipped)).toBe(false);
    expect(clipped).toBe(clipToOrder(BAND_WORDS[3][1], 24)); // same path
  });

  it("rejects out-of-range targets", () => {
    expect(() => clipToOrder(SERC_WORD, 30)).toThrow(RangeError);
    expect(() => clipToOrder(SERC_WORD, -1)).toThrow(RangeError);
  });
});

describe("viewNestedId (the viewer-side float64 cast)", () => {
  it("passes area cells at order <= 24 through as exact Numbers", () => {
    expect(viewNestedId(SERC_WORD)).toEqual({ order: 8, cellId: SERC_NESTED });
    expect(viewNestedId(SOUTH_O19_WORD)).toEqual({
      order: 19,
      cellId: Number(SOUTH_O19_NESTED),
    });
  });

  it("clips POINT words 29 -> 24 first", () => {
    expect(viewNestedId(POINT_WORD)).toEqual({
      order: FLOAT64_EXACT_MAX_ORDER,
      cellId: 672228473791331,
    });
  });

  it("never clips area cells: order > 24 throws toward the proxy path", () => {
    for (const [order, word] of BAND_WORDS) {
      expect(() => viewNestedId(word)).toThrow(
        new RegExp(`order ${order}.*virtual store`, "s"),
      );
    }
  });
});
