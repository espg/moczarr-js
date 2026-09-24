/** A throwaway HTTP file server with Range support (206 / Content-Range). */
import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";

export interface Served {
  url: string;
  server: Server;
  /** `[path, Range header | null]` per request. */
  log: [string, string | null][];
  close(): Promise<void>;
}

export async function serve(root: string): Promise<Served> {
  const log: [string, string | null][] = [];
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(
      new URL(req.url ?? "/", "http://x").pathname,
    );
    const range = req.headers.range ?? null;
    log.push([path, range]);
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const body = await readFile(file);
    res.setHeader("Accept-Ranges", "bytes");
    if (range === null) {
      res.writeHead(200, { "Content-Length": size }).end(body);
      return;
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416).end();
      return;
    }
    let start: number;
    let end: number;
    if (m[1] === "") {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    server,
    log,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
