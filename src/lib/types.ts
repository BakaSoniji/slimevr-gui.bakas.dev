/** A version entry in versions.json. */
export interface VersionEntry {
  version: string;
  releaseUrl?: string;
  date?: string;
  status?: "ok" | "failed";
  failReason?: string;
}
