/** The fetch Range store against a real HTTP server over the fixtures. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLeaf } from "../../src/leaf/leaf.js";
import { HttpStore } from "../../src/store/http.js";
import { SPEC_ROOT, expected, f32 } from "../helpers/spec.js";
import { type Served, serve } from "../helpers/serve.js";

let served: Served;
beforeAll(async () => {
  served = await serve(`${SPEC_ROOT}minimal`);
});
afterAll(() => served.close());

describe("HttpStore", () => {
  it("resolves keys under the base URL and returns undefined on 404", async () => {
    const store = new HttpStore(served.url);
    expect(store.resolve("/a/b").href).toBe(`${served.url}a/b`);
    expect(await store.get("/missing")).toBeUndefined();
    expect(
      await store.getRange("/missing", { suffixLength: 4 }),
    ).toBeUndefined();
  });

  it("reads a leaf with ranged requests only against the shard object", async () => {
    const exp = expected("minimal");
    const store = new HttpStore(served.url);
    const leaf = await openLeaf(store, exp.leaf);
    const digests = await leaf.ragged("h_tdigest");
    served.log.length = 0;
    const cell = await digests.readCell(0);
    expect(cell.data).toEqual(f32(exp.cells[0].h_tdigest as number[][]));
    expect(served.log).toEqual([
      [`/${exp.leaf}/6/h_tdigest/c/0`, "bytes=-68"],
      [`/${exp.leaf}/6/h_tdigest/c/0`, "bytes=0-144"],
    ]);
    // The dense path (zarrita's sharded getter) is ranged too.
    served.log.length = 0;
    const count = await leaf.readDense("count");
    expect(Array.from(count.data as Int32Array)[15]).toBe(300);
    const objectReads = served.log.filter(([path]) => path.endsWith("/c/0"));
    expect(objectReads.length).toBeGreaterThan(0);
    expect(objectReads.every(([, range]) => range !== null)).toBe(true);
  });

  it("slices the window itself when an origin ignores the Range header", async () => {
    const store = new HttpStore(served.url, {
      fetch: async (request) => {
        const full = await fetch(new Request(request.url));
        return new Response(await full.arrayBuffer(), { status: 200 });
      },
    });
    const exp = expected("minimal");
    const key = `/${exp.leaf}/6/h_tdigest/c/0` as const;
    const suffix = await store.getRange(key, { suffixLength: 68 });
    const window = await store.getRange(key, { offset: 203, length: 146 });
    expect(suffix?.byteLength).toBe(68);
    expect(window?.byteLength).toBe(146);
  });
});
