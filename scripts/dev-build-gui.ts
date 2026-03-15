/**
 * Builds a specific SlimeVR GUI version from an existing local repo.
 *
 * Uses git worktree to checkout the version tag without disturbing the
 * repo's working directory, applies deployment patches, builds, and
 * copies the output to serve-root/{version}/ for local testing.
 *
 * Usage: bun scripts/dev-build-gui.ts --version <version> --repo <path-to-SlimeVR-Server>
 *
 * The result can be served with:
 *   bun scripts/serve.ts --dir serve-root
 */

import { parseArgs } from "util";
import { resolve } from "path";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { $ } from "bun";
import { detectBuildFlavor } from "./detect-build-flavor";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string" },
    repo: { type: "string" },
  },
  strict: true,
});

if (!values.version || !values.repo) {
  console.error(
    "Usage: bun scripts/dev-build-gui.ts --version <version> --repo <path-to-SlimeVR-Server>"
  );
  process.exit(1);
}

const version = values.version;
const repo = resolve(values.repo);
const scriptsDir = import.meta.dir;
const projectRoot = resolve(scriptsDir, "..");
const serveRoot = resolve(projectRoot, "serve-root");
const basePath = `/${version}/`;

// Verify repo exists and has the tag
const tagCheck =
  await $`git tag -l v${version}`.cwd(repo).quiet().nothrow();
if (tagCheck.exitCode !== 0 || tagCheck.text().trim() === "") {
  console.error(`Tag v${version} not found in ${repo}`);
  console.error("Available tags matching this version:");
  await $`git tag -l "v${version}*"`.cwd(repo);
  process.exit(1);
}

// Create worktree in a temp directory
const worktree = await mkdtemp(resolve(tmpdir(), "slimevr-gui-build-"));
console.log(`Creating worktree at ${worktree} for v${version}...`);

async function cleanup() {
  console.log("Cleaning up worktree...");
  await $`git worktree remove --force ${worktree}`
    .cwd(repo)
    .nothrow()
    .quiet();
}

try {
  await $`git worktree add ${worktree} v${version}`.cwd(repo);

  // Init submodules in the worktree (needed for solarxr-protocol)
  console.log("Initializing submodules...");
  await $`git submodule update --init --recursive`.cwd(worktree);

  // Detect build flavor
  const flavor = await detectBuildFlavor(worktree);
  console.log(`Build flavor: ${flavor.packageManager} / ${flavor.buildTool} / ${flavor.router} router`);

  // Patch for deployment
  console.log("Applying deployment patches...");
  await $`bun ${resolve(scriptsDir, "patch-for-deploy.ts")} --gui-root ${resolve(worktree, "gui")} --base-path ${basePath}`;

  // Install dependencies
  console.log("Installing dependencies...");
  if (flavor.packageManager === "pnpm") {
    const install =
      await $`pnpm install --frozen-lockfile`.cwd(worktree).nothrow();
    if (install.exitCode !== 0) {
      await $`pnpm install`.cwd(worktree);
    }
  } else {
    await $`npm install`.cwd(worktree);
  }

  // Build solarxr-protocol
  console.log("Building solarxr-protocol...");
  await $`${flavor.packageManager} run update-solarxr`.cwd(worktree);

  // Build GUI — use vite directly for electron-vite projects (web deployment only)
  const guiDir = resolve(worktree, "gui");
  console.log("Building GUI...");
  if (flavor.buildTool === "electron-vite") {
    await $`npx vite build`.cwd(guiDir).env({ ...process.env, BASE_PATH: basePath });
  } else {
    await $`${flavor.packageManager} run build`.cwd(guiDir).env({ ...process.env, BASE_PATH: basePath });
  }

  // Verify paths
  console.log("Verifying paths...");
  const distDir = resolve(worktree, "gui", "dist");
  await $`bun ${resolve(scriptsDir, "verify-paths.ts")} ${distDir} ${basePath}`;

  // Copy output to serve-root
  const outputDir = resolve(serveRoot, version);
  await $`rm -rf ${outputDir}`;
  await $`mkdir -p ${serveRoot}`;
  await $`cp -r ${distDir} ${outputDir}`;
  console.log(`\nBuild complete: serve-root/${version}/`);
  console.log(`\nTo test locally:`);
  console.log(`  bun scripts/serve.ts --dir serve-root`);
  console.log(`  open http://localhost:8765/${version}/`);
} finally {
  await cleanup();
}
