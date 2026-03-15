/**
 * Detects the build flavor of a SlimeVR GUI checkout.
 *
 * Examines the project files to determine which package manager, build tool,
 * and router type are in use. This centralizes version-era detection so that
 * build scripts, patching, and CI can all use the same logic.
 *
 * Usage:
 *   import { detectBuildFlavor } from "./detect-build-flavor";
 *   const flavor = await detectBuildFlavor("/path/to/SlimeVR-Server");
 */

import { resolve } from "path";

export interface BuildFlavor {
  /** Package manager: "pnpm" for v0.12.0+, "npm" for earlier versions. */
  packageManager: "pnpm" | "npm";

  /** Build tool for the GUI renderer. */
  buildTool: "vite" | "electron-vite";

  /** Router type used in App.tsx. */
  router: "hash" | "browser";
}

export async function detectBuildFlavor(repoRoot: string): Promise<BuildFlavor> {
  const guiDir = resolve(repoRoot, "gui");

  const [hasPnpmWorkspace, hasElectronVite, appTsx] = await Promise.all([
    Bun.file(resolve(repoRoot, "pnpm-workspace.yaml")).exists(),
    Bun.file(resolve(guiDir, "electron.vite.config.ts")).exists(),
    Bun.file(resolve(guiDir, "src", "App.tsx")).text().catch(() => ""),
  ]);

  return {
    packageManager: hasPnpmWorkspace ? "pnpm" : "npm",
    buildTool: hasElectronVite ? "electron-vite" : "vite",
    router: appTsx.includes("HashRouter") ? "hash" : "browser",
  };
}
