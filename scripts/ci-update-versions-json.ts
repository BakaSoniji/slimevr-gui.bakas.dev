/**
 * Adds or updates a version entry in versions.json.
 *
 * Usage: bun scripts/ci-update-versions-json.ts <versions-json-path> <version> [--release-url <url>] [--date <iso-date>] [--status <ok|failed>] [--fail-reason <reason>]
 */

import { parseArgs } from "util";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "release-url": { type: "string" },
    date: { type: "string" },
    status: { type: "string" },
    "fail-reason": { type: "string" },
  },
  strict: true,
  allowPositionals: true,
});

const versionsPath = positionals[0];
const version = positionals[1];

if (!versionsPath || !version) {
  console.error(
    "Usage: bun scripts/ci-update-versions-json.ts <versions-json-path> <version> [--release-url <url>] [--date <iso-date>] [--status <ok|failed>] [--fail-reason <reason>]"
  );
  process.exit(1);
}

import type { VersionEntry } from "../src/lib/types";

const file = Bun.file(versionsPath);
const versions: VersionEntry[] = (await file.exists()) ? await file.json() : [];

const existing = versions.find((e) => e.version === version);
if (existing) {
  if (values["release-url"]) existing.releaseUrl = values["release-url"];
  if (values.date) existing.date = values.date;
  if (values.status) existing.status = values.status as "ok" | "failed";
  if (values["fail-reason"]) existing.failReason = values["fail-reason"];
  // Clear failReason when status changes to ok
  if (values.status === "ok") delete existing.failReason;
  console.log(`Updated ${version}`);
} else {
  const entry: VersionEntry = { version };
  if (values["release-url"]) entry.releaseUrl = values["release-url"];
  if (values.date) entry.date = values.date;
  if (values.status) entry.status = values.status as "ok" | "failed";
  if (values["fail-reason"]) entry.failReason = values["fail-reason"];
  versions.push(entry);
  console.log(`Added ${version}`);
}

await Bun.write(versionsPath, JSON.stringify(versions, null, 2));
console.log(`versions.json now has ${versions.length} entries`);
