/**
 * Morton-hive store arithmetic (mortie spec v1.0 section 6): leaf paths,
 * leaf-name splitting, and D19 product-root discovery -- pure functions
 * over ids, manifests, and listings; the fetch layer arrives with phase 6c.
 *
 * Path components chunk the digit tail per the manifest's `path_grouping`
 * as the ONLY path-construction code path (issue #1 phase-6 amendment):
 * the constant-width {sign+base} component first, then `path_grouping`
 * digits per component with leading components full-width and the LAST
 * carrying the remainder -- component boundaries are ancestor prefixes
 * shared by deeper shards regardless of their order.
 */

import type { HiveManifest } from "./manifest.js";
import { MANIFEST_NAME } from "./manifest.js";

/** Frozen window-label charset (no `_`, so leaf names split unambiguously). */
const LABEL_RE = /^[0-9A-Za-z-]{1,32}$/;

/** Unmarked decimal-id grammar -- paths never carry the "p" kind suffix. */
const PATH_ID_RE = /^(-?[1-6])([1-4]*)$/;

/**
 * Product-name grammar (spec section 6.5): [a-z0-9_-]{1,192}, minus the
 * base-component exclusion (-?[1-6]) so child classification at a product
 * root stays unambiguous.
 */
const PRODUCT_NAME_RE = /^[a-z0-9_-]{1,192}$/;

/** Whether `name` is a {sign+base}-shaped hive root child. */
export function isBaseComponent(name: string): boolean {
  return /^-?[1-6]$/.test(name);
}

/** Whether `name` is a legal product-root child name (spec section 6.5). */
export function isProductName(name: string): boolean {
  return PRODUCT_NAME_RE.test(name) && !isBaseComponent(name);
}

/** Validate a window label against the frozen charset; returns it. */
export function validateLabel(label: string): string {
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `window label ${JSON.stringify(label)} does not match the frozen ` +
        `grammar (${LABEL_RE.source}; morton-hive/2)`,
    );
  }
  return label;
}

/**
 * The digit-tree path components of a shard id: {sign+base}, then the digit
 * tail chunked `pathGrouping` per component (leading full-width, last
 * remainder). Rejects marked ("p") or malformed ids -- paths carry the
 * unmarked area grammar only.
 */
export function hiveComponents(
  shardId: string,
  pathGrouping: number,
): string[] {
  const m = PATH_ID_RE.exec(shardId);
  if (!m) {
    throw new Error(
      `malformed shard id ${JSON.stringify(shardId)} for a hive path`,
    );
  }
  if (!Number.isInteger(pathGrouping) || pathGrouping < 1) {
    throw new Error(
      `path_grouping must be a positive integer (got ${pathGrouping})`,
    );
  }
  const [, base, tail] = m;
  const components = [base];
  for (let i = 0; i < tail.length; i += pathGrouping) {
    components.push(tail.slice(i, i + pathGrouping));
  }
  return components;
}

/**
 * The leaf zarr basename for a shard under a manifest: version /3 names by
 * window alone (`{window}.zarr`, the reserved `all` for schedule none); /1
 * and /2 carry the full id (`{full_id}.zarr` / `{full_id}_{window}.zarr`).
 */
export function leafName(
  manifest: HiveManifest,
  shardId: string,
  window?: string | null,
): string {
  if (manifest.version === 3) {
    return `${window === undefined || window === null ? "all" : validateLabel(window)}.zarr`;
  }
  if (window === undefined || window === null) {
    return `${shardId}.zarr`;
  }
  return `${shardId}_${validateLabel(window)}.zarr`;
}

/**
 * Store-relative hive path of a shard's leaf zarr, computed arithmetically
 * from the manifest (path_grouping chunking + version-specific basename).
 */
export function leafPath(
  manifest: HiveManifest,
  shardId: string,
  window?: string | null,
): string {
  const components = hiveComponents(shardId, manifest.pathGrouping);
  return `${components.join("/")}/${leafName(manifest, shardId, window)}`;
}

/**
 * `{fullId, window}` from a /1 or /2 leaf basename -- split on the FIRST
 * `_` (morton ids never contain one and window labels cannot, by charset).
 * Throws on a non-.zarr name or a malformed label. /3 basenames carry no
 * id -- recover those with shardIdFromPath.
 */
export function splitLeafName(name: string): {
  fullId: string;
  window: string | null;
} {
  if (!name.endsWith(".zarr")) {
    throw new Error(`${JSON.stringify(name)} is not a leaf zarr name`);
  }
  const stem = name.slice(0, -".zarr".length);
  const sep = stem.indexOf("_");
  if (sep === -1) {
    return { fullId: stem, window: null };
  }
  return {
    fullId: stem.slice(0, sep),
    window: validateLabel(stem.slice(sep + 1)),
  };
}

/**
 * The shard id a leaf path encodes, recovered from its digit components
 * (the concatenation invariant; how /3 leaves, named by window alone, get
 * their id back). Works for any path_grouping.
 */
export function shardIdFromPath(relPath: string): string {
  const parts = relPath.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts[parts.length - 1].endsWith(".zarr")) {
    throw new Error(`${JSON.stringify(relPath)} is not a hive leaf path`);
  }
  const [head, ...digits] = parts.slice(0, -1);
  const id = head + digits.join("");
  if (
    !isBaseComponent(head) ||
    !PATH_ID_RE.test(id) ||
    digits.some((d) => d === "")
  ) {
    throw new Error(
      `path ${JSON.stringify(relPath)} violates the hive node invariant`,
    );
  }
  return id;
}

/** D19 product-root discovery result: a bare store, or a product directory. */
export type RootClassification =
  { kind: "store" } | { kind: "products"; products: string[] };

/**
 * Classify a store-root listing (D19, spec section 6.5). Readers decide by
 * content: a manifest object at the root means a bare single-product store;
 * otherwise name-shaped child prefixes are the product entries (each a
 * complete morton-hive store). Non-conforming names are ignored per the
 * node invariant; a root with neither form is not a morton-hive root.
 */
export function classifyStoreRoot(
  objectNames: string[],
  childPrefixes: string[],
): RootClassification {
  if (objectNames.includes(MANIFEST_NAME)) {
    return { kind: "store" };
  }
  const products = childPrefixes
    .map((name) => name.replace(/\/+$/, ""))
    .filter(isProductName)
    .sort();
  if (products.length === 0) {
    throw new Error(
      `not a morton-hive root: no ${MANIFEST_NAME} object and no product-shaped children`,
    );
  }
  return { kind: "products", products };
}
