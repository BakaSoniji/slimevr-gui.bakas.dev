/**
 * Transforms raw protocol exploration data into compact fingerprints for the
 * client probe.
 *
 * Reads the output of explore-protocol.ts, auto-selects measurements that
 * create version boundaries, deduplicates by wire identity (requestType,
 * responseType, path), applies skip rules from probe-config.yaml, and outputs
 * a compact JSON file consumed by useServerProbe.ts.
 *
 * Usage: bun scripts/extract-schema-fingerprints.ts [--input <path>] [--output <path>] [--config <path>]
 */

import { parseArgs } from "util";
import { join, dirname } from "path";
import { compareVersions } from "../src/lib/solarxr-probe";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    input: { type: "string", default: "protocol-exploration.json" },
    output: { type: "string", default: "schema-fingerprints.json" },
    config: { type: "string", default: join(dirname(Bun.main), "probe-config.yaml") },
  },
  strict: true,
});

// --- Load inputs ---

const explorationData = await Bun.file(args.input!).json();
const configText = await Bun.file(args.config!).text();
const config = Bun.YAML.parse(configText) as {
  "min-version"?: string;
  match?: "exact" | "upper-bound";
  "match-overrides"?: Record<string, "exact" | "upper-bound">;
  skip?: (string | number[])[];
};

const minVersion = config["min-version"] ?? "0.7.0";
const defaultMatch = config.match ?? "upper-bound";
const matchOverrides = config["match-overrides"] ?? {};
const skipEntries = config.skip ?? [];

// --- Types from exploration data ---

interface TableFingerprint {
  fieldCount: number;
  fields: { name: string; id: number; deprecated: boolean }[];
  subtables: Record<string, TableFingerprint & { id: number }>;
}

interface ProbeCandidate {
  requestName: string;
  requestType: number;
  responseName: string | null;
  responseType: number | null;
  responseFingerprint: TableFingerprint | null;
}

interface VersionData {
  rpcUnionSize: number;
  rpcUnionMembers: string[];
  probeCandidates: ProbeCandidate[];
}

const versionMap = explorationData as Record<string, VersionData>;

// --- Measurement enumeration ---

interface Measurement {
  requestType: number;
  responseType: number;
  path: number[];
  name: string;
}

/** Canonical key for wire identity. */
function measurementKey(requestType: number, responseType: number, path: number[]): string {
  return `${requestType}:${responseType}:${path.join(",")}`;
}

/**
 * Recursively enumerate all measurable paths through a response fingerprint.
 * Collects into nameToKey (name → wire key) and keyToMeasurement (wire key → measurement).
 * When a key already exists, the measurement name is updated to the latest version's name.
 */
function enumerateMeasurements(
  probe: ProbeCandidate,
  fingerprint: TableFingerprint,
  pathIds: number[],
  pathNames: string[],
  nameToKey: Map<string, string>,
  keyToMeasurement: Map<string, Measurement>,
) {
  const name = pathNames.join(".");
  const key = measurementKey(probe.requestType, probe.responseType!, pathIds);

  // Map this name to its wire key (multiple names can map to the same key)
  nameToKey.set(name, key);

  // Keep latest name for display (later versions overwrite earlier)
  keyToMeasurement.set(key, {
    requestType: probe.requestType,
    responseType: probe.responseType!,
    path: [...pathIds],
    name,
  });

  for (const [fieldName, sub] of Object.entries(fingerprint.subtables)) {
    enumerateMeasurements(
      probe,
      sub,
      [...pathIds, sub.id],
      [...pathNames, fieldName],
      nameToKey,
      keyToMeasurement,
    );
  }
}

/** Resolve a measurement's vtable slot count for a given version. */
function resolveMeasurement(
  measurement: Measurement,
  versionData: VersionData,
): number | null {
  const probe = versionData.probeCandidates.find(
    (p) => p.requestType === measurement.requestType,
  );
  if (!probe?.responseFingerprint) return null;

  let fp: TableFingerprint | null = probe.responseFingerprint;
  for (const slotId of measurement.path) {
    if (!fp) return null;
    const found: (TableFingerprint & { id: number }) | undefined =
      Object.values(fp.subtables).find((s) => s.id === slotId);
    fp = found ?? null;
  }
  return fp?.fieldCount ?? null;
}

// --- Filter versions by min-version ---

const versions = Object.keys(versionMap)
  .filter((v) => compareVersions(v, minVersion) >= 0)
  .sort(compareVersions);

console.log(`${versions.length} versions >= v${minVersion}`);

// --- Enumerate all measurements across all versions ---

const nameToKey = new Map<string, string>();
const keyToMeasurement = new Map<string, Measurement>();

for (const version of versions) {
  const data = versionMap[version]!;
  for (const probe of data.probeCandidates) {
    if (!probe.responseFingerprint || !probe.responseName) continue;
    enumerateMeasurements(
      probe,
      probe.responseFingerprint,
      [],
      [probe.responseName],
      nameToKey,
      keyToMeasurement,
    );
  }
}

console.log(`${keyToMeasurement.size} unique measurements (${nameToKey.size} names)`);

// --- Resolve skip entries to wire keys ---

const skipKeys = new Set<string>();
for (const entry of skipEntries) {
  if (typeof entry === "string") {
    const key = nameToKey.get(entry);
    if (key) {
      skipKeys.add(key);
      console.log(`  skip: ${entry} → ${key}`);
    } else {
      console.warn(`  skip: ${entry} → not found (ignored)`);
    }
  } else if (Array.isArray(entry) && entry.length >= 2) {
    const [reqType, resType, ...path] = entry;
    const key = measurementKey(reqType, resType, path);
    if (keyToMeasurement.has(key)) {
      skipKeys.add(key);
      console.log(`  skip: [${entry.join(",")}] → ${key}`);
    } else {
      console.warn(`  skip: [${entry.join(",")}] → not found (ignored)`);
    }
  }
}

// --- Find measurements that create version boundaries ---

interface ScoredMeasurement {
  measurement: Measurement;
  key: string;
  boundaries: string[];
  values: (number | null)[];
}

const scored = [...keyToMeasurement.entries()]
  .filter(([key]) => !skipKeys.has(key))
  .map(([key, measurement]) => {
    const values = versions.map((v) => resolveMeasurement(measurement, versionMap[v]!));
    const boundaries = versions.filter((_, i) => i > 0 && values[i] !== values[i - 1]);
    return { measurement, key, boundaries, values };
  })
  .filter((s) => s.boundaries.length > 0)
  .sort((a, b) =>
    b.boundaries.length - a.boundaries.length ||
    a.measurement.name.localeCompare(b.measurement.name),
  );

// --- Greedy selection: pick measurements that cover all boundaries ---

const allBoundaries = new Set(scored.flatMap((s) => s.boundaries));

const { selected } = scored.reduce(
  (acc, s) => {
    if (acc.covered.size === allBoundaries.size) return acc;
    if (s.boundaries.every((b) => acc.covered.has(b))) return acc;
    s.boundaries.forEach((b) => acc.covered.add(b));
    acc.selected.push(s);
    return acc;
  },
  { selected: [] as typeof scored, covered: new Set<string>() },
);

const uncovered = [...allBoundaries].filter((b) =>
  !selected.some((s) => s.boundaries.includes(b)),
);
if (uncovered.length > 0) {
  console.warn(`Warning: ${uncovered.length} boundaries not covered: ${uncovered.join(", ")}`);
}

// --- Build output ---

// Resolve match mode for a measurement based on its response name.
// Overrides only apply to the root measurement (no dots in name),
// since subtable population depends on individual field builders.
function resolveMatchMode(name: string): "exact" | "upper-bound" {
  if (!name.includes(".")) {
    return matchOverrides[name] ?? defaultMatch;
  }
  return defaultMatch;
}

// Group selected measurements by probe (requestType, responseType)
const probes = Object.values(Object.groupBy(selected, (s) =>
  `${s.measurement.requestType}:${s.measurement.responseType}`,
)).map((group) => ({
  requestType: group![0]!.measurement.requestType,
  responseType: group![0]!.measurement.responseType,
  measurements: group!.map((s) => ({
    path: s.measurement.path,
    name: s.measurement.name,
    match: resolveMatchMode(s.measurement.name),
  })),
}));

// Collect the flattened measurement list in probe order for value lookup
const flatMeasurements = probes.flatMap((p) =>
  p.measurements.map((m) => ({
    requestType: p.requestType,
    responseType: p.responseType,
    ...m,
  })),
);

// Build version fingerprints — only include versions where the vector changes
const versionFingerprints = versions.reduce<{
  result: Record<string, (number | null)[]>;
  prev: string | null;
}>(
  (acc, version) => {
    const vector = flatMeasurements.map((m) =>
      resolveMeasurement(m, versionMap[version]!),
    );
    const key = JSON.stringify(vector);
    if (key !== acc.prev) {
      acc.result[version] = vector;
      acc.prev = key;
    }
    return acc;
  },
  { result: {}, prev: null },
).result;

const output = {
  probes,
  versions: versionFingerprints,
};

// --- Summary ---

console.log(`\nSelected ${selected.length} measurements across ${probes.length} probes:`);
selected.forEach((s) => {
  const pathStr = s.measurement.path.length > 0 ? ` path=[${s.measurement.path.join(",")}]` : "";
  console.log(`  ${s.measurement.name} (req=${s.measurement.requestType} res=${s.measurement.responseType}${pathStr})`);
  console.log(`    discriminates: ${s.boundaries.map((v) => `v${v}`).join(", ")}`);

  const changes = s.values
    .map((val, i) => ({ val, version: versions[i] }))
    .filter(({ val }, i) => i === 0 || val !== s.values[i - 1])
    .map(({ val, version }) => `v${version}=${val ?? "absent"}`);
  console.log(`    values: ${changes.join(" → ")}`);
});

console.log(`\nVersion fingerprints (${Object.keys(versionFingerprints).length} boundaries):`);
Object.entries(versionFingerprints).forEach(([version, vector]) => {
  const labels = flatMeasurements.map((m, i) => `${m.name}=${vector[i] ?? "absent"}`);
  console.log(`  v${version}: ${labels.join(", ")}`);
});

// --- Write output ---

await Bun.write(args.output!, JSON.stringify(output, null, 2));
console.log(`\nWrote ${args.output}`);
