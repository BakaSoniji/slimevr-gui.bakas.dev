// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, extname } from "path";

/** Vite plugin that serves built GUI versions from serve-root/ during dev. */
function serveGuiVersions() {
  const serveDir = resolve("serve-root");
  return {
    name: "serve-gui-versions",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";

        // Only handle versioned paths (e.g. /0.16.0/...)
        const match = pathname.match(/^\/(\d+\.\d+[^/]*)\/(.*)/);
        if (!match) return next();

        const [, version, rest] = match;

        // Try exact file
        const filePath = resolve(serveDir, version, rest);
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          const content = readFileSync(filePath);
          // Basic content-type detection
          const ext = extname(filePath);
          const types = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".otf": "font/otf",
            ".ttf": "font/ttf",
          };
          res.setHeader("Content-Type", types[ext] || "application/octet-stream");
          res.end(content);
          return;
        }

        // Directory index
        const indexPath = resolve(serveDir, version, rest, "index.html");
        if ((rest === "" || rest.endsWith("/")) && existsSync(indexPath)) {
          res.setHeader("Content-Type", "text/html");
          res.end(readFileSync(indexPath));
          return;
        }

        // SPA fallback: non-file paths → index.html
        if (!extname(rest)) {
          const fallback = resolve(serveDir, version, "index.html");
          if (existsSync(fallback)) {
            res.setHeader("Content-Type", "text/html");
            res.end(readFileSync(fallback));
            return;
          }
        }

        next();
      });
    },
  };
}

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [serveGuiVersions()],
  },
});
