/**
 * Discovers which SlimeVR versions need to be built.
 *
 * Compares upstream GitHub releases against already-deployed versions
 * in versions.json, outputting the diff as a JSON array.
 *
 * Usage: bun scripts/ci-discover-versions.ts --deployed <versions.json> --releases <releases.txt> --min-version <semver> [--override <version>] [--include-prereleases]
 *
 * Output: writes `versions=["0.18.2","0.17.0"]` to $GITHUB_OUTPUT (or stdout if unset)
 */

import { semver } from "bun";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    deployed: { type: "string" },
    releases: { type: "string" },
    "min-version": { type: "string" },
    override: { type: "string" },
    "include-prereleases": { type: "boolean", default: false },
    "retry-failed": { type: "boolean", default: false },
  },
  strict: true,
});

if (values.override) {
  console.log(`Manual version override: ${values.override}`);
  await writeOutput([values.override]);
  process.exit(0);
}

if (!values.deployed || !values.releases || !values["min-version"]) {
  console.error(
    "Usage: bun scripts/ci-discover-versions.ts --deployed <versions.json> --releases <releases.txt> --min-version <semver> [--override <version>] [--include-prereleases]"
  );
  process.exit(1);
}

const minVersion = values["min-version"];
const includePrereleases = values["include-prereleases"];
const retryFailed = values["retry-failed"];

import type { VersionEntry } from "../src/lib/types";

const entries: VersionEntry[] = await Bun.file(values.deployed).json();
const deployed = new Set(entries.filter((e) => e.status === "ok").map((e) => e.version));
const failed = new Set(entries.filter((e) => e.status === "failed").map((e) => e.version));

// Read all upstream releases (one version per line)
const allReleases = (await Bun.file(values.releases).text())
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

// Filter: >= min-version and not already deployed
const toBuild = allReleases.filter((v) => {
  try {
    if (deployed.has(v)) return false;
    if (failed.has(v) && !retryFailed) return false;

    const isPrerelease = v.includes("-");
    if (isPrerelease && !includePrereleases) return false;

    // semver.satisfies excludes prereleases from range matching,
    // so check the base version (e.g. 0.16.3-rc.1 → 0.16.3)
    const base = isPrerelease ? v.replace(/-.*/, "") : v;
    return semver.satisfies(base, `>=${minVersion}`);
  } catch {
    return false;
  }
});

// Sort ascending for build order
toBuild.sort(semver.order);

console.log(`Min version: ${minVersion}`);
console.log(`Deployed: ${deployed.size} versions`);
console.log(`Upstream: ${allReleases.length} releases`);
console.log(`To build: ${toBuild.length} versions`);
if (toBuild.length > 0) {
  console.log(`  ${toBuild.join(", ")}`);
}

await writeOutput(toBuild);

async function writeOutput(versions: string[]) {
  const line = `versions=${JSON.stringify(versions)}`;
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const file = Bun.file(ghOutput);
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(ghOutput, existing + line + "\n");
  }
  console.log(line);
}
