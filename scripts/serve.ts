/**
 * Local development server with SPA fallback routing.
 * Mimics CloudFront behavior: serves static files, falls back to
 * /{version}/index.html for non-file paths under a version prefix.
 *
 * Usage: bun scripts/serve.ts --dir <serve-dir> [--port <port>]
 */

import { resolve, extname } from "path";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    dir: { type: "string" },
    port: { type: "string", default: "8765" },
  },
  strict: true,
});

if (!values.dir) {
  console.error("Usage: bun scripts/serve.ts --dir <serve-dir> [--port <port>]");
  process.exit(1);
}

const serveDir = resolve(values.dir);
const port = parseInt(values.port!);

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Try to serve the exact file
    let file = Bun.file(resolve(serveDir, pathname.slice(1)));
    if (await file.exists()) {
      return new Response(file);
    }

    // Try directory index (e.g. /0.16.3/ → /0.16.3/index.html)
    if (pathname.endsWith("/")) {
      const indexFile = Bun.file(resolve(serveDir, pathname.slice(1), "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile);
      }
    }

    // SPA fallback: for paths like /0.16.3/settings/trackers,
    // serve /0.16.3/index.html (mimics CloudFront function)
    const match = pathname.match(/^\/([^/]+)\/(.*)/);
    if (match && !extname(match[2])) {
      const fallback = Bun.file(resolve(serveDir, match[1], "index.html"));
      if (await fallback.exists()) {
        return new Response(fallback);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Serving ${serveDir} at http://localhost:${server.port}`);
