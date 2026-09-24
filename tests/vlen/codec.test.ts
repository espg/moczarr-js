import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import {
  VLEN_BYTES_CODEC,
  VLEN_NDARRAY_CODEC,
  VlenNdarrayCodec,
  registerVlenCodecs,
} from "../../src/vlen/codec.js";
import type { RaggedCell } from "../../src/vlen/element.js";

const goldens = JSON.parse(
  readFileSync(new URL("../data/vlen_goldens.json", import.meta.url), "utf8"),
) as { cases: Record<string, { raw_hex: string; shape_per_cell: number[][] }> };

const GOLDEN = Uint8Array.from(
  Buffer.from(goldens.cases.golden_framing.raw_hex, "hex"),
);
const NDARRAY_F32X2 = {
  name: "ndarray",
  configuration: { dtype: "float32", shape: [null, 2] },
};

describe("VlenNdarrayCodec", () => {
  it("decodes typed cells when the data type is the ndarray extension", () => {
    const codec = VlenNdarrayCodec.fromConfig(
      {},
      { dataType: NDARRAY_F32X2, shape: [3] },
    );
    const chunk = codec.decode(GOLDEN);
    expect(chunk.shape).toEqual([3]);
    expect(chunk.stride).toEqual([1]);
    const cells = chunk.data as RaggedCell[];
    expect(cells.map((c) => c.shape)).toEqual(
      goldens.cases.golden_framing.shape_per_cell,
    );
    expect(Array.from(cells[2].data as Float32Array)).toEqual([5.5, 6.5]);
  });

  it("takes the element off the codec configuration (the pipeline route)", () => {
    // What zarrita actually passes: the configuration verbatim, and its own
    // parsed DataType string rather than the raw ndarray JSON.
    const codec = VlenNdarrayCodec.fromConfig(
      { dtype: "float32", shape: [null, 2] },
      { dataType: "variable_length_bytes", shape: [3] },
    );
    expect(codec.element).toEqual({ dtype: "float32", innerShape: [2] });
    const cells = codec.decode(GOLDEN).data as RaggedCell[];
    expect(Array.from(cells[2].data as Float32Array)).toEqual([5.5, 6.5]);
  });

  it("refuses a malformed element on the configuration route", () => {
    expect(() =>
      VlenNdarrayCodec.fromConfig(
        { dtype: "float32", shape: [2] },
        { dataType: "variable_length_bytes", shape: [3] },
      ),
    ).toThrow(/declares element shape \[2\]/);
  });

  it("decodes raw payload bytes under variable_length_bytes (the /1 dtype)", () => {
    const codec = VlenNdarrayCodec.fromConfig(
      {},
      { dataType: "variable_length_bytes", shape: [3] },
    );
    const chunk = codec.decode(GOLDEN);
    const cells = chunk.data as Uint8Array[];
    expect(cells.map((c) => c.byteLength)).toEqual([16, 0, 8]);
  });

  it("takes an explicit element for a /1 array (attrs are outside the pipeline)", () => {
    const codec = new VlenNdarrayCodec([3], {
      dtype: "float32",
      innerShape: [2],
    });
    const cells = codec.decode(GOLDEN).data as RaggedCell[];
    expect(cells[0].data).toBeInstanceOf(Float32Array);
  });

  it("reports an element-count mismatch against the chunk shape", () => {
    const codec = new VlenNdarrayCodec([4]);
    expect(() => codec.decode(GOLDEN)).toThrow(
      /chunk shape \[4\]: vlen chunk frames 3 cells, not the 4/,
    );
  });

  it("refuses to encode", () => {
    expect(() => new VlenNdarrayCodec([1]).encode()).toThrow(/encode/);
  });
});

describe("registerVlenCodecs on zarrita's registry", () => {
  it("installs both names as lazy codec entries", async () => {
    registerVlenCodecs(zarr.registry);
    for (const name of [VLEN_NDARRAY_CODEC, VLEN_BYTES_CODEC]) {
      const loader = zarr.registry.get(name);
      expect(loader).toBeDefined();
      const entry = (await loader!()) as typeof VlenNdarrayCodec;
      expect(entry.fromConfig).toBe(VlenNdarrayCodec.fromConfig);
    }
  });
});
