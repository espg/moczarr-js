/**
 * The spec section 2.0 declaration gate on a ragged payload's attrs:
 * `counts` and `flux` are what the section defines, an absent key reads as
 * `counts`, and anything else is refused rather than read under a guess.
 */
import { describe, expect, it } from "vitest";

import { parseRaggedMetadata } from "../../src/leaf/metadata.js";

function meta(attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [4],
    data_type: "variable_length_bytes",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [4] } },
    codecs: [{ name: "vlen-bytes" }, { name: "zstd" }],
    attributes: {
      ragged: {
        spec: "zagg-ragged/1",
        element: { dtype: "float32", shape: [-1, 2] },
      },
      ...attributes,
    },
  };
}

describe("parseRaggedMetadata weights / gain", () => {
  it("reads an absent declaration as counts with no gain", () => {
    const parsed = parseRaggedMetadata(meta({}), "6/h_tdigest");
    expect(parsed.weights).toBe("counts");
    expect(parsed.gain).toBeNull();
  });

  it("surfaces the flux declaration and its gain block", () => {
    const gain = { name: "spec-fixture-gain", version: "1" };
    const parsed = parseRaggedMetadata(
      meta({ weights: "flux", gain }),
      "6/rx_flux",
    );
    expect(parsed.weights).toBe("flux");
    expect(parsed.gain).toEqual(gain);
  });

  it("refuses an unknown declaration", () => {
    expect(() =>
      parseRaggedMetadata(meta({ weights: "photons" }), "6/rx_flux"),
    ).toThrow(/declares weights "photons"/);
  });
});
