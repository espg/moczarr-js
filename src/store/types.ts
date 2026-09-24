/**
 * The store contract, structurally identical to zarrita's `AsyncReadable`
 * (declared here, as icechunk-js does, so the package never imports
 * zarrita at runtime -- it stays an optional peer). Any zarrita store with
 * `getRange` (FetchStore, icechunk-js's IcechunkStore, ...) satisfies it.
 */

export type AbsolutePath<Rest extends string = string> = `/${Rest}`;

export type RangeQuery =
  { offset: number; length: number } | { suffixLength: number };

export interface GetOptions {
  signal?: AbortSignal;
}

export interface AsyncReadable {
  get(key: AbsolutePath, opts?: GetOptions): Promise<Uint8Array | undefined>;
  getRange?(
    key: AbsolutePath,
    range: RangeQuery,
    opts?: GetOptions,
  ): Promise<Uint8Array | undefined>;
}

/** A store whose `getRange` is present -- what sharded reads need. */
export interface RangeReadable extends AsyncReadable {
  getRange(
    key: AbsolutePath,
    range: RangeQuery,
    opts?: GetOptions,
  ): Promise<Uint8Array | undefined>;
}

/** Join store-relative path components into an `AbsolutePath`. */
export function absolutePath(...parts: string[]): AbsolutePath {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
  return `/${joined}`;
}
