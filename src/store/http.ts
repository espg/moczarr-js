/**
 * A plain `fetch`-based store with HTTP Range reads -- enough to read a
 * public hive leaf from a bucket or a static file server, and the store the
 * tests use. Suffix ranges go out as `Range: bytes=-N` directly (S3-style
 * origins honour them; no HEAD round trip). A 404 is an absent key; a 206
 * carries the requested window; a 200 answer to a Range request means the
 * origin ignored the header and sent the whole object, in which case the
 * requested window is sliced out so the caller still gets the right bytes.
 */

import type {
  AbsolutePath,
  GetOptions,
  RangeQuery,
  RangeReadable,
} from "./types.js";

export interface HttpStoreOptions {
  /** Custom fetch (auth headers, presigning, request logging). */
  fetch?: (request: Request) => Promise<Response>;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export class HttpStore implements RangeReadable {
  readonly url: URL;
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #headers: Record<string, string>;

  constructor(url: string | URL, options: HttpStoreOptions = {}) {
    this.url = new URL(String(url));
    if (!this.url.pathname.endsWith("/")) {
      this.url.pathname += "/";
    }
    this.#fetch = options.fetch ?? ((request) => fetch(request));
    this.#headers = options.headers ?? {};
  }

  resolve(key: AbsolutePath): URL {
    const url = new URL(key.slice(1), this.url);
    url.search = this.url.search;
    return url;
  }

  async #request(
    key: AbsolutePath,
    headers: Record<string, string>,
    opts?: GetOptions,
  ): Promise<Response | undefined> {
    const request = new Request(this.resolve(key), {
      headers: { ...this.#headers, ...headers },
      signal: opts?.signal,
    });
    const response = await this.#fetch(request);
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(
        `GET ${request.url}: unexpected ${response.status} ${response.statusText}`,
      );
    }
    return response;
  }

  async get(
    key: AbsolutePath,
    opts?: GetOptions,
  ): Promise<Uint8Array | undefined> {
    const response = await this.#request(key, {}, opts);
    return response && new Uint8Array(await response.arrayBuffer());
  }

  async getRange(
    key: AbsolutePath,
    range: RangeQuery,
    opts?: GetOptions,
  ): Promise<Uint8Array | undefined> {
    const header =
      "suffixLength" in range
        ? `bytes=-${range.suffixLength}`
        : `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const response = await this.#request(key, { Range: header }, opts);
    if (!response) {
      return undefined;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) {
      return bytes;
    }
    // The origin ignored the Range header: slice the window out of the body.
    return "suffixLength" in range
      ? bytes.subarray(Math.max(0, bytes.byteLength - range.suffixLength))
      : bytes.subarray(range.offset, range.offset + range.length);
  }
}
