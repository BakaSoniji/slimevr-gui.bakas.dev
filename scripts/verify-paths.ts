/**
 * Verifies that built output has no leaked absolute asset paths.
 *
 * Usage: bun scripts/verify-paths.ts <dist-dir> <base-path>
 * Example: bun scripts/verify-paths.ts gui/dist /0.18.2/
 *
 * Reads .asset-prefixes.json from the GUI root (written by patch-for-deploy.ts)
 * to know which prefixes to check, falling back to scanning public/ if not found.
 */

import { resolve, dirname } from "path";
import { readdirSync, statSync } from "fs";
import { Glob } from "bun";
import { parseArgs } from "util";

const { positionals } = parseArgs({
  args: Bun.argv.slice(2),
  strict: true,
  allowPositionals: true,
});

const distDir = positionals[0];
const basePath = positionals[1];

if (!distDir || !basePath) {
  console.error("Usage: bun scripts/verify-paths.ts <dist-dir> <base-path>");
  process.exit(1);
}

console.log(`Verifying paths in: ${distDir}`);
console.log(`Expected base path: ${basePath}`);

// Load prefixes from .asset-prefixes.json (written by patch-for-deploy.ts)
// or fall back to scanning the public/ directory
const guiRoot = resolve(distDir, "..");
const prefixesFile = Bun.file(resolve(guiRoot, ".asset-prefixes.json"));
let prefixes: string[];

if (await prefixesFile.exists()) {
  prefixes = await prefixesFile.json();
  console.log(`Loaded ${prefixes.length} prefixes from .asset-prefixes.json`);
} else {
  const publicDir = resolve(guiRoot, "public");
  prefixes = readdirSync(publicDir)
    .filter((entry) => statSync(resolve(publicDir, entry)).isDirectory())
    .map((dir) => `/${dir}/`);
  console.log(`Scanned ${prefixes.length} prefixes from public/`);
}

const quotes = ['"', "'", "`"];
let failed = false;

// Collect all relevant files and read their content once
const fileContents = new Map<string, string>();
const glob = new Glob("**/*.{html,js,css}");
for await (const path of glob.scan(distDir)) {
  const fullPath = resolve(distDir, path);
  fileContents.set(fullPath, await Bun.file(fullPath).text());
}

// Negative check: no bare absolute paths that aren't correctly prefixed
for (const prefix of prefixes) {
  const correctPrefix = `${basePath}${prefix.slice(1)}`;
  for (const [filePath, content] of fileContents) {
    // Search full content first, only split lines on match for reporting
    for (const quote of quotes) {
      const pattern = `${quote}${prefix}`;
      if (content.includes(pattern) && !content.includes(correctPrefix)) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern) && !lines[i].includes(correctPrefix)) {
            console.log(`FAIL: Leaked ${prefix} in ${filePath}:${i + 1}`);
            failed = true;
          }
        }
      }
    }
  }
}

// Positive check: at least some correctly prefixed paths exist
const checkPrefixes = prefixes.map((p) => `${basePath}${p.slice(1)}`);
const foundCorrect = [...fileContents.values()].some((content) =>
  checkPrefixes.some((p) => content.includes(p))
);

if (!foundCorrect) {
  console.log("FAIL: No correctly prefixed paths found. Plugin may not have worked.");
  failed = true;
}

if (failed) {
  console.log("Path verification FAILED");
  process.exit(1);
}

console.log("Path verification PASSED");
