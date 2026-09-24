/**
 * moczarr-js - browser/TypeScript reader for morton-hive zarr leaves.
 *
 * Three entry points, mirroring the Python reference (espg/moczarr):
 * hive arithmetic (manifest, leaf paths, coverage ranges, decimal ids);
 * the vlen-ndarray decode (zagg-ragged/1 and /2 wire framing); and the
 * t-digest cast (CDF at bin edges -> histograms). It reads the LEAVES it
 * is pointed at -- presenting a hive as one zarr is the icechunk
 * virtual-manifest route, not this package's job.
 */

// Hive arithmetic (mortie spec v1.0 sections 2, 4, 6, 7)
export { MANIFEST_NAME, parseHiveManifest } from "./hive/manifest.js";
export type { HiveManifest, HiveSpec } from "./hive/manifest.js";
export {
  classifyStoreRoot,
  hiveComponents,
  isBaseComponent,
  isProductName,
  leafName,
  leafPath,
  shardIdFromPath,
  splitLeafName,
  validateLabel,
} from "./hive/hive.js";
export type { RootClassification } from "./hive/hive.js";
export {
  COVERAGE_SPEC,
  MAX_COVERAGE_IDS,
  ROOT_COVERAGE_NAME,
  coveredLeafPaths,
  parseRootCoverage,
  rangesContain,
  rangesShardIds,
} from "./hive/coverage.js";
export type { RootCoverage } from "./hive/coverage.js";
export {
  decimalBase,
  decimalOrder,
  decimalRank,
  parseMortonDecimal,
  rankTail,
  renderMortonDecimal,
} from "./hive/decimal.js";

// vlen-ndarray decode (zagg spec sections 1.2-1.4 and 6)
export {
  NDARRAY_DTYPE,
  RAGGED_ATTR,
  RAGGED_SPEC,
  parseNdarrayDataType,
  parseRaggedAttrs,
  raggedElementOf,
  rowBytes,
} from "./vlen/element.js";
export type {
  ElementArray,
  RaggedCell,
  RaggedElement,
  ScalarDtype,
} from "./vlen/element.js";
export {
  decodeCell,
  decodeRaggedChunk,
  decodeVlenFrames,
  decodeVlenNdarray,
  decodeZstd,
} from "./vlen/framing.js";
export {
  VLEN_BYTES_CODEC,
  VLEN_NDARRAY_CODEC,
  VlenNdarrayCodec,
  registerVlenCodecs,
} from "./vlen/codec.js";
export type {
  CodecRegistry,
  VlenChunk,
  VlenChunkMetadata,
} from "./vlen/codec.js";

// Store contract + a plain fetch Range store
export type {
  AbsolutePath,
  AsyncReadable,
  GetOptions,
  RangeQuery,
  RangeReadable,
} from "./store/types.js";
export { absolutePath } from "./store/types.js";
export { HttpStore } from "./store/http.js";
export type { HttpStoreOptions } from "./store/http.js";

// Store-direct leaf reader (zagg spec section 1.5)
export { Leaf, openLeaf } from "./leaf/leaf.js";
export type { DenseValues, OpenLeafOptions } from "./leaf/leaf.js";
export { RaggedArray, emptyCell } from "./leaf/ragged.js";
export { parseRaggedGeometry, parseRaggedMetadata } from "./leaf/metadata.js";
export type {
  CodecDecl,
  RaggedGeometry,
  RaggedMetadata,
} from "./leaf/metadata.js";
export {
  parseShardIndex,
  readShardChunk,
  readShardIndex,
  shardIndexBytes,
} from "./leaf/shard.js";
export type { ChunkSpan } from "./leaf/shard.js";
export { crc32c } from "./leaf/crc32c.js";

// t-digest cast (zagg spec section 2; kernels mirror moczarr.tdigest / moczarr.hhdc)
export {
  binDigest,
  binEdges,
  castToBins,
  cdfFromTdigest,
  chunkZRange,
  digestFromCell,
  quantileFromTdigest,
  totalWeight,
} from "./tdigest/tdigest.js";
export type {
  BinnedCells,
  Digest,
  FitMode,
  ZRangeOptions,
  ZWindow,
} from "./tdigest/tdigest.js";
