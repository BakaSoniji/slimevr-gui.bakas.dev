import { useState, useEffect, useCallback } from "react";
import {
  type VersionRange,
  type SchemaFingerprints,
  buildRpcRequest,
  parseFirstRpcMessage,
  executeMeasurement,
  matchVersion,
} from "../lib/solarxr-probe";

export type { VersionRange, SchemaFingerprints };

export type Status = "static" | "checking" | "connected" | "disconnected";

function emitVersionCompatibility(range: VersionRange | null) {
  window.dispatchEvent(
    new CustomEvent("slimevr:version-range", { detail: range }),
  );
}

// --- Hook ---

export function useServerProbe(fingerprints: SchemaFingerprints) {
  const [status, setStatus] = useState<Status>("static");
  const [versionRange, setVersionRange] = useState<VersionRange | null>(null);
  const [observed, setObserved] = useState<(number | null)[] | null>(null);

  const probeOnce = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      const ws = new WebSocket("ws://localhost:21110");
      ws.binaryType = "arraybuffer";

      // Track which response types we've received and their parsed messages
      const responses = new Map<
        number,
        { view: DataView; tablePos: number }
      >();
      const expectedResponseTypes = new Set(
        fingerprints.probes.map((p) => p.responseType),
      );
      let anyResponse = false;
      let done = false;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (success: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (probeTimer) clearTimeout(probeTimer);
        ws.close();

        if (success && anyResponse) {
          setStatus("connected");

          // Build observed measurement vector
          const observed: (number | null)[] = [];
          for (const probe of fingerprints.probes) {
            const resp = responses.get(probe.responseType);
            for (const measurement of probe.measurements) {
              if (!resp) {
                observed.push(null);
              } else {
                observed.push(
                  executeMeasurement(resp.view, resp.tablePos, measurement.path),
                );
              }
            }
          }

          setObserved(observed);
          const range = matchVersion(observed, fingerprints);
          setVersionRange(range);
          emitVersionCompatibility(range);
          resolve(true);
        } else {
          resolve(false);
        }
      };

      const timeout = setTimeout(() => finish(false), 3000);

      ws.onopen = () => {
        for (const probe of fingerprints.probes) {
          ws.send(buildRpcRequest(probe.requestType));
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === "string") return;
        const parsed = parseFirstRpcMessage(event.data);
        if (!parsed) return;
        const { view, messageType, messageTablePos } = parsed;

        if (expectedResponseTypes.has(messageType) && messageTablePos !== null) {
          responses.set(messageType, { view, tablePos: messageTablePos });
          anyResponse = true;
        }

        if (anyResponse) {
          if (fingerprints.probes.length <= 1) {
            finish(true);
          } else if (!probeTimer) {
            // Wait briefly for remaining probe responses (server ignores
            // unknown types, so non-responses simply won't arrive)
            probeTimer = setTimeout(() => finish(true), 500);
          }
        }

        // Close early if all probes have responded
        if (
          fingerprints.probes.every((p) => responses.has(p.responseType))
        ) {
          finish(true);
        }
      };

      ws.onerror = () => finish(false);
    });
  }, [fingerprints]);

  const startProbing = useCallback(() => {
    setStatus("checking");
    setVersionRange(null);

    let stopped = false;
    const deadline = Date.now() + 20_000;

    const loop = async () => {
      while (!stopped && Date.now() < deadline) {
        const ok = await probeOnce();
        if (ok) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!stopped) {
        setStatus("disconnected");
        emitVersionCompatibility(null);
      }
    };

    loop();
    return () => {
      stopped = true;
    };
  }, [probeOnce]);

  useEffect(() => {
    return startProbing();
  }, [startProbing]);

  return { status, versionRange, observed, retry: startProbing };
}
