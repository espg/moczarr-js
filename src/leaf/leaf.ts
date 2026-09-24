/**
 * `openLeaf(store, leafPath)`: one hive leaf zarr through any zarrita-style
 * store. Dense arrays (`morton` uint64, `count` int32, `composition`
 * uint64 -- `[bytes]` inside `sharding_indexed`) open through zarrita
 * normally; ragged arrays (`variable_length_bytes` + `[vlen-bytes, zstd]`)
 * read store-direct (`RaggedArray`). Arrays live under the cell-order
 * group (`19/count`), and the order comes from the caller (the manifest's
 * `cell_order`) or, failing that, from the leaf's commit stamp.
 *
 * zarrita is an optional peer, imported lazily on the dense path only.
 */

import type * as zarrita from "zarrita";

import type { HiveManifest } from "../hive/manifest.js";
import {
  type AbsolutePath,
  type AsyncReadable,
  type GetOptions,
  absolutePath,
} from "../store/types.js";
import { parseRaggedMetadata } from "./metadata.js";
import { RaggedArray } from "./ragged.js";

export interface OpenLeafOptions extends GetOptions {
  /** The manifest's cell order (the group name). */
  cellOrder?: number;
  /** Or the parsed manifest itself. */
  manifest?: HiveManifest;
}

/** A dense array read in full: zarrita's chunk-shaped typed data. */
export interface DenseValues<T = ArrayLike<number | bigint>> {
  data: T;
  shape: number[];
}

async function readJson(
  store: AsyncReadable,
  key: AbsolutePath,
  opts?: GetOptions,
): Promise<Record<string, unknown> | undefined> {
  const raw = await store.get(key, opts);
  return (
    raw &&
    (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>)
  );
}

function stampCellOrder(attrs: Record<string, unknown>): number | undefined {
  const stamp = attrs["morton_hive_commit"] as
    Record<string, unknown> | undefined;
  const coverage = stamp?.["coverage"] as Record<string, unknown> | undefined;
  const order = coverage?.["cell_order"];
  return typeof order === "number" && Number.isInteger(order)
    ? order
    : undefined;
}

export class Leaf {
  readonly store: AsyncReadable;
  /** Store-absolute leaf path, e.g. `/1/1/2/1/3/11213.zarr`. */
  readonly path: AbsolutePath;
  /** The leaf group's attributes (commit stamp, coverage box, ...). */
  readonly attrs: Record<string, unknown>;
  readonly cellOrder: number;
  readonly #metadata = new Map<string, Promise<Record<string, unknown>>>();

  constructor(
    store: AsyncReadable,
    path: AbsolutePath,
    attrs: Record<string, unknown>,
    cellOrder: number,
  ) {
    this.store = store;
    this.path = path;
    this.attrs = attrs;
    this.cellOrder = cellOrder;
  }

  /** The cell-order group name the arrays live under. */
  get group(): string {
    return String(this.cellOrder);
  }

  /** Store-absolute path of a field's array. */
  arrayPath(field: string): AbsolutePath {
    return absolutePath(this.path, this.group, field);
  }

  /** A field's parsed `zarr.json` (cached). */
  arrayMetadata(
    field: string,
    opts?: GetOptions,
  ): Promise<Record<string, unknown>> {
    let pending = this.#metadata.get(field);
    if (pending === undefined) {
      const key = absolutePath(this.arrayPath(field), "zarr.json");
      pending = readJson(this.store, key, opts).then((meta) => {
        if (meta === undefined) {
          throw new Error(
            `leaf ${this.path} has no array ${this.group}/${field}`,
          );
        }
        return meta;
      });
      pending.catch(() => this.#metadata.delete(field));
      this.#metadata.set(field, pending);
    }
    return pending;
  }

  /** A ragged (vlen) field, read store-direct. */
  async ragged(field: string, opts?: GetOptions): Promise<RaggedArray> {
    const meta = await this.arrayMetadata(field, opts);
    return new RaggedArray(
      this.store,
      this.arrayPath(field),
      parseRaggedMetadata(meta, `${this.group}/${field}`),
    );
  }

  /** A dense field as a zarrita `Array` (zarrita must be installed). */
  async dense(
    field: string,
    opts?: GetOptions,
  ): Promise<zarrita.Array<zarrita.DataType, AsyncReadable>> {
    const zarr = await import("zarrita");
    const location = zarr.root(this.store).resolve(this.arrayPath(field));
    return zarr.open.v3(location, { kind: "array", signal: opts?.signal });
  }

  /**
   * A dense field's values over the cell span `[start, stop)` (the whole
   * axis by default), via `zarrita.get` -- only the covering inner chunks
   * are fetched under `sharding_indexed`. `opts.signal` cancels the dense
   * half the same way it cancels a ragged read.
   */
  async readDense(
    field: string,
    span?: [number, number],
    opts?: GetOptions,
  ): Promise<DenseValues> {
    const zarr = await import("zarrita");
    const array = await this.dense(field, opts);
    const chunk = await zarr.get(
      array,
      span ? [zarr.slice(span[0], span[1])] : null,
      opts,
    );
    return {
      data: chunk.data as ArrayLike<number | bigint>,
      shape: chunk.shape,
    };
  }
}

/**
 * Open a leaf: read its group `zarr.json`, resolve the cell-order group,
 * and hand back a `Leaf` whose arrays are opened lazily per field.
 */
export async function openLeaf(
  store: AsyncReadable,
  leafPath: string,
  options: OpenLeafOptions = {},
): Promise<Leaf> {
  const path = absolutePath(leafPath);
  const meta = await readJson(store, absolutePath(path, "zarr.json"), options);
  if (meta === undefined) {
    throw new Error(`no leaf at ${path} (missing zarr.json)`);
  }
  if (meta["zarr_format"] !== 3 || meta["node_type"] !== "group") {
    throw new Error(`${path} is not a zarr v3 group`);
  }
  const attrs = (meta["attributes"] ?? {}) as Record<string, unknown>;
  const cellOrder =
    options.cellOrder ?? options.manifest?.cellOrder ?? stampCellOrder(attrs);
  if (cellOrder === undefined) {
    throw new Error(
      `${path}: cannot resolve the cell-order group; pass cellOrder (the manifest's ` +
        "cell_order) -- the leaf's commit stamp carries no coverage.cell_order",
    );
  }
  return new Leaf(store, path, attrs, cellOrder);
}
