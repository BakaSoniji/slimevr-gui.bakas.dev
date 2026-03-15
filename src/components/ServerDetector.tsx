import { useState } from "react";
import styles from "./ServerDetector.module.scss";
import DetectionDetails from "./DetectionDetails";
import {
  useServerProbe,
  type SchemaFingerprints,
  type VersionRange,
} from "../hooks/useServerProbe";

interface Props {
  fingerprints: SchemaFingerprints;
}

export default function ServerDetector({ fingerprints }: Props) {
  const { status, versionRange, observed, retry } =
    useServerProbe(fingerprints);
  const [showDetails, setShowDetails] = useState(false);

  return (
    <article>
      <strong className={styles.status} data-status={status}>
        {status === "static" && "SlimeVR GUI"}
        {status === "checking" && "Looking for SlimeVR Server..."}
        {status === "disconnected" && "SlimeVR Server not found"}
        {status === "connected" && (
          <>
            SlimeVR Server detected
            <a
              href="#"
              aria-label="Why are some versions grayed out?"
              data-tooltip="Why are some versions grayed out?"
              onClick={(e) => {
                e.preventDefault();
                setShowDetails(true);
              }}
            >
              <span className={styles.infoIcon} />
            </a>
          </>
        )}
      </strong>
      {status === "static" && (
        <p>
          Select a version below to launch the web GUI. Make sure SlimeVR Server
          is running on this device.
        </p>
      )}
      {(status === "checking" || status === "disconnected") && (
        <>
          <p>Make sure SlimeVR Server is running on this device.</p>
          <p>
            {status === "checking" ? (
              <button className="outline" aria-busy="true" disabled>
                Checking...
              </button>
            ) : (
              <button className="outline" onClick={retry}>
                Retry
              </button>
            )}
          </p>
        </>
      )}
      {status === "connected" && (
        <p>Please select the GUI version matching your SlimeVR Server.</p>
      )}
      {showDetails && versionRange && (
        <DetectionDetails
          versionRange={versionRange}
          fingerprints={fingerprints}
          observed={observed}
          onClose={() => setShowDetails(false)}
        />
      )}
    </article>
  );
}

export { type VersionRange };
