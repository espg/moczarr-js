# moczarr-js

[![Zarrita.js](https://img.shields.io/badge/Zarrita.js-Compatible-EE3F98)](https://github.com/manzt/zarrita.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/espg/moczarr-js/blob/main/LICENSE)

Browser/TypeScript reader for the parts of a **morton-hive** zarr store a
client needs, the sibling of [moczarr](https://github.com/espg/moczarr)
(Python, the reference implementation) for stores written by
[zagg](https://github.com/englacial/zagg).

- Pure TypeScript, works in browsers and Node.js 20+
- zarrita-compatible: any store with `get` + `getRange` (zarrita's
  `FetchStore`, [icechunk-js](https://github.com/EarthyScience/icechunk-js),
  the bundled `HttpStore`) works; zarrita itself is an optional peer
- Reads the **leaves it is pointed at** — presenting a whole hive as one
  zarr is the icechunk virtual-manifest route, not this package's job

## Getting Started

Not yet published to npm; install from the repository until the first
release:

```bash
npm install github:espg/moczarr-js zarrita
```

`zarrita` is an optional peer — the package needs it only for the dense
path (`leaf.dense` / `leaf.readDense`, imported lazily); hive arithmetic,
the vlen decode and the ragged store-direct reads work without it.

```typescript
import {
  HttpStore,
  openLeaf,
  parseHiveManifest,
  leafPath,
  digestFromCell,
  chunkZRange,
  binEdges,
  castToBins,
} from "moczarr-js";

const store = new HttpStore("https://example.com/product.zarr/");

// 1. hive arithmetic: manifest -> leaf path, zero listings
const manifest = parseHiveManifest(
  JSON.parse(new TextDecoder().decode(await store.get("/morton_hive.json"))),
);
const path = leafPath(manifest, "3213244424"); // "3/2/1/3/2/4/4/4/2/4/3213244424.zarr"

// 2. the leaf: dense arrays through zarrita, ragged arrays store-direct
const leaf = await openLeaf(store, path, { manifest });
const counts = await leaf.readDense("count", [0, 4096]); // one inner chunk
const digests = await leaf.ragged("h_tdigest_signal");
const cells = await digests.readChunk(0); // (n, 2) float32 per cell

// 3. the t-digest cast: one shared z-window, (cells, bins) histogram
const all = cells.map(digestFromCell);
const window = chunkZRange(all, { nBins: 128, resolution: 0.5 });
const tensor = castToBins(
  all,
  binEdges(window.zLo, window.resolution, window.nBins),
);
```

### For Development

```bash
npm install
npm run typecheck
npm run lint      # eslint + prettier --check
npm test          # vitest
npm run build     # tsc -> dist/
```

The integration smoke against the public demo store is opt-in:
`MOCZARR_JS_INTEGRATION=1 npm test -- tests/integration` (a few KB of
metadata plus two inner chunks; never bulk).

## The three entry points

### Hive arithmetic (mortie spec v1.0 §2, §4, §6, §7)

`parseHiveManifest`, `leafPath` / `splitLeafName` / `shardIdFromPath`,
`parseRootCoverage` / `rangesShardIds` / `rangesContain` /
`coveredLeafPaths`, and the decimal id grammar (`parseMortonDecimal`,
`renderMortonDecimal`, `decimalOrder`, `decimalRank`, ...). With the manifest
and the root `coverage.moc` every leaf path is computable arithmetically —
no object listing. Ported from the gridlook fork's `src/lib/morton/` with its
goldens intact.

### vlen-ndarray decode (zagg spec §1 and §6)

The `zagg-ragged/1` wire framing (`u32le` cell count, then per cell `u32le`
length + little-endian payload, zstd-3 compressed per chunk) and its
byte-identical typed successor `zagg-ragged/2` (`ndarray` data type +
`vlen-ndarray` codec, [zarr-vlen-ndarray](https://github.com/espg/zarr-vlen-ndarray)):

- `decodeRaggedChunk(bytes, element)` — standalone: zstd → frames → typed
  `(n, ...innerShape)` cells, no zarrita needed;
- `raggedElementOf(zarrJson)` — the element declaration from either
  revision's metadata, strict at the gate;
- `registerVlenCodecs(zarr.registry)` — a zarrita codec under both
  `vlen-ndarray` and `vlen-bytes`, modelled on zarrita's `vlen-utf8`. zarrita
  0.7's `DataType` union is closed, so these arrays cannot yet open through
  `zarrita.open`; the codec is the upstream-ready piece, and the leaf reader
  below is the working path.

### Store-direct leaf reader (zagg spec §1.5)

`openLeaf(store, leafPath, { manifest | cellOrder })` → `Leaf`. Dense arrays
(`morton` uint64, `count` int32, `composition` uint64) open through zarrita
(`leaf.dense(field)` / `leaf.readDense(field, [start, stop])`). Ragged arrays
read store-direct (`leaf.ragged(field)` → `RaggedArray`): the shard index
suffix (`16·K + 4` bytes at `index_location: end`, crc32c-checked, `2^64 − 1`
sentinel = absent chunk), one ranged read per inner chunk, zstd + vlen
decode. The unsharded per-chunk geometry reads through the same path.
`HttpStore` is a plain `fetch` Range store for public buckets and tests.

### t-digest cast (zagg spec §2)

`cdfFromTdigest`, `quantileFromTdigest`, `binDigest`, `chunkZRange` and
`castToBins(digests, edges)` — the browser twin of
`moczarr.hhdc.read_tensors`' per-block step: one shared z-window, CDF at the
bin edges, `(cells, bins)` counts. What a bin value _means_ is the payload's
§2.0 `weights` declaration (`RaggedArray.metadata.weights`): an observation
count under `counts`, a photoelectron estimate under `flux`.

## Boundaries

- **healpix-geo** owns cell ids and geometry. The packed-word codec in
  `src/codec/word.ts` is internal and slated for replacement by healpix-geo's
  `morton` scheme once released; it is not exported.
- **icechunk-js** owns the hive-as-one-zarr view (virtual manifests). This
  package reads leaves; an icechunk store satisfies its store contract.

## Parity

- Hive arithmetic: the gridlook tests' goldens (derived from moczarr's
  `test_convention` / `test_ranges` / `test_fabricate` with mortie) plus the
  shim-parity fixtures over moczarr's `fabricate_cell_ids` ground truth.
- vlen framing: byte vectors written by zarr-vlen-ndarray (golden framing
  incl. the empty element, seeded float32/uint64 cells, raw and through
  zstd-3), regenerable with `scripts/generate_vlen_fixtures.py`.
- Leaf reads: zagg's §7 conformance fixtures (`tests/data/spec/`) —
  `minimal/`, `kitchen_sink/` (both strata with their located siblings),
  `flux/` (the §2.0 `weights` / `gain` declaration) and `column/` — with
  every populated cell of the ragged arrays those cases read byte-exact
  against the committed `*.expected.json`.
- t-digest kernels: `moczarr.tdigest` / `moczarr.hhdc` outputs over those
  same digests plus edge cases, asserted to 1e-6 relative (observed
  ≤ 1e-12; the residual is numpy's FMA contraction), regenerable with
  `scripts/generate_tdigest_fixtures.py`.

The Python package stays the reference; this one follows it.

## License

MIT
