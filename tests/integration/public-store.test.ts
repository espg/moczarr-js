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
 * chunk. Nothing else.
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

describe.skipIf(!enabled)("public demo store (integration)", () => {
  it("reads one leaf's count chunk and one ragged chunk with ranged GETs", async () => {
    const requests: [string, string | null][] = [];
    const store = new HttpStore(STORE_URL, {
      fetch: (request) => {
        requests.push([
          new URL(request.url).pathname,
          request.headers.get("range"),
        ]);
        return fetch(request);
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

    // Every object read was ranged; the index suffix is exactly 4,100 bytes.
    const objectReads = requests.filter(([path]) => /\/c\/\d+$/.test(path));
    expect(objectReads.length).toBe(4);
    expect(objectReads.every(([, range]) => range !== null)).toBe(true);
    expect(objectReads.filter(([, r]) => r === "bytes=-4100")).toHaveLength(2);
    console.log(
      JSON.stringify({
        chunk: k,
        populatedCells: populated.length,
        window,
        requests,
      }),
    );
  });
});
