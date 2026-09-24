import { describe, expect, it } from "vitest";

import {
  parseNdarrayDataType,
  parseRaggedAttrs,
  raggedElementOf,
  rowBytes,
} from "../../src/vlen/element.js";

// The committed zagg conformance fixture's declaration (spec section 1.2).
const V1_ATTRS = {
  ragged: {
    spec: "zagg-ragged/1",
    element: { dtype: "float32", shape: [-1, 2] },
  },
};

// The zarr-vlen-ndarray typed form (spec section 6.1).
const V2_DTYPE = {
  name: "ndarray",
  configuration: { dtype: "float32", shape: [null, 2] },
};

describe("parseRaggedAttrs (zagg-ragged/1 strict gate)", () => {
  it("reads the digest declaration", () => {
    expect(parseRaggedAttrs(V1_ATTRS)).toEqual({
      dtype: "float32",
      innerShape: [2],
    });
    expect(rowBytes(parseRaggedAttrs(V1_ATTRS))).toBe(8);
  });

  it("reads a locations sibling declaration (uint64, empty inner shape)", () => {
    const attrs = {
      ragged: {
        spec: "zagg-ragged/1",
        element: { dtype: "uint64", shape: [-1] },
      },
    };
    expect(parseRaggedAttrs(attrs)).toEqual({
      dtype: "uint64",
      innerShape: [],
    });
  });

  it("accepts numpy dtype spellings", () => {
    const attrs = {
      ragged: {
        spec: "zagg-ragged/1",
        element: { dtype: "<f4", shape: [-1, 2] },
      },
    };
    expect(parseRaggedAttrs(attrs).dtype).toBe("float32");
  });

  it("refuses a missing block, a foreign spec, and a malformed element", () => {
    expect(() => parseRaggedAttrs({})).toThrow(/no ragged element declaration/);
    expect(() => parseRaggedAttrs(null)).toThrow(
      /no ragged element declaration/,
    );
    expect(() =>
      parseRaggedAttrs({
        ragged: { ...V1_ATTRS.ragged, spec: "zagg-ragged/9" },
      }),
    ).toThrow(/understands zagg-ragged\/1 only/);
    expect(() =>
      parseRaggedAttrs({ ragged: { spec: "zagg-ragged/1", element: {} } }),
    ).toThrow(/malformed element declaration/);
    expect(() =>
      parseRaggedAttrs({
        ragged: {
          spec: "zagg-ragged/1",
          element: { dtype: "float32", shape: [2] },
        },
      }),
    ).toThrow(/\[-1, \.\.\.innerShape\]/);
    expect(() =>
      parseRaggedAttrs({
        ragged: {
          spec: "zagg-ragged/1",
          element: { dtype: "float128", shape: [-1] },
        },
      }),
    ).toThrow(/unreadable element dtype/);
  });
});

describe("parseNdarrayDataType (zagg-ragged/2 typed dtype)", () => {
  it("reads the typed declaration and ignores other data types", () => {
    expect(parseNdarrayDataType(V2_DTYPE)).toEqual({
      dtype: "float32",
      innerShape: [2],
    });
    expect(parseNdarrayDataType("float32")).toBeNull();
    expect(parseNdarrayDataType({ name: "bytes" })).toBeNull();
  });

  it("is loud on a malformed configuration", () => {
    expect(() => parseNdarrayDataType({ name: "ndarray" })).toThrow(
      /lacks a configuration/,
    );
    expect(() =>
      parseNdarrayDataType({
        name: "ndarray",
        configuration: { dtype: "float32", shape: [2, null] },
      }),
    ).toThrow(/\[null, \.\.\.innerShape\]/);
  });
});

describe("raggedElementOf (revision dispatch)", () => {
  it("dispatches /2 by data type and /1 by attrs", () => {
    expect(raggedElementOf({ data_type: V2_DTYPE, attributes: {} })).toEqual({
      dtype: "float32",
      innerShape: [2],
    });
    for (const dt of ["variable_length_bytes", "bytes", { name: "bytes" }]) {
      expect(raggedElementOf({ data_type: dt, attributes: V1_ATTRS })).toEqual({
        dtype: "float32",
        innerShape: [2],
      });
    }
  });

  it("refuses a dense data type", () => {
    expect(() =>
      raggedElementOf(
        { data_type: "uint64", attributes: V1_ATTRS },
        "6/morton",
      ),
    ).toThrow(/6\/morton has data type "uint64"/);
  });
});
