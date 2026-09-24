/**
 * The ragged element declaration -- what one cell of a vlen array decodes
 * to -- read from either revision of the zagg ragged contract
 * (englacial/zagg docs/specification.md):
 *
 * - `zagg-ragged/1` (section 1.2): a `variable_length_bytes` / `bytes` array
 *   whose attrs carry `ragged: {spec, element: {dtype, shape: [-1, ...]}}`;
 * - `zagg-ragged/2` (section 6.1): the typed `ndarray` data type
 *   `{name: "ndarray", configuration: {dtype, shape: [null, ...]}}` with the
 *   attrs marker retired.
 *
 * Both name the same pair -- a scalar dtype plus the trailing inner shape --
 * and the chunk bytes are identical (section 6.2), so one decoder serves
 * both. Strict at the gate, like moczarr's `parse_ragged_attrs`: a foreign
 * or future `spec`, a malformed `element`, or an unknown dtype throws
 * rather than half-parses.
 */

export const RAGGED_SPEC = "zagg-ragged/1";
export const RAGGED_ATTR = "ragged";
export const NDARRAY_DTYPE = "ndarray";

/** Scalar element dtypes with a native typed-array view. */
export type ScalarDtype =
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "int64"
  | "uint64"
  | "float32"
  | "float64";

export type ElementArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array;

type ElementArrayCtor = {
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): ElementArray;
  readonly BYTES_PER_ELEMENT: number;
};

const CTORS: Record<ScalarDtype, ElementArrayCtor> = {
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  int64: BigInt64Array,
  uint64: BigUint64Array,
  float32: Float32Array,
  float64: Float64Array,
};

/** numpy spellings the Python writers may emit (`<f4`, `float32`, ...). */
const NUMPY_ALIASES: Record<string, ScalarDtype> = {
  "<i1": "int8",
  "|i1": "int8",
  "<u1": "uint8",
  "|u1": "uint8",
  "<i2": "int16",
  "<u2": "uint16",
  "<i4": "int32",
  "<u4": "uint32",
  "<i8": "int64",
  "<u8": "uint64",
  "<f4": "float32",
  "<f8": "float64",
};

export interface RaggedElement {
  dtype: ScalarDtype;
  /** Trailing element shape; a cell decodes as `(n, ...innerShape)`. */
  innerShape: number[];
}

/** One decoded cell: a typed view plus its `(n, ...innerShape)` shape. */
export interface RaggedCell {
  data: ElementArray;
  shape: number[];
}

export function elementCtor(dtype: ScalarDtype): ElementArrayCtor {
  return CTORS[dtype];
}

/** Bytes of one `(1, ...innerShape)` row of the element. */
export function rowBytes(element: RaggedElement): number {
  return element.innerShape.reduce(
    (n, d) => n * d,
    CTORS[element.dtype].BYTES_PER_ELEMENT,
  );
}

function scalarDtype(value: unknown, field: string): ScalarDtype {
  const name = typeof value === "string" ? (NUMPY_ALIASES[value] ?? value) : "";
  if (name in CTORS) {
    return name as ScalarDtype;
  }
  throw new Error(
    `${field} declares an unreadable element dtype ${JSON.stringify(value)}`,
  );
}

function innerShape(
  shape: unknown,
  marker: number | null,
  field: string,
  form: string,
): number[] {
  const ok =
    Array.isArray(shape) &&
    shape.length >= 1 &&
    shape[0] === marker &&
    shape
      .slice(1)
      .every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0);
  if (!ok) {
    throw new Error(
      `${field} declares element shape ${JSON.stringify(shape)}; the ${form} ` +
        `form is [${marker === null ? "null" : marker}, ...innerShape] ` +
        "(the leading marker is the per-cell varying count)",
    );
  }
  return (shape as number[]).slice(1);
}

/**
 * The strict `zagg-ragged/1` attrs gate (spec section 1.2): a missing or
 * malformed `ragged` block is not a /1 array; a foreign or future `spec`
 * is refused rather than half-parsed.
 */
export function parseRaggedAttrs(
  attrs: unknown,
  field = "<array>",
): RaggedElement {
  const block =
    typeof attrs === "object" && attrs !== null
      ? (attrs as Record<string, unknown>)[RAGGED_ATTR]
      : undefined;
  if (typeof block !== "object" || block === null) {
    throw new Error(
      `${field} carries no ragged element declaration (attrs["${RAGGED_ATTR}"]); ` +
        `it is not a ${RAGGED_SPEC} array -- refusing to decode under a guessed layout`,
    );
  }
  const raw = block as Record<string, unknown>;
  if (raw["spec"] !== RAGGED_SPEC) {
    throw new Error(
      `${field} declares ragged spec ${JSON.stringify(raw["spec"])}; this reader ` +
        `understands ${RAGGED_SPEC} only -- an unknown or future revision must be ` +
        "adopted deliberately, never half-parsed",
    );
  }
  const element = raw["element"];
  if (
    typeof element !== "object" ||
    element === null ||
    !("dtype" in element) ||
    !("shape" in element)
  ) {
    throw new Error(
      `${field} has a malformed element declaration ` +
        `(attrs["${RAGGED_ATTR}"]["element"] needs "dtype" and "shape")`,
    );
  }
  const decl = element as Record<string, unknown>;
  return {
    dtype: scalarDtype(decl["dtype"], field),
    innerShape: innerShape(decl["shape"], -1, field, "spec section 1.2"),
  };
}

/**
 * The `zagg-ragged/2` typed data type (spec section 6.1, the
 * zarr-vlen-ndarray `ndarray` extension): `{name: "ndarray",
 * configuration: {dtype, shape: [null, ...innerShape]}}`. Returns null for
 * any other data type (the caller then tries the /1 attrs route).
 */
export function parseNdarrayDataType(
  dataType: unknown,
  field = "<array>",
): RaggedElement | null {
  if (
    typeof dataType !== "object" ||
    dataType === null ||
    (dataType as Record<string, unknown>)["name"] !== NDARRAY_DTYPE
  ) {
    return null;
  }
  const config = (dataType as Record<string, unknown>)["configuration"];
  if (typeof config !== "object" || config === null) {
    throw new Error(
      `${field}: ${NDARRAY_DTYPE} data type lacks a configuration`,
    );
  }
  const decl = config as Record<string, unknown>;
  return {
    dtype: scalarDtype(decl["dtype"], field),
    innerShape: innerShape(decl["shape"], null, field, "ndarray data type"),
  };
}

/** Data type names a /1 payload array may carry (zarr-python#3517). */
const VLEN_BYTES_DTYPES = new Set(["variable_length_bytes", "bytes"]);

/**
 * Element declaration of an array from its zarr v3 metadata, dispatching
 * on revision: the `ndarray` data type is /2 (attrs block retired), a
 * `variable_length_bytes` / `bytes` data type with the `ragged` attrs block
 * is /1. Anything else is not a zagg ragged array.
 */
export function raggedElementOf(
  metadata: { data_type?: unknown; attributes?: unknown },
  field = "<array>",
): RaggedElement {
  const typed = parseNdarrayDataType(metadata.data_type, field);
  if (typed !== null) {
    return typed;
  }
  const name =
    typeof metadata.data_type === "string"
      ? metadata.data_type
      : ((metadata.data_type as Record<string, unknown> | undefined)?.[
          "name"
        ] as string | undefined);
  if (name === undefined || !VLEN_BYTES_DTYPES.has(name)) {
    throw new Error(
      `${field} has data type ${JSON.stringify(metadata.data_type)}; a ragged array ` +
        `is ${NDARRAY_DTYPE} (zagg-ragged/2) or variable_length_bytes with a ` +
        `${RAGGED_SPEC} attrs block`,
    );
  }
  return parseRaggedAttrs(metadata.attributes, field);
}
