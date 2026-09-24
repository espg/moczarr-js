/**
 * Kernel parity with the Python reference: tests/data/tdigest_goldens.json
 * holds moczarr's cdf_from_tdigest / quantile_from_tdigest /
 * rasterize_cell / chunk_z_range outputs over the vendored conformance
 * fixture digests plus hand-built edge cases (single centroid, tied means,
 * all-equal means). Tolerance is 1e-6 relative; the CDF and raster columns
 * are expected to land exactly (same float64 arithmetic, same order).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openLeaf } from "../../src/leaf/leaf.js";
import {
  type Digest,
  binDigest,
  binEdges,
  castToBins,
  cdfFromTdigest,
  chunkZRange,
  digestFromCell,
  quantileFromTdigest,
  totalWeight,
} from "../../src/tdigest/tdigest.js";
import { FileStore } from "../helpers/fileStore.js";
import { SPEC_ROOT, expected } from "../helpers/spec.js";

interface GoldenCase {
  name: string;
  digest: number[][];
  x: number[];
  cdf: number[];
  quantiles: Record<string, number>;
  raster: {
    z_lo: number;
    resolution: number;
    n_bins: number;
    counts: number[];
  };
}

interface Goldens {
  cases: GoldenCase[];
  chunk_z_range: {
    windows: Record<
      string,
      { z_lo: number; n_bins: number; resolution: number } | { error: string }
    >;
  };
}

const goldens = JSON.parse(
  readFileSync(
    new URL("../data/tdigest_goldens.json", import.meta.url),
    "utf8",
  ),
) as Goldens;

const REL = 1e-6;

/**
 * The tolerance is 1e-6 relative with a 1e-6 absolute floor:
 * `REL * max(1, |wanted|)`, so a value at or near zero still gets 1e-6 of
 * slack rather than being held to bit-identity.
 */
function expectRel(actual: ArrayLike<number>, wanted: number[], label: string) {
  expect(actual.length, label).toBe(wanted.length);
  for (let i = 0; i < wanted.length; i++) {
    const tol = REL * Math.max(1, Math.abs(wanted[i]));
    expect(
      Math.abs(actual[i] - wanted[i]),
      `${label}[${i}]`,
    ).toBeLessThanOrEqual(tol);
  }
}

/** The digest as the float32 bytes a leaf read yields (not the JSON float64s). */
function stored(rows: number[][]): Digest {
  return digestFromCell({
    data: Float32Array.from(rows.flat()),
    shape: [rows.length, 2],
  });
}

describe("cdfFromTdigest / quantileFromTdigest / binDigest parity", () => {
  for (const c of goldens.cases) {
    it(`${c.name}: CDF at ${c.x.length} points`, () => {
      expectRel(cdfFromTdigest(stored(c.digest), c.x), c.cdf, "cdf");
    });
    it(`${c.name}: quantiles`, () => {
      const d = stored(c.digest);
      for (const [q, wanted] of Object.entries(c.quantiles)) {
        expectRel([quantileFromTdigest(d, Number(q))], [wanted], `q=${q}`);
      }
    });
    it(`${c.name}: rasterized bins`, () => {
      const { z_lo, resolution, n_bins, counts } = c.raster;
      const got = binDigest(
        stored(c.digest),
        binEdges(z_lo, resolution, n_bins),
      );
      expectRel(got, counts, "counts");
    });
  }

  it("lands the golden CDF values to 1e-12 relative (well inside the 1e-6 contract)", () => {
    // Same float64 formula in the same order as np.interp; the residual
    // 1-ulp differences are numpy's FMA-contracted `slope*(x-xp)+fp` on
    // arm64 builds, which JavaScript cannot reproduce, so bit-equality is
    // not the bar -- 1e-12 relative is.
    for (const c of goldens.cases) {
      const got = cdfFromTdigest(stored(c.digest), c.x);
      for (let i = 0; i < c.x.length; i++) {
        expect(Math.abs(got[i] - c.cdf[i])).toBeLessThanOrEqual(
          1e-12 * Math.max(1, Math.abs(c.cdf[i])),
        );
      }
    }
  });

  it("empty digests evaluate to NaN / zeros", () => {
    const empty = digestFromCell([]);
    expect(Array.from(cdfFromTdigest(empty, [0, 1]))).toEqual([NaN, NaN]);
    expect(quantileFromTdigest(empty, 0.5)).toBeNaN();
    expect(Array.from(binDigest(empty, [0, 1, 2]))).toEqual([0, 0]);
  });
});

describe("chunkZRange parity (moczarr.hhdc.chunk_z_range)", () => {
  const minimal = expected("minimal").cells.map((c) =>
    stored(c.h_tdigest as number[][]),
  );
  /** Our own refusal text, per fit mode, where a golden records an error. */
  const REFUSAL: Record<string, string> = {
    raise: "exceeds the fixed window",
    collapse_bins: 'fit="collapse_bins" cannot grow the window',
  };

  for (const [key, wanted] of Object.entries(goldens.chunk_z_range.windows)) {
    const [fit, nBins, resolution] = key.split(":");
    const options = {
      nBins: Number(nBins),
      resolution: Number(resolution),
      fit: fit as "raise" | "degrade_resolution" | "collapse_bins",
    };
    it(`${key}`, () => {
      if ("error" in wanted) {
        // The golden records *that* the reference refuses this window; the
        // message is ours, so assert on a stable substring of it rather
        // than on Python's wording (which is not a regex, and whose first
        // characters could be metacharacters).
        expect(() => chunkZRange(minimal, options)).toThrow(REFUSAL[fit]);
      } else {
        expect(chunkZRange(minimal, options)).toEqual({
          zLo: wanted.z_lo,
          nBins: wanted.n_bins,
          resolution: wanted.resolution,
        });
      }
    });
  }

  it("refuses a block with no populated cells", () => {
    expect(() =>
      chunkZRange([digestFromCell([])], { nBins: 8, resolution: 1 }),
    ).toThrow(/no populated cells/);
  });

  // A spread over the per-cell bounds blows the engine's argument limit
  // well below an o9 leaf's 4^9 = 262,144 cells.
  it("folds the bounds of 200,000 cells without a spread", () => {
    const many = Array.from({ length: 200_000 }, (_, i) =>
      digestFromCell([[i % 100, 1]]),
    );
    expect(chunkZRange(many, { nBins: 256, resolution: 1 })).toEqual({
      zLo: 0,
      nBins: 256,
      resolution: 1,
    });
  });
});

describe("castToBins (the read_tensors twin)", () => {
  it("bins every leaf digest onto one shared window; totals match count", async () => {
    const exp = expected("minimal");
    const leaf = await openLeaf(new FileStore(`${SPEC_ROOT}minimal`), exp.leaf);
    const cells = await (await leaf.ragged("h_tdigest")).readCells(0, 16);
    const digests = cells.map(digestFromCell);
    // A window wide enough to hold every centroid (the fixture's means span
    // 16.24..44.76), so no weight is trimmed away and each row's total is
    // the cell's exact observation count (spec section 2.1, counts payload).
    const binned = castToBins(digests, binEdges(15, 0.5, 64));
    expect(binned.shape).toEqual([16, 64]);
    const counts = Array.from(
      (await leaf.readDense("count")).data as Int32Array,
    );
    for (let c = 0; c < 16; c++) {
      const row = binned.data.subarray(c * 64, (c + 1) * 64);
      const total = row.reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(counts[c], 9);
      expect(total).toBeCloseTo(totalWeight(digests[c]), 9);
    }
    // The derived (5%/95%-trimmed) window drops tail weight by design:
    // cell 15's floor sits above its lowest centroid, so its total falls short.
    const window = chunkZRange(digests, { nBins: 64, resolution: 0.5 });
    const trimmed = castToBins(
      digests,
      binEdges(window.zLo, window.resolution, window.nBins),
    );
    const row15 = trimmed.data
      .subarray(15 * 64, 16 * 64)
      .reduce((a, b) => a + b, 0);
    expect(row15).toBeLessThan(counts[15]);
  });

  it("matches the per-cell golden raster row by row", () => {
    const c = goldens.cases[0];
    const edges = binEdges(c.raster.z_lo, c.raster.resolution, c.raster.n_bins);
    const binned = castToBins([stored(c.digest), digestFromCell([])], edges);
    expect(binned.shape).toEqual([2, 64]);
    expectRel(binned.data.subarray(0, 64), c.raster.counts, "row0");
    expect(Array.from(binned.data.subarray(64))).toEqual(new Array(64).fill(0));
  });

  it("validates cell shapes and edge counts", () => {
    expect(() =>
      digestFromCell({ data: new Float32Array(3), shape: [3] }),
    ).toThrow(/\(k, 2\)/);
    expect(() => castToBins([], [1])).toThrow(/at least two bin edges/);
  });
});
