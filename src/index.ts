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
