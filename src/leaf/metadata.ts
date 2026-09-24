/**
 * The slice of zarr v3 array metadata a store-direct ragged read needs:
 * the cells axis length, the stored-object geometry (spec section 1.5 --
 * one object per shard under `sharding_indexed`, else one per chunk), the
 * inner codec chain, and the chunk key encoding. Both geometries are
 * self-describing in the array's own `zarr.json`, so one code path reads
 * either by deriving the object span from the shard shape when sharded and
 * the chunk shape otherwise.
 */

import { type RaggedElement, raggedElementOf } from "../vlen/element.js";

export interface CodecDecl {
  name: string;
  configuration?: Record<string, unknown>;
}

export interface RaggedGeometry {
  /** Cells on the axis. */
  length: number;
  /** Cells per inner chunk (the decode unit). */
  cellsPerChunk: number;
  /** Cells per stored object: the shard when sharded, else the chunk. */
  cellsPerObject: number;
  /** Inner chunks per stored object (1 when unsharded). */
  chunksPerObject: number;
  sharded: boolean;
  /** The chain inside the object: `[vlen-bytes|vlen-ndarray, zstd?]`. */
  codecs: CodecDecl[];
  /** Whether the chain ends in zstd (spec section 1.3 says it must). */
  zstd: boolean;
  /** Chunk key separator (`/` for the v3 default encoding). */
  separator: string;
}

export interface RaggedMetadata {
  geometry: RaggedGeometry;
  element: RaggedElement;
  /** Sibling names bound by the payload array's attrs (spec 1.2 / 8.3). */
  locations: string | null;
  times: string | null;
  /** The spec 2.0 weights declaration (absent reads as "counts"). */
  weights: "counts" | "flux";
  /**
   * The spec 2.0 `gain` block a `flux` payload carries -- the calibration
   * its photoelectron estimate was produced under. Null when the array
   * declares none, as a `counts` payload does.
   */
  gain: Record<string, unknown> | null;
  attributes: Record<string, unknown>;
}

const VLEN_CODECS = new Set(["vlen-bytes", "vlen-ndarray"]);
const WEIGHTS = new Set(["counts", "flux"]);

function int(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `${what} must be a non-negative integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function oneDim(shape: unknown, what: string): number {
  if (!Array.isArray(shape) || shape.length !== 1) {
    throw new Error(
      `${what} must be 1-D (the cells axis); got ${JSON.stringify(shape)}`,
    );
  }
  return int(shape[0], what);
}

function codecList(value: unknown, what: string): CodecDecl[] {
  if (!Array.isArray(value) || value.some((c) => typeof c?.name !== "string")) {
    throw new Error(`${what} must be a list of named codecs`);
  }
  return value as CodecDecl[];
}

/** Validate the inner chain: a vlen codec first, optionally zstd after. */
function innerChain(codecs: CodecDecl[], field: string): boolean {
  const names = codecs.map((c) => c.name);
  const ok =
    names.length >= 1 &&
    VLEN_CODECS.has(names[0]) &&
    (names.length === 1 || (names.length === 2 && names[1] === "zstd"));
  if (!ok) {
    throw new Error(
      `${field} codec chain [${names.join(", ")}] is not the ragged chain ` +
        "[vlen-bytes|vlen-ndarray, zstd] (spec section 1.3)",
    );
  }
  return names.length === 2;
}

/** Parse the geometry of a 1-D vlen array's zarr v3 metadata. */
export function parseRaggedGeometry(
  meta: Record<string, unknown>,
  field: string,
): RaggedGeometry {
  if (meta["zarr_format"] !== 3 || meta["node_type"] !== "array") {
    throw new Error(`${field} is not a zarr v3 array`);
  }
  const length = oneDim(meta["shape"], `${field} shape`);
  const grid = meta["chunk_grid"] as Record<string, unknown> | undefined;
  if (grid?.["name"] !== "regular") {
    throw new Error(
      `${field} uses an unsupported chunk grid ${JSON.stringify(grid?.["name"])}`,
    );
  }
  const outer = oneDim(
    (grid["configuration"] as Record<string, unknown>)?.["chunk_shape"],
    `${field} chunk_shape`,
  );
  const keyEncoding = meta["chunk_key_encoding"] as
    Record<string, unknown> | undefined;
  const separator =
    ((keyEncoding?.["configuration"] as Record<string, unknown> | undefined)?.[
      "separator"
    ] as string | undefined) ?? "/";
  if (keyEncoding !== undefined && keyEncoding["name"] !== "default") {
    throw new Error(
      `${field} uses an unsupported chunk key encoding ${JSON.stringify(keyEncoding["name"])}`,
    );
  }
  const codecs = codecList(meta["codecs"], `${field} codecs`);
  if (codecs.length === 1 && codecs[0].name === "sharding_indexed") {
    const config = codecs[0].configuration ?? {};
    const inner = oneDim(
      config["chunk_shape"],
      `${field} sharding chunk_shape`,
    );
    if (inner === 0 || outer % inner !== 0) {
      throw new Error(
        `${field}: shard of ${outer} cells is not a whole number of ${inner}-cell chunks`,
      );
    }
    const indexNames = codecList(
      config["index_codecs"],
      `${field} index_codecs`,
    ).map((c) => c.name);
    if (
      indexNames.join(",") !== "bytes,crc32c" ||
      config["index_location"] !== "end"
    ) {
      throw new Error(
        `${field} shard index must be [bytes, crc32c] at index_location end ` +
          `(got [${indexNames.join(", ")}] at ${JSON.stringify(config["index_location"])})`,
      );
    }
    const innerCodecs = codecList(config["codecs"], `${field} inner codecs`);
    return {
      length,
      cellsPerChunk: inner,
      cellsPerObject: outer,
      chunksPerObject: outer / inner,
      sharded: true,
      codecs: innerCodecs,
      zstd: innerChain(innerCodecs, field),
      separator,
    };
  }
  return {
    length,
    cellsPerChunk: outer,
    cellsPerObject: outer,
    chunksPerObject: 1,
    sharded: false,
    codecs,
    zstd: innerChain(codecs, field),
    separator,
  };
}

/** Parse a ragged payload (or companion) array's full metadata. */
export function parseRaggedMetadata(
  meta: Record<string, unknown>,
  field: string,
): RaggedMetadata {
  const attributes = (meta["attributes"] ?? {}) as Record<string, unknown>;
  const element = raggedElementOf(meta, field);
  const geometry = parseRaggedGeometry(meta, field);
  const block = (attributes["ragged"] ?? {}) as Record<string, unknown>;
  const locations = block["locations"];
  const times = attributes["times"];
  const weights = attributes["weights"] ?? "counts";
  const gain = attributes["gain"];
  if (typeof weights !== "string" || !WEIGHTS.has(weights)) {
    throw new Error(
      `${field} declares weights ${JSON.stringify(weights)}; spec section 2.0 defines ` +
        '"counts" and "flux", and an unknown declaration must be refused',
    );
  }
  return {
    geometry,
    element,
    locations: typeof locations === "string" && locations ? locations : null,
    times: typeof times === "string" && times ? times : null,
    weights: weights as "counts" | "flux",
    gain:
      typeof gain === "object" && gain !== null && !Array.isArray(gain)
        ? (gain as Record<string, unknown>)
        : null,
    attributes,
  };
}
