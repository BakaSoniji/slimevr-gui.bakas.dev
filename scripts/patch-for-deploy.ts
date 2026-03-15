/**
 * Patches the SlimeVR GUI source for static web deployment.
 *
 * Usage: bun scripts/patch-for-deploy.ts --gui-root <path> [--base-path <path>]
 *
 * Patches applied:
 * 1. Copies vite-base-path-plugin.ts into the GUI root
 * 2. Patches vite.config.ts to add base path + plugin + remove sentry
 * 3. Patches src/App.tsx to add Router basename for sub-path deployment
 * 4. Copies version-mismatch-hook.tsx into GUI src/
 * 5. Patches src/hooks/websocket-api.ts to emit raw message events
 * 6. Patches src/components/TopBar.tsx to inject VersionMismatchIndicator
 *
 * Asset prefixes are derived from top-level directories in gui/public/.
 */

import { resolve } from "path";
import { readdirSync, statSync } from "fs";
import { parseArgs } from "util";
import { detectBuildFlavor } from "./detect-build-flavor";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "gui-root": { type: "string" },
    "base-path": { type: "string", default: "/" },
  },
  strict: true,
});

const guiRoot = values["gui-root"];
const basePath = values["base-path"]!;

if (!guiRoot) {
  console.error(
    "Usage: bun scripts/patch-for-deploy.ts --gui-root <path> [--base-path <path>]",
  );
  process.exit(1);
}

console.log(`Patching GUI at: ${guiRoot}`);
console.log(`Base path: ${basePath}`);

// Discover asset prefixes from public/ directory
const publicDir = resolve(guiRoot, "public");
const prefixes = readdirSync(publicDir)
  .filter((entry) => statSync(resolve(publicDir, entry)).isDirectory())
  .map((dir) => `/${dir}/`);

if (prefixes.length === 0) {
  console.error("FAIL: No directories found in public/. Nothing to rewrite.");
  process.exit(1);
}

console.log(`Discovered prefixes: ${prefixes.join(", ")}`);

// 1. Copy vite-base-path-plugin.ts into GUI root
const pluginSrc = resolve(import.meta.dir, "vite-base-path-plugin.ts");
const pluginDst = resolve(guiRoot, "vite-base-path-plugin.ts");
await Bun.write(pluginDst, Bun.file(pluginSrc));
console.log("Copied vite-base-path-plugin.ts");

// 2. Patch vite.config.ts
const viteConfigPath = resolve(guiRoot, "vite.config.ts");
let viteConfig = await Bun.file(viteConfigPath).text();
const originalViteConfig = viteConfig;

// Add import for basePathRewrite at the top
viteConfig = `import { basePathRewrite } from './vite-base-path-plugin';\n${viteConfig}`;

// Remove sentry import (auth token not available in CI, and we shouldn't
// send telemetry to SlimeVR's Sentry from a third-party deployment)
viteConfig = viteConfig.replace(
  /import\s*\{\s*sentryVitePlugin\s*\}\s*from\s*['"]@sentry\/vite-plugin['"];?\n?/,
  "",
);

// Remove sentryVitePlugin usage from plugins array
viteConfig = viteConfig.replace(/\s*sentryVitePlugin\(\{[^}]*\}\),?\n?/, "");

// Add base config to defineConfig
viteConfig = viteConfig.replace(
  "export default defineConfig({",
  `export default defineConfig({\n  base: process.env.BASE_PATH || '/',`,
);

// Add basePathRewrite() to plugins array with discovered prefixes
const prefixesLiteral = JSON.stringify(prefixes);
viteConfig = viteConfig.replace(
  "plugins: [",
  `plugins: [\n    basePathRewrite(${prefixesLiteral}),`,
);

// Validate patches took effect
if (!viteConfig.includes("basePathRewrite(")) {
  console.error(
    "FAIL: basePathRewrite plugin was not injected into vite.config.ts.",
  );
  process.exit(1);
}

if (!viteConfig.includes("base: process.env.BASE_PATH")) {
  console.error("FAIL: base path config was not injected into vite.config.ts.");
  process.exit(1);
}

await Bun.write(viteConfigPath, viteConfig);
console.log("Patched vite.config.ts");

// 3. Patch src/App.tsx - add basename to Router
const appTsxPath = resolve(guiRoot, "src", "App.tsx");
let appTsx = await Bun.file(appTsxPath).text();
const originalAppTsx = appTsx;

const flavor = await detectBuildFlavor(resolve(guiRoot, ".."));

if (flavor.router === "hash") {
  // HashRouter (v19+): hash-based routing works without basename or SPA fallback
  console.log("HashRouter detected — no Router patch needed");
} else {
  // BrowserRouter (v0.5–v18): needs basename for sub-path deployment
  appTsx = appTsx.replace(
    "<Router>",
    `<Router basename={import.meta.env.BASE_URL.replace(/\\/$/, '')}>`,
  );

  if (appTsx === originalAppTsx) {
    console.error(
      "FAIL: src/App.tsx was not modified. <Router> pattern may not match this version.",
    );
    process.exit(1);
  }
}

if (appTsx !== originalAppTsx) {
  await Bun.write(appTsxPath, appTsx);
  console.log("Patched src/App.tsx");
}

// Write discovered prefixes for downstream scripts (verify-paths)
const prefixesPath = resolve(guiRoot, ".asset-prefixes.json");
await Bun.write(prefixesPath, JSON.stringify(prefixes));
console.log(`Wrote ${prefixes.length} prefixes to .asset-prefixes.json`);

// 4. Copy version-mismatch-hook.tsx and its dependency into GUI src/
// Both files are copied as siblings so Vite resolves the import naturally.
const mismatchSrc = resolve(import.meta.dir, "version-mismatch-hook.tsx");
const probeSrc = resolve(import.meta.dir, "..", "src", "lib", "solarxr-probe.ts");

await Bun.write(resolve(guiRoot, "src", "solarxr-probe.ts"), Bun.file(probeSrc));

let hookCode = await Bun.file(mismatchSrc).text();
hookCode = hookCode.replace("../src/lib/solarxr-probe", "./solarxr-probe");
await Bun.write(resolve(guiRoot, "src", "version-mismatch-hook.tsx"), hookCode);
console.log("Copied version-mismatch-hook.tsx + solarxr-probe.ts");

// 5. Patch src/hooks/websocket-api.ts — emit raw binary + connected events
const wsApiPath = resolve(guiRoot, "src", "hooks", "websocket-api.ts");
let wsApi = await Bun.file(wsApiPath).text();
const originalWsApi = wsApi;

// Emit raw buffer after arrayBuffer() call for passive observation
wsApi = wsApi.replace(
  "const buffer = await event.data.arrayBuffer();",
  `const buffer = await event.data.arrayBuffer();\n` +
    `    window.dispatchEvent(new CustomEvent('slimevr:raw-message', { detail: buffer }));`,
);

// Emit connected event with WebSocket reference for probe sending
wsApi = wsApi.replace(
  "setConnected(true);",
  `setConnected(true);\n    window.dispatchEvent(new CustomEvent('slimevr:ws-connected', { detail: webSocketRef.current }));`,
);

if (wsApi === originalWsApi) {
  console.warn(
    "WARN: websocket-api.ts was not modified — version mismatch detection may not work.",
  );
} else {
  await Bun.write(wsApiPath, wsApi);
  console.log("Patched src/hooks/websocket-api.ts");
}

// 6. Patch src/components/TopBar.tsx — inject VersionMismatchIndicator after version pill
const topBarPath = resolve(guiRoot, "src", "components", "TopBar.tsx");
let topBar = await Bun.file(topBarPath).text();
const originalTopBar = topBar;

const guiVersion = basePath.replace(/\//g, "");
const indicatorJsx = `<VersionMismatchIndicator guiVersion="${guiVersion}" />`;

if (/VersionTag/.test(originalTopBar)) {
  // v0.8.0+: VersionTag is a separate component — insert indicator after <VersionTag>
  topBar = topBar.replace(
    /<VersionTag\s*(?:\/>|><\/VersionTag>)/,
    (match, offset) => {
      // Check if VersionTag is inside a JSX expression like {cond && <VersionTag />}
      // by looking for '&&' or '?' before it on the same line
      const lineStart = topBar.lastIndexOf("\n", offset) + 1;
      const before = topBar.slice(lineStart, offset);
      const needsFragment = /&&\s*$/.test(before) || /\?\s*$/.test(before);
      if (needsFragment) {
        return `<>${match}${indicatorJsx}</>`;
      }
      return `${match}\n                  ${indicatorJsx}`;
    },
  );
} else {
  // v0.5.0–v0.7.0: version pill is inline — insert indicator after the pill's closing </div>
  // Match the div containing text-status-success and its closing tag
  topBar = topBar.replace(
    /(<div\b[^>]*text-status-success[^>]*>[\s\S]*?<\/div>)/,
    (match) => `${match}\n          ${indicatorJsx}`,
  );
}

if (!topBar.includes("VersionMismatchIndicator")) {
  console.warn(
    "WARN: TopBar.tsx was not modified — version mismatch UI may not work.",
  );
} else {
  // Add import only if indicator was injected
  topBar = `import { VersionMismatchIndicator } from '../version-mismatch-hook';\n${topBar}`;
  await Bun.write(topBarPath, topBar);
  console.log("Patched src/components/TopBar.tsx");
}

console.log("All patches applied successfully.");
