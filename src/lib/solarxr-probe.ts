/**
 * SolarXR protocol probing utilities.
 *
 * Shared between the index page (useServerProbe) and the injected
 * version-mismatch hook. Contains FlatBuffers binary helpers, RPC
 * request building, and version matching logic.
 */

// --- Types ---

export interface VersionRange {
  min: string;
  max: string | null;
  /** True when the range matches exactly one version (min and max are adjacent). */
  exact: boolean;
}

export interface ProbeMeasurement {
  path: number[];
  name: string;
  match: "exact" | "upper-bound";
}

export interface ProbeConfig {
  requestType: number;
  responseType: number;
  measurements: ProbeMeasurement[];
}

export interface SchemaFingerprints {
  probes: ProbeConfig[];
  versions: Record<string, (number | null)[]>;
}

// --- Binary helpers ---

// Pre-computed FlatBuffers binary template: MessageBundle containing one
// RpcMessageHeader wrapping an empty table. The byte at UNION_TYPE_OFFSET
// is the RPC union type discriminator — patch it for different request types.
//
// generated from bun scripts/dev-dump-settings-request-bytes.ts
const RPC_TEMPLATE = new Uint8Array([
  16, 0, 0, 0, 0, 0, 10, 0, 16, 0, 12, 0, 8, 0, 4, 0, 10, 0, 0, 0, 12, 0, 0, 0,
  12, 0, 0, 0, 48, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 16, 0, 0, 0, 0, 0, 10, 0,
  12, 0, 0, 0, 11, 0, 4, 0, 10, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 4, 0, 4, 0, 4,
  0, 0, 0, 0, 0, 0, 0,
]);
const UNION_TYPE_OFFSET = 67;

export function buildRpcRequest(unionType: number): Uint8Array {
  const buf = new Uint8Array(RPC_TEMPLATE);
  buf[UNION_TYPE_OFFSET] = unionType;
  return buf;
}

/**
 * Navigate a FlatBuffers MessageBundle to the first RPC message.
 * Returns the position info needed for further parsing, or null.
 */
export function parseFirstRpcMessage(buf: ArrayBuffer) {
  try {
    return parseFirstRpcMessageUnsafe(buf);
  } catch {
    return null; // Not a valid FlatBuffers MessageBundle (e.g. non-SlimeVR WebSocket)
  }
}

function parseFirstRpcMessageUnsafe(buf: ArrayBuffer) {
  const view = new DataView(buf);
  const rootPos = view.getUint32(0, true);
  const mbVtablePos = rootPos - view.getInt32(rootPos, true);
  const mbVtableSize = view.getUint16(mbVtablePos, true);
  if (mbVtableSize < 8) return null;
  const rpcMsgsOff = view.getUint16(mbVtablePos + 6, true);
  if (rpcMsgsOff === 0) return null;
  const vecRef = rootPos + rpcMsgsOff;
  const vecStart = vecRef + view.getUint32(vecRef, true);
  const vecLen = view.getUint32(vecStart, true);
  if (vecLen === 0) return null;
  const elemRef = vecStart + 4;
  const rpcPos = elemRef + view.getUint32(elemRef, true);
  const rpcVtablePos = rpcPos - view.getInt32(rpcPos, true);
  const rpcVtableSize = view.getUint16(rpcVtablePos, true);
  if (rpcVtableSize < 8) return null;
  const msgTypeOff = view.getUint16(rpcVtablePos + 6, true);
  if (msgTypeOff === 0) return null;
  const messageType = view.getUint8(rpcPos + msgTypeOff);

  // Navigate to the union message table (if present)
  let messageTablePos: number | null = null;
  if (rpcVtableSize >= 10) {
    const msgOff = view.getUint16(rpcVtablePos + 8, true);
    if (msgOff !== 0) {
      const msgRef = rpcPos + msgOff;
      messageTablePos = msgRef + view.getUint32(msgRef, true);
    }
  }

  return { view, messageType, messageTablePos };
}

/**
 * Count vtable slots of the table at `tablePos`.
 */
function countVtableSlots(view: DataView, tablePos: number): number {
  const vtablePos = tablePos - view.getInt32(tablePos, true);
  const vtableSize = view.getUint16(vtablePos, true);
  return (vtableSize - 4) / 2;
}

/**
 * Navigate from a table to a child table at the given vtable slot.
 * Returns the child table position, or null if the field is absent.
 */
function readChildTable(
  view: DataView,
  tablePos: number,
  slotId: number,
): number | null {
  const vtablePos = tablePos - view.getInt32(tablePos, true);
  const vtableSize = view.getUint16(vtablePos, true);
  const slotOffset = 4 + slotId * 2;
  if (vtableSize <= slotOffset) return null;
  const fieldOff = view.getUint16(vtablePos + slotOffset, true);
  if (fieldOff === 0) return null;
  const ref = tablePos + fieldOff;
  return ref + view.getUint32(ref, true);
}

/**
 * Execute a measurement: navigate the path of vtable slot IDs from the
 * response table and count vtable slots at the destination.
 * Returns null if any step in the path fails (field absent / no response).
 */
export function executeMeasurement(
  view: DataView,
  tablePos: number,
  path: number[],
): number | null {
  try {
    return executeMeasurementUnsafe(view, tablePos, path);
  } catch {
    return null;
  }
}

function executeMeasurementUnsafe(
  view: DataView,
  tablePos: number,
  path: number[],
): number | null {
  let pos = tablePos;
  for (const slotId of path) {
    const child = readChildTable(view, pos, slotId);
    if (child === null) return null;
    pos = child;
  }
  return countVtableSlots(view, pos);
}

// --- Version matching ---

/**
 * Compare two semver-like version strings.
 * Handles numeric segments and prerelease ordering
 * (e.g. 19.0.0-rc.1 < 19.0.0, per semver spec).
 */
export function compareVersions(a: string, b: string): number {
  const [aBase, aPre] = a.split("-", 2);
  const [bBase, bPre] = b.split("-", 2);
  const baseCmp = aBase!.localeCompare(bBase!, undefined, { numeric: true });
  if (baseCmp !== 0) return baseCmp;
  // Same base: no prerelease > has prerelease (19.0.0 > 19.0.0-rc.1)
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  if (!aPre && !bPre) return 0;
  return aPre!.localeCompare(bPre!, undefined, { numeric: true });
}

/**
 * Match observed measurement vector against known version fingerprints.
 *
 * Each measurement has a match mode:
 *
 * - "upper-bound": The server may populate fewer fields than the schema
 *   defines (e.g. conditional responses). observed <= expected means
 *   compatible; observed > expected means the version is too old.
 *
 * - "exact": The server always populates all fields, so the observed
 *   count must match the expected count exactly. This enables both
 *   lower-bound and upper-bound version detection.
 */
export function matchVersion(
  observed: (number | null)[],
  fingerprints: SchemaFingerprints,
): VersionRange | null {
  const entries = Object.entries(fingerprints.versions).sort(([a], [b]) =>
    compareVersions(a, b),
  );

  const matchModes = fingerprints.probes.flatMap((p) =>
    p.measurements.map((m) => m.match),
  );

  /** Check if every observed measurement is compatible with a version vector. */
  const isCompatible = (vector: (number | null)[]) =>
    vector.every((expected, mi) => {
      const actual = observed[mi];
      if (actual === null) return true;
      if (expected === null) return false;
      return matchModes[mi] === "exact"
        ? actual === expected
        : actual <= expected;
    });

  /** Check if any exact measurement shows the version is too new. */
  const isTooNew = (vector: (number | null)[]) =>
    vector.some(
      (expected, mi) =>
        matchModes[mi] === "exact" &&
        observed[mi] !== null &&
        expected !== null &&
        observed[mi]! < expected,
    );

  // Lower bound: earliest compatible version
  const minIdx = entries.findIndex(([, vector]) => isCompatible(vector));
  if (minIdx === -1) return null;

  // Upper bound: first version that's too new
  const maxOffset = entries
    .slice(minIdx + 1)
    .findIndex(([, vector]) => isTooNew(vector));
  const maxIdx = maxOffset !== -1 ? minIdx + 1 + maxOffset : null;

  return {
    min: entries[minIdx]![0],
    max: maxIdx !== null ? entries[maxIdx]![0] : null,
    exact: maxIdx !== null && maxIdx === minIdx + 1,
  };
}
