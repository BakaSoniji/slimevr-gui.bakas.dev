# slimevr-gui.bakas.dev

Web-hosted version index for [SlimeVR GUI](https://github.com/SlimeVR/SlimeVR-Server). Builds and serves multiple GUI versions as static sites, with automatic server version detection.

## How it works

- **Index page** (Astro) lists all deployed GUI versions at `/`
- **Each version** is a patched SlimeVR GUI build served at `/{version}/`
- **Version detection** probes the local SlimeVR Server via WebSocket to identify its version using FlatBuffers vtable slot counting, then highlights compatible versions
- **Version mismatch warning** is injected into each GUI build — if the GUI version doesn't match the running server, the version pill turns amber with a tooltip

## Architecture

```
Flux (watches SlimeVR-Server releases)
  → repository_dispatch → GitHub Actions
    → discover new versions
    → build matrix (patch + vite build + smoke test)
    → upload to S3
    → update versions.json + schema-fingerprints.json
    → rebuild index page
    → CloudFront invalidation
```

## Local development

```bash
bun install

# Build a GUI version locally
bun scripts/dev-build-gui.ts --version 0.16.0 --repo /path/to/SlimeVR-Server

# Start dev server (serves index page + built GUI versions)
bun run dev
# Index: http://localhost:4321/
# GUI:   http://localhost:4321/0.16.0/

# Regenerate protocol fingerprints
bun scripts/explore-protocol.ts --server-repo /path/to/SlimeVR-Server --output protocol-exploration.json
bun scripts/extract-schema-fingerprints.ts --input protocol-exploration.json --output schema-fingerprints.json
cp schema-fingerprints.json public/
```

## Scripts

| Script | Purpose |
|--------|---------|
| `dev-build-gui.ts` | Build a specific GUI version locally |
| `dev-dump-settings-request-bytes.ts` | Generate the RPC binary template |
| `patch-for-deploy.ts` | Patch GUI source for web deployment |
| `detect-build-flavor.ts` | Detect package manager, build tool, router type |
| `verify-paths.ts` | Validate built output has correct base paths |
| `serve.ts` | Static file server with SPA fallback (CI smoke tests) |
| `explore-protocol.ts` | Extract protocol schema data across versions |
| `extract-schema-fingerprints.ts` | Generate compact fingerprints for version detection |
| `ci-discover-versions.ts` | Diff upstream releases vs deployed versions |
| `ci-update-versions-json.ts` | Add/update version entries |

## Version detection

The probe system works by sending empty RPC requests to the SlimeVR Server and counting FlatBuffers vtable slots in the responses. Different server versions have different schema field counts, creating a unique fingerprint per version era.

Fingerprints cover v0.2.0 through latest, with 12 measurements across 5 probe types. The matching supports both "exact" mode (field count must match) and "upper-bound" mode (server may populate fewer fields than the schema defines).

## Build compatibility

| Version range | Build tool | Package manager | Router |
|---------------|-----------|----------------|--------|
| v0.5.0 – v0.6.x | Vite 3–4 | npm | BrowserRouter |
| v0.7.0 – v0.11.x | Vite 4 | npm | BrowserRouter |
| v0.12.0+ | Vite 4–5 | pnpm | BrowserRouter |
| v19.0.0-rc.1+ | electron-vite (Vite 5) | pnpm | HashRouter |

Versions before v0.5.0 used Webpack and are not supported.
