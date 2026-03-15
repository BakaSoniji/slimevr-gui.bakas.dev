/**
 * Explores the SolarXR protocol across SlimeVR Server release versions.
 *
 * For each release tag, uses `flatc --schema -b` to generate a binary schema
 * (.bfbs) from the solarxr-protocol submodule's .fbs files, then converts it
 * to JSON via the FlatBuffers reflection schema. This gives us a fully
 * structured representation of every table, field, union, and cross-reference
 * — no regex parsing needed.
 *
 * Extracts:
 *   - RpcMessage union members with their indices
 *   - All table definitions with field counts and types
 *   - Empty-table requests (candidates for probes)
 *   - Response table field counts, including subtable field counts
 *
 * This is the "observe everything" step. Its output can be used to identify
 * which probes are most useful for version detection.
 *
 * Prerequisites: flatc (any recent version) must be on PATH.
 *
 * Usage: bun scripts/explore-protocol.ts --server-repo <path to SlimeVR-Server> [--output <path>]
 */

import { $ } from "bun";
import { parseArgs } from "util";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "server-repo": { type: "string" },
    output: { type: "string", default: "protocol-exploration.json" },
    "min-version": { type: "string", default: "0.2.0" },
    "reflection-fbs": { type: "string" },
  },
  strict: true,
});

if (!values["server-repo"]) {
  console.error(
    "Usage: bun scripts/explore-protocol.ts --server-repo <path to SlimeVR-Server> [--output <path>]",
  );
  process.exit(1);
}

const serverRepo = values["server-repo"];
const submoduleRepo = join(serverRepo, "solarxr-protocol");
const outputPath = values.output!;

// --- Prerequisites ---

// Verify flatc is available
const flatcResult = await $`flatc --version`.nothrow().quiet();
if (flatcResult.exitCode !== 0) {
  console.error("Error: flatc not found. Install with: brew install flatbuffers");
  process.exit(1);
}

// Locate or download reflection.fbs (needed to convert .bfbs → JSON)
// Mostly because the homebrew version doesnt seem to have it.
// TODO: remove if CI works
async function getReflectionFbs(): Promise<string> {
  if (values["reflection-fbs"]) return values["reflection-fbs"];

  const candidates = [
    "/opt/homebrew/share/flatbuffers/reflection/reflection.fbs",
    "/usr/local/share/flatbuffers/reflection/reflection.fbs",
    "/usr/share/flatbuffers/reflection/reflection.fbs",
  ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }

  console.log("Downloading reflection.fbs from GitHub...");
  const url =
    "https://raw.githubusercontent.com/google/flatbuffers/master/reflection/reflection.fbs";
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download reflection.fbs: ${resp.status}`);
  const path = join(tmpdir(), "reflection.fbs");
  await Bun.write(path, await resp.text());
  return path;
}

const reflectionFbs = await getReflectionFbs();

// --- git helpers ---

async function getReleaseTags(
  repo: string,
  minVersion: string,
): Promise<string[]> {
  const raw = await $`git tag --list 'v*' --sort=v:refname`.cwd(repo).text();
  const { semver } = await import("bun");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((tag) => !tag.includes("-"))
    .filter((tag) => {
      const ver = tag.replace(/^v/, "");
      try {
        return semver.satisfies(ver, `>=${minVersion}`);
      } catch {
        return false;
      }
    });
}

async function getSubmoduleCommit(
  repo: string,
  tag: string,
): Promise<string | null> {
  const out = await $`git ls-tree ${tag} solarxr-protocol`.cwd(repo).text();
  const match = out.match(/^160000\s+commit\s+([0-9a-f]+)/);
  return match ? match[1]! : null;
}

// --- flatc schema extraction ---

/** Reflection schema JSON types (subset we use) */

interface BfbsField {
  name: string;
  id?: number;
  type: { base_type: string; index?: number; element?: string };
  deprecated: boolean;
}

interface BfbsObject {
  name: string;
  fields: BfbsField[];
  is_struct: boolean;
}

interface BfbsEnumValue {
  name: string;
  value: number;
  union_type?: { base_type?: string; index?: number };
}

interface BfbsEnum {
  name: string;
  values: BfbsEnumValue[];
  is_union: boolean;
}

interface BfbsSchema {
  objects: BfbsObject[];
  enums: BfbsEnum[];
}

/**
 * Extract schema files from a submodule commit, run flatc to produce a binary
 * schema (.bfbs), then convert to JSON via the reflection schema.
 */
async function extractSchema(
  submoduleCommit: string,
): Promise<BfbsSchema | null> {
  const tmp = await mkdtemp(join(tmpdir(), "fbs-"));
  try {
    // Extract schema files from the historical commit — try schema/ first,
    // fall back to protocol/flatbuffers/ (used in v0.2.0 and earlier)
    let schemaDir: string;
    let tar = await $`git archive ${submoduleCommit} -- schema/`
      .cwd(submoduleRepo)
      .nothrow()
      .quiet();
    if (tar.exitCode === 0) {
      new Bun.Archive(tar.stdout.buffer).extract(tmp);
      schemaDir = join(tmp, "schema");
    } else {
      tar = await $`git archive ${submoduleCommit} -- protocol/flatbuffers/`
        .cwd(submoduleRepo)
        .nothrow()
        .quiet();
      if (tar.exitCode !== 0) return null;
      new Bun.Archive(tar.stdout.buffer).extract(tmp);
      schemaDir = join(tmp, "protocol", "flatbuffers");
    }
    const allFbs = join(schemaDir, "all.fbs");

    // Generate binary schema (.bfbs)
    const bfbs = await $`flatc --schema -b -o ${tmp} -I ${schemaDir} ${allFbs}`
      .nothrow()
      .quiet();
    if (bfbs.exitCode !== 0) return null;

    // Convert .bfbs → JSON via reflection schema
    const bfbsFile = join(tmp, "all.bfbs");
    const json = await $`flatc --json --strict-json -o ${tmp} --raw-binary ${reflectionFbs} -- ${bfbsFile}`
      .nothrow()
      .quiet();
    if (json.exitCode !== 0) return null;

    return Bun.file(join(tmp, "all.json")).json();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// --- Analysis ---

interface TableFingerprint {
  fieldCount: number;
  fields: { name: string; id: number; deprecated: boolean }[];
  subtables: Record<string, TableFingerprint & { id: number }>;
}

function computeFingerprint(
  objectIndex: number,
  schema: BfbsSchema,
  visited: Set<number> = new Set(),
): TableFingerprint | null {
  if (visited.has(objectIndex)) return null;
  const obj = schema.objects[objectIndex];
  if (!obj) return null;
  visited.add(objectIndex);

  const subtables: Record<string, TableFingerprint & { id: number }> = {};
  for (const field of obj.fields) {
    if (field.type.base_type === "Obj" && field.type.index != null) {
      const sub = computeFingerprint(field.type.index, schema, new Set(visited));
      if (sub) subtables[field.name] = { ...sub, id: field.id ?? 0 };
    }
  }

  return {
    fieldCount: obj.fields.length,
    fields: obj.fields.map((f) => ({
      name: f.name,
      id: f.id ?? 0,
      deprecated: f.deprecated,
    })),
    subtables,
  };
}

interface ProbeCandidate {
  requestName: string;
  requestType: number;
  responseName: string | null;
  responseType: number | null;
  responseFingerprint: TableFingerprint | null;
}

function findResponseForRequest(
  requestName: string,
  membersByName: Map<string, BfbsEnumValue>,
): { name: string; value: number } | null {
  const base = requestName.replace(/Request$/, "");
  const candidates = [
    `${base}Response`,
    `${base}Status`,
    `${base}StateResponse`,
    `${base}StatusResponse`,
    `${base}StateChangeResponse`,
    `${base}RecordingStatusResponse`,
    `${base}ChangeResponse`,
  ];
  if (requestName.endsWith("StateRequest")) {
    const stateBase = requestName.replace(/StateRequest$/, "");
    candidates.push(`${stateBase}StateChangeResponse`);
  }
  for (const name of candidates) {
    const member = membersByName.get(name);
    if (member) return { name, value: member.value };
  }
  return null;
}

interface VersionData {
  rpcUnionSize: number;
  rpcUnionMembers: string[];
  probeCandidates: ProbeCandidate[];
}

// --- Main ---

const tags = await getReleaseTags(serverRepo, values["min-version"]!);
console.log(`Found ${tags.length} release tags >= v${values["min-version"]}`);

const result: Record<string, VersionData> = {};

for (const tag of tags) {
  const version = tag.replace(/^v/, "");
  const subCommit = await getSubmoduleCommit(serverRepo, tag);
  if (!subCommit) {
    console.log(`  ${tag}: no submodule → skip`);
    continue;
  }

  const schema = await extractSchema(subCommit);
  if (!schema) {
    console.log(`  ${tag}: failed to extract schema → skip`);
    continue;
  }

  // Find RpcMessage union
  const rpcEnum = schema.enums.find((e) => e.name.endsWith("RpcMessage"));
  if (!rpcEnum) {
    console.log(`  ${tag}: no RpcMessage union → skip`);
    continue;
  }

  const members = rpcEnum.values.filter((v) => v.name !== "NONE");
  const membersByName = new Map(members.map((m) => [m.name, m]));
  const memberNames = members.map((m) => m.name);

  // Find empty-table requests that are union members
  const probeCandidates: ProbeCandidate[] = [];
  for (const member of members) {
    if (!member.name.endsWith("Request")) continue;
    const objIndex = member.union_type?.index;
    if (objIndex == null) continue;
    const obj = schema.objects[objIndex];
    if (!obj || obj.fields.length > 0) continue;

    const resp = findResponseForRequest(member.name, membersByName);
    let responseFingerprint: TableFingerprint | null = null;
    if (resp) {
      const respMember = membersByName.get(resp.name);
      const respObjIndex = respMember?.union_type?.index;
      if (respObjIndex != null) {
        responseFingerprint = computeFingerprint(respObjIndex, schema);
      }
    }

    probeCandidates.push({
      requestName: member.name,
      requestType: member.value,
      responseName: resp?.name ?? null,
      responseType: resp?.value ?? null,
      responseFingerprint,
    });
  }

  result[version] = {
    rpcUnionSize: members.length,
    rpcUnionMembers: memberNames,
    probeCandidates,
  };

  const withResponse = probeCandidates.filter((p) => p.responseName);
  console.log(
    `  ${tag}: ${members.length} union members, ${probeCandidates.length} empty requests, ${withResponse.length} with paired responses`,
  );
}

// --- Diff summary ---

console.log("\n=== Changes across versions ===\n");

const versions = Object.keys(result);
for (let i = 1; i < versions.length; i++) {
  const prev = result[versions[i - 1]!]!;
  const curr = result[versions[i]!]!;
  const changes: string[] = [];

  // New union members
  const prevMembers = new Set(prev.rpcUnionMembers);
  const newMembers = curr.rpcUnionMembers.filter((m) => !prevMembers.has(m));
  if (newMembers.length > 0) {
    changes.push(`  +union: ${newMembers.join(", ")}`);
  }

  // Response fingerprint changes
  for (const probe of curr.probeCandidates) {
    if (!probe.responseFingerprint || !probe.responseName) continue;
    const prevProbe = prev.probeCandidates.find(
      (p) => p.requestName === probe.requestName,
    );
    if (!prevProbe) continue;
    if (!prevProbe.responseFingerprint) continue;

    const diffs = diffFingerprints(
      probe.responseName,
      prevProbe.responseFingerprint,
      probe.responseFingerprint,
    );
    if (diffs.length > 0) changes.push(...diffs.map((d) => `  ${d}`));
  }

  if (changes.length > 0) {
    console.log(`v${versions[i - 1]} → v${versions[i]}:`);
    for (const c of changes) console.log(c);
    console.log();
  }
}

function diffFingerprints(
  path: string,
  a: TableFingerprint,
  b: TableFingerprint,
): string[] {
  const diffs: string[] = [];

  if (a.fieldCount !== b.fieldCount) {
    const aNames = new Set(a.fields.map((f) => f.name));
    const bNames = new Set(b.fields.map((f) => f.name));
    const added = b.fields.filter((f) => !aNames.has(f.name));
    const removed = a.fields.filter((f) => !bNames.has(f.name));
    const fmtField = (f: { name: string; deprecated: boolean }) =>
      f.name + (f.deprecated ? " (deprecated)" : "");
    const parts = [`${path}: ${a.fieldCount} → ${b.fieldCount} fields`];
    if (added.length > 0) parts.push(`+${added.map(fmtField).join(", +")}`);
    if (removed.length > 0) parts.push(`-${removed.map(fmtField).join(", -")}`);
    diffs.push(parts.join(" "));
  }

  const allKeys = new Set([
    ...Object.keys(a.subtables),
    ...Object.keys(b.subtables),
  ]);
  for (const key of allKeys) {
    const subA = a.subtables[key];
    const subB = b.subtables[key];
    if (subA && subB) {
      diffs.push(...diffFingerprints(`${path}.${key}`, subA, subB));
    } else if (subB && !subA) {
      diffs.push(`${path}.${key}: (new subtable, ${subB.fieldCount} fields)`);
    }
  }

  return diffs;
}

// --- Write output ---

await Bun.write(outputPath, JSON.stringify(result, null, 2));
console.log(`\nWrote exploration data to ${outputPath}`);
