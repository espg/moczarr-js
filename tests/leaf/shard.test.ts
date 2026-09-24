import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { crc32c } from "../../src/leaf/crc32c.js";
import { parseShardIndex, shardIndexBytes } from "../../src/leaf/shard.js";
import { SPEC_ROOT } from "../helpers/spec.js";

const SHARD = new Uint8Array(
  readFileSync(`${SPEC_ROOT}minimal/1/1/2/1/3/11213.zarr/6/h_tdigest/c/0`),
);

describe("crc32c", () => {
  it("matches the Castagnoli check vector", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });
});

describe("parseShardIndex (spec section 1.5)", () => {
  it("reads the minimal fixture's K=4 index: chunk 2 absent, three spans", () => {
    const suffix = SHARD.subarray(SHARD.byteLength - shardIndexBytes(4));
    const spans = parseShardIndex(suffix, 4);
    expect(spans).toEqual([
      { offset: 0, nbytes: 145 },
      { offset: 145, nbytes: 58 },
      null,
      { offset: 203, nbytes: 146 },
    ]);
    // The spans tile the object body exactly (index at the end).
    expect(203 + 146).toBe(SHARD.byteLength - shardIndexBytes(4));
  });

  it("is loud on a corrupt checksum or a wrong-K suffix", () => {
    const suffix = SHARD.slice(SHARD.byteLength - shardIndexBytes(4));
    suffix[3] ^= 0x01;
    expect(() => parseShardIndex(suffix, 4)).toThrow(/crc32c mismatch/);
    expect(() => parseShardIndex(suffix, 3)).toThrow(/K=3 needs 52/);
  });
});
