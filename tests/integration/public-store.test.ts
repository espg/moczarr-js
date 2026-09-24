/**
 * Integration smoke against the public Source Cooperative demo store
 * (reads explicitly cleared for this work: small metadata plus a couple of
 * chunks, never bulk). Skipped unless MOCZARR_JS_INTEGRATION=1.
 *
 *   MOCZARR_JS_INTEGRATION=1 npm test -- tests/integration
 *
 * Reads: morton_hive.json, the leaf's zarr.json, two array zarr.json
 * files, the count shard's 4,100-byte index suffix plus ONE 16 KiB inner
 * chunk, and the digest shard's index suffix plus ONE populated inner
 * chunk. Nothing else: the test asserts every object read came back 206
 * and that they sum under OBJECT_BYTE_BUDGET, so an origin that ignores
 * Range fails the test instead of quietly pulling a whole shard.
 */
import { describe, expect, it } from "vitest";

import { parseHiveManifest } from "../../src/hive/manifest.js";
import { leafPath, shardIdFromPath } from "../../src/hive/hive.js";
import { openLeaf } from "../../src/leaf/leaf.js";
import { HttpStore } from "../../src/store/http.js";
import {
  binEdges,
  castToBins,
  chunkZRange,
  digestFromCell,
  totalWeight,
} from "../../src/tdigest/tdigest.js";

const STORE_URL =
  "https://data.source.coop/englacial/zagg/demo/atl03_tdigest_o9_v2.zarr/";
const LEAF = "3/2/1/3/2/4/4/4/2/4/3213244424.zarr";
const enabled = process.env.MOCZARR_JS_INTEGRATION === "1";
/**
 * Hard ceiling on the object bytes this test may pull. The observed run
 * reads 78,556: 4,100 + 53,972 (the digest shard's index suffix and one
 * inner chunk) + 4,100 + 16,384 (the count shard's). A whole shard object
 * is orders of magnitude larger, so a fallback to a full-object read
 * cannot pass under this.
 */
const OBJECT_BYTE_BUDGET = 262_144;

interface Logged {
  path: string;
  range: string | null;
  status: number;
  bytes: number;
}

describe.skipIf(!enabled)("public demo store (integration)", () => {
  it("reads one leaf's count chunk and one ragged chunk with ranged GETs", async () => {
    const requests: Logged[] = [];
    const store = new HttpStore(STORE_URL, {
      fetch: async (request) => {
        const response = await fetch(request);
        requests.push({
          path: new URL(request.url).pathname,
          range: request.headers.get("range"),
          status: response.status,
          bytes: Number(response.headers.get("content-length") ?? 0),
        });
        return response;
      },
    });

    const manifestBytes = await store.get("/morton_hive.json");
    const manifest = parseHiveManifest(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
    );
    expect(manifest.cellOrder).toBe(19);
    expect(manifest.shardOrder).toBe(9);
    // The leaf path is arithmetic from the manifest + shard id.
    expect(leafPath(manifest, shardIdFromPath(LEAF))).toBe(LEAF);

    const leaf = await openLeaf(store, LEAF, { manifest });
    expect(leaf.group).toBe("19");

    const digests = await leaf.ragged("h_tdigest_signal");
    expect(digests.geometry).toMatchObject({
      sharded: true,
      cellsPerChunk: 4096,
      chunksPerObject: 256,
      length: 1048576,
    });
    expect(digests.metadata.locations).toBe("h_tdigest_signal_locations");

    // Pick the first populated inner chunk off the index suffix alone.
    const index = await digests.shardIndex(0);
    expect(index).toHaveLength(256);
    const k = index!.findIndex((span) => span !== null);
    expect(k).toBeGreaterThanOrEqual(0);

    const cells = await digests.readChunk(k);
    expect(cells).toHaveLength(4096);
    const populated = cells
      .map((cell, i) => [i, cell] as const)
      .filter(([, cell]) => cell.shape[0] > 0);
    expect(populated.length).toBeGreaterThan(0);

    // The same cells' counts, one inner chunk of the dense array.
    const start = k * 4096;
    const count = await leaf.readDense("count", [start, start + 4096]);
    expect(count.shape).toEqual([4096]);
    const counts = count.data as Int32Array;
    for (const [i, cell] of populated) {
      // Signal digests carry the signal stratum only: weight <= count.
      const digest = digestFromCell(cell);
      expect(totalWeight(digest)).toBeGreaterThan(0);
      expect(totalWeight(digest)).toBeLessThanOrEqual(counts[i]);
    }

    // The cast over the chunk: one shared window, (cells, bins) counts.
    const all = cells.map(digestFromCell);
    const window = chunkZRange(all, {
      nBins: 128,
      resolution: 0.5,
      fit: "degrade_resolution",
    });
    const binned = castToBins(
      all,
      binEdges(window.zLo, window.resolution, window.nBins),
    );
    expect(binned.shape).toEqual([4096, 128]);

    // Every object read was ranged *and answered ranged*: a 200 here means
    // the origin ignored the header and sent the whole object (HttpStore
    // slices the window out, so the read still succeeds -- silently pulling
    // a whole shard). Assert on the response, then on the bytes.
    const objectReads = requests.filter((r) => /\/c\/\d+$/.test(r.path));
    expect(objectReads.length).toBe(4);
    expect(objectReads.map((r) => r.range)).not.toContain(null);
    expect(objectReads.map((r) => r.status)).toEqual([206, 206, 206, 206]);
    expect(objectReads.filter((r) => r.range === "bytes=-4100")).toHaveLength(
      2,
    );
    const objectBytes = objectReads.reduce((n, r) => n + r.bytes, 0);
    expect(objectBytes).toBeGreaterThan(0);
    expect(objectBytes).toBeLessThanOrEqual(OBJECT_BYTE_BUDGET);
    console.log(
      JSON.stringify({
        chunk: k,
        populatedCells: populated.length,
        objectBytes,
        window,
        requests,
      }),
    );
  });
});
