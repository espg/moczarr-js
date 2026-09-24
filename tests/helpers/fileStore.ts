/** A Node file-backed store with ranged reads, for fixture-tree tests. */
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  AbsolutePath,
  RangeQuery,
  RangeReadable,
} from "../../src/store/types.js";

export class FileStore implements RangeReadable {
  readonly root: string;
  /** Every call, for request-count assertions: `[key, range | null]`. */
  readonly log: [string, RangeQuery | null][] = [];

  constructor(root: string) {
    this.root = root;
  }

  #file(key: AbsolutePath): string {
    return join(this.root, key.slice(1));
  }

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    this.log.push([key, null]);
    try {
      return new Uint8Array(await readFile(this.#file(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async getRange(
    key: AbsolutePath,
    range: RangeQuery,
  ): Promise<Uint8Array | undefined> {
    this.log.push([key, range]);
    let handle;
    try {
      handle = await open(this.#file(key), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      const size = (await stat(this.#file(key))).size;
      const offset =
        "suffixLength" in range
          ? Math.max(0, size - range.suffixLength)
          : range.offset;
      const length =
        "suffixLength" in range
          ? Math.min(range.suffixLength, size)
          : Math.min(range.length, size - offset);
      const out = new Uint8Array(length);
      const { bytesRead } = await handle.read(out, 0, length, offset);
      return out.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
