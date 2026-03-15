import type { VersionRange } from "./ServerDetector";
import type { SchemaFingerprints } from "../hooks/useServerProbe";
import { compareVersions } from "../lib/solarxr-probe";
import styles from "./DetectionDetails.module.scss";

interface Props {
  versionRange: VersionRange;
  fingerprints: SchemaFingerprints;
  observed: (number | null)[] | null;
  onClose: () => void;
}

/** Generate short labels: a, b, c, … z, aa, ab, … */
function shortLabel(i: number): string {
  let s = "";
  do {
    s = String.fromCharCode(97 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/**
 * Check if a single cell passes the match logic (mirrors matchVersion).
 * Returns: "pass" | "fail" | "skip" (no observation).
 */
function cellResult(
  actual: number | null,
  expected: number | null,
  mode: "exact" | "upper-bound",
): "pass" | "fail" | "skip" {
  if (actual === null) return "skip";
  if (expected === null) return "fail"; // saw something, version doesn't have it
  if (mode === "exact") return actual === expected ? "pass" : "fail";
  return actual <= expected ? "pass" : "fail";
}

/** Format a cell: "actual ≤ expected", "actual = expected", etc. */
function cellText(
  actual: number | null,
  expected: number | null,
  mode: "exact" | "upper-bound",
): string {
  const a = actual ?? "\u2014";
  const e = expected ?? "\u2014";
  if (actual === null) return `${e}`;

  if (mode === "exact") {
    const sym = actual === expected ? "=" : "\u2260";
    return `${a} ${sym} ${e}`;
  }
  const sym = actual <= (expected ?? -1) ? "\u2264" : "\u2270";
  return `${a} ${sym} ${e}`;
}

export default function DetectionDetails({
  versionRange,
  fingerprints,
  observed,
  onClose,
}: Props) {
  const rangeLabel = versionRange.exact
    ? `v${versionRange.min}`
    : versionRange.max
      ? `v${versionRange.min} up to v${versionRange.max}`
      : `v${versionRange.min}+`;

  // Flatten measurements with match modes
  const measurements = fingerprints.probes.flatMap((p) =>
    p.measurements.map((m) => ({
      ...m,
      requestType: p.requestType,
      responseType: p.responseType,
    })),
  );
  const labels = measurements.map((_, i) => shortLabel(i));

  // Pre-compute matrix data
  type CellStyle = "fail" | "skip" | "exact" | "default";

  interface CellData {
    text: string;
    style: CellStyle;
  }

  interface RowData {
    version: string;
    style: "match" | "fail" | "default";
    cells: CellData[];
  }

  const rows: RowData[] | null = observed
    ? Object.entries(fingerprints.versions).map(([version, vector]) => {
        const inRange =
          compareVersions(version, versionRange.min) >= 0 &&
          (!versionRange.max || compareVersions(version, versionRange.max) < 0);

        const cells: CellData[] = vector.map((expected, j) => {
          const actual = observed[j] ?? null;
          const mode = measurements[j]!.match;
          const result = cellResult(actual, expected, mode);
          const text = cellText(actual, expected, mode);

          const style: CellStyle = (() => {
            if (result === "fail") return "fail";
            if (result === "skip") return "skip";
            if (inRange && actual === expected) return "exact";
            return "default";
          })();

          return { text, style };
        });

        const hasFailure = cells.some((c) => c.style === "fail");
        const rowStyle = inRange ? "match" : hasFailure ? "fail" : "default";

        return { version, style: rowStyle, cells };
      })
    : null;

  const rowStyleClass = {
    match: styles.rowMatch,
    fail: styles.rowFail,
    default: undefined,
  } as const;

  const cellStyleClass = {
    fail: styles.cellFail,
    skip: styles.cellSkip,
    exact: styles.cellExact,
    default: undefined,
  } as const;

  return (
    <dialog open>
      <article className={styles.dialog}>
        <header>
          <h3>Why are some versions grayed out?</h3>
          <button aria-label="Close" rel="prev" onClick={onClose} />
        </header>
        <div>
          <p>
            SolarXR responses from your server appeared to match the versions{" "}
            <strong>{rangeLabel}</strong>. Versions that were less likely to
            match your version were dimmed to avoid confusion. If you are sure
            you want to use a specific version, you can still click the links.
          </p>
          <p>
            Detection works by sending empty RPC requests to your local SlimeVR
            Server over the{" "}
            <a
              href="https://github.com/SlimeVR/SolarXR-Protocol"
              target="_blank"
              rel="noopener"
            >
              SolarXR FlatBuffers protocol
            </a>{" "}
            and counting vtable slots in each response. Different server
            versions define different fields in their response tables, so the
            slot count acts as a version fingerprint. Each measurement below
            compares the observed slot count against expected values per
            version.
          </p>
          <ul>
            <li>
              <strong>exact</strong> measurements come from responses that so
              far seem to always populate every field, so it is reliable enough
              to enforce observed must equal expected on them.
            </li>
            <li>
              <strong>upper-bound</strong> measurements come from responses that
              may omit fields conditionally (observed may be less than
              expected).
            </li>
          </ul>
          <p>
            <small>
              This is a heuristic, not an exact version identifier. The server
              doesn't currently report any info on its version.
            </small>
          </p>

          <table className={styles.legend}>
            <thead>
              <tr>
                <th></th>
                <th>Measurement</th>
                <th>Probe</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {measurements.map((m, i) => (
                <tr key={i}>
                  <td>
                    <strong>{labels[i]}</strong>
                  </td>
                  <td>
                    <code>{m.name}</code>
                  </td>
                  <td>
                    <code>
                      {m.requestType}/{m.responseType}
                      {m.path.length > 0 && ` [${m.path.join(",")}]`}
                    </code>
                  </td>
                  <td>{m.match}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows && (
            <div>
              <table className={styles.matrix}>
                <thead>
                  <tr>
                    <th>Version</th>
                    {labels.map((l, i) => (
                      <th key={l}>
                        <span data-tooltip={measurements[i]!.name}>{l}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.version} className={rowStyleClass[row.style]}>
                      <td>v{row.version}</td>
                      {row.cells.map((cell, j) => (
                        <td key={j} className={cellStyleClass[cell.style]}>
                          {cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </article>
    </dialog>
  );
}
