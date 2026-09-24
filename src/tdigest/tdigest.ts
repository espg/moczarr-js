/**
 * t-digest evaluation kernels -- the browser twin of `moczarr.tdigest`
 * (espg/moczarr src/moczarr/tdigest.py), value-identical by construction:
 * the same float64 arithmetic in the same order, with numpy's `np.interp`
 * semantics reproduced exactly (ties resolve to the last equal centroid,
 * `x == means[-1]` evaluates to that centroid's position, not the total).
 *
 * The stored payload is the whole contract (englacial/zagg spec section
 * 2.1): a populated cell decodes to `(k, 2)` float32 rows -- column 0 the
 * mean, column 1 the weight -- ascending by mean; an absent cell is the
 * `(0, 2)` array. Two standing traps, honoured here and required of every
 * caller: (1) every kernel walks centroids in mean order, so anything
 * assembled from more than one digest must be re-sorted by (mean, weight)
 * first; (2) a centroid of weight `w` sits at cumulative weight
 * `cum_before + w/2`, never at the raw cumsum.
 */

import type { RaggedCell } from "../vlen/element.js";

/** A digest as parallel float64 columns, means ascending. */
export interface Digest {
  means: Float64Array;
  weights: Float64Array;
}

/** A decoded `(k, 2)` cell (or flat `[m0, w0, m1, w1, ...]`) as a Digest. */
export function digestFromCell(
  cell: RaggedCell | ArrayLike<number> | number[][],
): Digest {
  let flat: ArrayLike<number>;
  if (Array.isArray(cell) && (cell.length === 0 || Array.isArray(cell[0]))) {
    flat = (cell as number[][]).flat();
  } else if (
    "data" in (cell as RaggedCell) &&
    "shape" in (cell as RaggedCell)
  ) {
    const { data, shape } = cell as RaggedCell;
    if (shape.length !== 2 || shape[1] !== 2) {
      throw new Error(
        `a t-digest cell is (k, 2) float rows; got shape [${shape.join(", ")}]`,
      );
    }
    flat = data as ArrayLike<number>;
  } else {
    flat = cell as ArrayLike<number>;
  }
  if (flat.length % 2 !== 0) {
    throw new Error(
      `a t-digest needs an even number of values (got ${flat.length})`,
    );
  }
  const k = flat.length / 2;
  const means = new Float64Array(k);
  const weights = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    means[i] = Number(flat[2 * i]);
    weights[i] = Number(flat[2 * i + 1]);
  }
  return { means, weights };
}

/**
 * Total weight: the exact observation count under a `counts` payload.
 *
 * Summed sequentially. numpy's `weights.sum()` -- what `cdf_from_tdigest`
 * and `quantile_from_tdigest` reduce with on the Python side -- sums
 * pairwise above 8 elements, and a compiler is free to contract a
 * multiply-add; either moves the last bits. So the contract against the
 * reference is 1e-6 relative, not bit-identity (observed <= 1e-12).
 */
export function totalWeight(digest: Digest): number {
  let total = 0;
  for (let i = 0; i < digest.weights.length; i++) {
    total += digest.weights[i];
  }
  return total;
}

/** Largest `j` with `xp[j] <= x` (numpy's binary_search_with_guess), or -1. */
function lastAtOrBelow(xp: Float64Array, x: number): number {
  let lo = 0;
  let hi = xp.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xp[mid] <= x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

/** `np.interp(x, xp, fp, left, right)` for one x, numpy's exact branches. */
function interp(
  x: number,
  xp: Float64Array,
  fp: Float64Array,
  left: number,
  right: number,
): number {
  const n = xp.length;
  if (Number.isNaN(x)) {
    return x;
  }
  if (x > xp[n - 1]) {
    return right;
  }
  if (x < xp[0]) {
    return left;
  }
  const j = lastAtOrBelow(xp, x);
  if (j === n - 1 || xp[j] === x) {
    return fp[j];
  }
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  const res = slope * (x - xp[j]) + fp[j];
  if (!Number.isNaN(res)) {
    return res;
  }
  const alt = slope * (x - xp[j + 1]) + fp[j + 1];
  return Number.isNaN(alt) && fp[j] === fp[j + 1] ? fp[j] : alt;
}

/**
 * Cumulative weight at each `x` (`moczarr.tdigest.cdf_from_tdigest`): the
 * CDF interpolates linearly in value-space between adjacent centroid
 * means, each centroid at the midpoint of its weight interval, flat `0` /
 * `total` outside `[means[0], means[-1]]`; a single centroid is a step at
 * its mean; an empty digest evaluates to NaN.
 */
export function cdfFromTdigest(
  digest: Digest,
  x: ArrayLike<number>,
): Float64Array {
  const { means, weights } = digest;
  const out = new Float64Array(x.length);
  const k = means.length;
  if (k === 0) {
    out.fill(Number.NaN);
    return out;
  }
  const cumCenter = new Float64Array(k);
  let cum = 0;
  for (let i = 0; i < k; i++) {
    cum += weights[i];
    cumCenter[i] = cum - weights[i] / 2;
  }
  const total = totalWeight(digest);
  if (k === 1) {
    for (let i = 0; i < x.length; i++) {
      out[i] = x[i] >= means[0] ? total : 0;
    }
    return out;
  }
  for (let i = 0; i < x.length; i++) {
    out[i] = interp(x[i], means, cumCenter, 0, total);
  }
  return out;
}

/**
 * Quantile `q` (`moczarr.tdigest.quantile_from_tdigest`): the target rank
 * is `q * (n - 1)`; centroid `k` owns ranks `[upper[k-1], upper[k] - 1]`
 * and the value interpolates between the midpoints of adjacent means,
 * clamped at both ends. NaN for an empty digest.
 */
export function quantileFromTdigest(digest: Digest, q: number): number {
  const { means, weights } = digest;
  const k = means.length;
  if (k === 0) {
    return Number.NaN;
  }
  const n = totalWeight(digest);
  const target = q * (n - 1);
  let upperPrev = 0;
  let upper = 0;
  for (let i = 0; i < k; i++) {
    upper += weights[i];
    const lo = i === 0 ? 0 : upperPrev;
    const hi = upper - 1;
    if (target <= hi) {
      if (hi <= lo) {
        return means[i];
      }
      const frac = (target - lo) / (hi - lo);
      let loVal: number;
      let hiVal: number;
      if (i === 0) {
        loVal = means[0];
        hiVal = k === 1 ? means[0] : (means[0] + means[1]) / 2;
      } else {
        loVal = (means[i - 1] + means[i]) / 2;
        hiVal = i === k - 1 ? means[i] : (means[i] + means[i + 1]) / 2;
      }
      return loVal + frac * (hiVal - loVal);
    }
    upperPrev = upper;
  }
  return means[k - 1];
}

/** Evenly spaced bin edges: `zLo + resolution * i`, `i = 0..nBins`. */
export function binEdges(
  zLo: number,
  resolution: number,
  nBins: number,
): Float64Array {
  const edges = new Float64Array(nBins + 1);
  for (let i = 0; i <= nBins; i++) {
    edges[i] = zLo + resolution * i;
  }
  return edges;
}

/**
 * One digest's per-bin weight over `edges` (`moczarr.hhdc.rasterize_cell`
 * generalized to any ascending edge vector): `cdf(edge[i+1]) -
 * cdf(edge[i])`, clipped at 0 against float noise; an empty digest is all
 * zeros. Weight outside `[edges[0], edges[-1]]` is dropped.
 */
export function binDigest(
  digest: Digest,
  edges: ArrayLike<number>,
): Float64Array {
  const nBins = edges.length - 1;
  const counts = new Float64Array(nBins);
  if (digest.means.length === 0) {
    return counts;
  }
  const cdf = cdfFromTdigest(digest, edges);
  for (let i = 0; i < nBins; i++) {
    counts[i] = Math.max(0, cdf[i + 1] - cdf[i]);
  }
  return counts;
}

/** A `(cells, bins)` row-major tensor. */
export interface BinnedCells {
  data: Float64Array;
  shape: [number, number];
}

/**
 * The cast: every digest binned over one shared edge vector, as a
 * `(cells, bins)` row-major float64 tensor -- the browser twin of the
 * per-cell loop in `moczarr.hhdc.read_tensors` (`rint` to counts, or keep
 * fractions for a `flux` payload, is the caller's dtype decision).
 *
 * Rows come back in cells-axis (nested-rank) order -- the order the leaf
 * stores them in, not a raster scan. Laying them out as a spatial
 * `(side, side)` image needs mortie section 8's bit-deinterleave
 * (`moczarr.hhdc.rank_to_rowcol`); `divmod(rank, side)` looks right and is
 * silently wrong. No deinterleave is provided here.
 */
export function castToBins(
  digests: ArrayLike<Digest>,
  edges: ArrayLike<number>,
): BinnedCells {
  const nBins = edges.length - 1;
  if (nBins < 1) {
    throw new Error("castToBins needs at least two bin edges");
  }
  const data = new Float64Array(digests.length * nBins);
  for (let c = 0; c < digests.length; c++) {
    data.set(binDigest(digests[c], edges), c * nBins);
  }
  return { data, shape: [digests.length, nBins] };
}

export type FitMode = "raise" | "degrade_resolution" | "collapse_bins";

export interface ZRangeOptions {
  nBins: number;
  resolution: number;
  /** Lower / upper density-trim quantiles (moczarr defaults 0.05 / 0.95). */
  bottom?: number;
  top?: number;
  fit?: FitMode;
}

export interface ZWindow {
  zLo: number;
  nBins: number;
  resolution: number;
}

function tailBounds(
  digest: Digest,
  bottom: number,
  top: number,
): [number, number] | null {
  if (digest.means.length === 0) {
    return null;
  }
  const lo = quantileFromTdigest(digest, bottom);
  const hi = quantileFromTdigest(digest, top);
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/**
 * Derive a block's shared z-window and apply the fit policy
 * (`moczarr.hhdc.chunk_z_range`): trim each cell's tails at the
 * `bottom`/`top` quantiles, floor the window at the minimum, and when the
 * trimmed span exceeds `nBins * resolution` either throw (`raise`), double
 * the resolution until it fits (`degrade_resolution`), or shrink the bin
 * count to the smallest power of two that still covers (`collapse_bins`).
 */
export function chunkZRange(
  digests: ArrayLike<Digest>,
  options: ZRangeOptions,
): ZWindow {
  const {
    nBins,
    resolution,
    bottom = 0.05,
    top = 0.95,
    fit = "raise",
  } = options;
  // Folded in the loop, never `Math.min(...bounds)`: a block carries one
  // bound per populated cell (4^9 = 262,144 at an o9 leaf), well past the
  // engine's argument limit.
  let lo = Infinity;
  let hi = -Infinity;
  let populated = 0;
  for (let i = 0; i < digests.length; i++) {
    const b = tailBounds(digests[i], bottom, top);
    if (b !== null) {
      populated++;
      if (b[0] < lo) lo = b[0];
      if (b[1] > hi) hi = b[1];
    }
  }
  if (populated === 0) {
    throw new Error(
      "chunk has no populated cells with a finite quantile range",
    );
  }
  const zLo = Math.floor(lo);
  const zHi = Math.ceil(hi);
  const needed = zHi - zLo;
  const window = nBins * resolution;
  if (fit === "collapse_bins") {
    if (needed > window) {
      throw new Error(
        `fit="collapse_bins" cannot grow the window: trimmed span ${needed} exceeds ` +
          `${nBins} bins x ${resolution} = ${window}`,
      );
    }
    let n = 1 << (31 - Math.clz32(nBins));
    while (n / 2 >= 1 && (n / 2) * resolution >= needed) {
      n /= 2;
    }
    return { zLo, nBins: n, resolution };
  }
  if (needed <= window) {
    return { zLo, nBins, resolution };
  }
  if (fit === "raise") {
    throw new Error(
      `trimmed z-range [${zLo}, ${zHi}] (span ${needed}) exceeds the fixed window ` +
        `${nBins} bins x ${resolution} = ${window}; pass fit="degrade_resolution" or ` +
        'fit="collapse_bins" to adapt',
    );
  }
  if (fit === "degrade_resolution") {
    let res = resolution;
    while (needed > nBins * res) {
      res *= 2;
    }
    return { zLo, nBins, resolution: res };
  }
  throw new Error(`unknown fit mode ${JSON.stringify(fit)}`);
}
