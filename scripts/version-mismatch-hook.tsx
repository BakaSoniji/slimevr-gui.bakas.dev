/**
 * Version mismatch detection hook — injected into the SlimeVR GUI by
 * slimevr-gui.bakas.dev's build pipeline.
 *
 * Listens to raw WebSocket messages (via patched websocket-api.ts) and
 * counts FlatBuffers vtable slots to fingerprint the running server version.
 * On connect, sends probes for all measurement types. Passively updates
 * observations as new messages arrive (measurements can only go up, never down).
 *
 * Fetches /schema-fingerprints.json from the deployment root at runtime.
 *
 * This file is copied into the GUI's src/ alongside solarxr-probe.ts by
 * patch-for-deploy.ts (import path rewritten to ./solarxr-probe).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  type VersionRange,
  type SchemaFingerprints,
  buildRpcRequest,
  parseFirstRpcMessage,
  executeMeasurement,
  matchVersion,
  compareVersions,
} from "../src/lib/solarxr-probe";

// --- Fingerprints cache ---

let fpPromise: Promise<SchemaFingerprints | null> | null = null;

function getFingerprints(): Promise<SchemaFingerprints | null> {
  if (!fpPromise) {
    fpPromise = fetch("/schema-fingerprints.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return fpPromise;
}

// --- Persistent state (survives React remounts) ---

let cachedRange: VersionRange | null = null;
let cachedObserved: (number | null)[] = [];
let cachedFp: SchemaFingerprints | null = null;

// --- Hook ---

export interface VersionMismatchState {
  mismatch: boolean;
  detectedRange: VersionRange | null;
}

export function useVersionMismatch(guiVersion: string): VersionMismatchState {
  const [detectedRange, setDetectedRange] = useState<VersionRange | null>(cachedRange);
  const observedRef = useRef<(number | null)[]>(cachedObserved);
  const fpRef = useRef<SchemaFingerprints | null>(cachedFp);

  const processBuffer = useCallback((buffer: ArrayBuffer) => {
    const fp = fpRef.current;
    if (!fp) return;

    const parsed = parseFirstRpcMessage(buffer);
    if (!parsed || parsed.messageTablePos === null) return;

    const { view, messageType, messageTablePos } = parsed;

    let changed = false;
    let offset = 0;

    for (const probe of fp.probes) {
      if (messageType === probe.responseType) {
        for (let mi = 0; mi < probe.measurements.length; mi++) {
          const measurement = probe.measurements[mi]!;
          const val = executeMeasurement(
            view,
            messageTablePos,
            measurement.path,
          );
          const idx = offset + mi;
          const prev = observedRef.current[idx];

          // Update if new measurement, or value increased (passive refinement)
          if (
            val !== null &&
            (prev === null || prev === undefined || val > prev)
          ) {
            observedRef.current[idx] = val;
            changed = true;
          }
        }
      }
      offset += probe.measurements.length;
    }

    if (changed) {
      cachedObserved = observedRef.current;
      const range = matchVersion(observedRef.current, fp);
      cachedRange = range;
      setDetectedRange(range);
    }
  }, []);

  useEffect(() => {
    getFingerprints().then((fp) => {
      if (!fp) return;
      fpRef.current = fp;
      cachedFp = fp;
      if (observedRef.current.length === 0) {
        const total = fp.probes.reduce(
          (sum, p) => sum + p.measurements.length,
          0,
        );
        observedRef.current = new Array(total).fill(null);
        cachedObserved = observedRef.current;
      }
    });

    let probed = false;
    const sendProbes = (ws: WebSocket) => {
      if (probed) return;
      getFingerprints().then((fp) => {
        if (!fp || probed || ws.readyState !== WebSocket.OPEN) return;
        probed = true;
        for (const probe of fp.probes) {
          ws.send(buildRpcRequest(probe.requestType));
        }
      });
    };

    const handleConnected = (e: Event) => {
      sendProbes((e as CustomEvent).detail as WebSocket);
    };

    const handleMessage = (e: Event) => {
      const buf = (e as CustomEvent).detail as ArrayBuffer;
      processBuffer(buf);

      // ws-connected may have fired before this hook mounted.
      // On first raw message, open a short-lived probe connection as fallback.
      if (!probed) {
        const params = new URLSearchParams(window.location.search);
        const ws = new WebSocket(
          `ws://${params.get("ip") ?? "localhost"}:${params.get("port") ?? "21110"}`,
        );
        ws.binaryType = "arraybuffer";
        ws.onopen = () => sendProbes(ws);
        ws.onmessage = (ev) => {
          if (typeof ev.data !== "string") processBuffer(ev.data);
        };
        setTimeout(() => ws.close(), 3000);
      }
    };

    window.addEventListener("slimevr:ws-connected", handleConnected);
    window.addEventListener("slimevr:raw-message", handleMessage);

    return () => {
      window.removeEventListener("slimevr:ws-connected", handleConnected);
      window.removeEventListener("slimevr:raw-message", handleMessage);
    };
  }, [processBuffer]);

  const isInRange =
    detectedRange !== null &&
    compareVersions(guiVersion, detectedRange.min) >= 0 &&
    (!detectedRange.max || compareVersions(guiVersion, detectedRange.max) < 0);

  return {
    mismatch: detectedRange !== null && !isInRange,
    detectedRange,
  };
}

// --- Indicator component ---
// Copied and inlined from SlimeVR-Server/gui/src/components/commons/icon/WarningIcon.tsx
function MismatchWarningIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4 text-status-warning"
    >
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Self-contained version mismatch indicator. Render as a sibling right
 * after the version pill — it uses previousElementSibling to swap the
 * pill's status-success classes to status-warning when a mismatch is
 * detected, and renders a warning icon with tooltip.
 */
export function VersionMismatchIndicator({
  guiVersion,
}: {
  guiVersion: string;
}) {
  const vm = useVersionMismatch(guiVersion);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pill = ref.current?.previousElementSibling as HTMLElement | null;
    if (!pill) return;
    if (vm.mismatch) {
      pill.className = pill.className
        .replace("text-status-success", "text-status-warning")
        .replace("bg-status-success", "bg-status-warning");
    } else {
      pill.className = pill.className
        .replace("text-status-warning", "text-status-success")
        .replace("bg-status-warning", "bg-status-success");
    }
  }, [vm.mismatch]);

  const rangeLabel = vm.detectedRange
    ? vm.detectedRange.exact
      ? `v${vm.detectedRange.min}`
      : vm.detectedRange.max
        ? `v${vm.detectedRange.min} \u2013 v${vm.detectedRange.max}`
        : `v${vm.detectedRange.min}+`
    : null;

  return (
    <div
      ref={ref}
      className={
        vm.mismatch && rangeLabel
          ? "relative group flex items-center"
          : "hidden"
      }
    >
      <MismatchWarningIcon />
      <div
        className={[
          "hidden group-hover:block absolute top-full left-1/2 -translate-x-1/2",
          "pt-2 whitespace-nowrap z-[100]",
        ].join(" ")}
      >
        <div className="bg-background-60 text-standard rounded-lg px-3 py-2 shadow-lg">
        <p className="mb-1">Server appears to be {rangeLabel}</p>
        <a href="/" className="text-status-warning underline" target="_top">
          Go to version selector
        </a>
        </div>
      </div>
    </div>
  );
}
