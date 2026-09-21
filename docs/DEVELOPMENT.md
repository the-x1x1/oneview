# Development

## Prerequisites
- Node 22 LTS (`.nvmrc`), pnpm 10.28.0 (`corepack enable && corepack prepare pnpm@10.28.0 --activate`)
- Windows 10/11 x64 for packaging the desktop app (builds also run on Linux/macOS for tests)

## Clone / install / dev
```
git clone https://github.com/the-x1x1/oneview.git worldview && cd worldview
pnpm install
pnpm dev            # Electron + Vite dev server
```

## Verify
```
pnpm typecheck      # whole workspace as source (node + renderer programs)
pnpm test           # node:test via tsx; groups: test:unit | test:contract | test:integration | test:offline | test:failure
pnpm boundary-check # dependency-direction rules (fails closed)
pnpm provider:test usgs   # provider contract checklist → artifacts/verification/providers/<id>.json
pnpm lint && pnpm format:check
```

## Layout
- `packages/*` code boundaries (never network services). Consumed as TypeScript source; bundlers emit.
- `providers/*` one directory per provider: `src/manifest.ts`, `src/normalize.ts`, `src/index.ts`, `test/contract/plan.ts`.
- `fixtures/<provider>/` deterministic fixtures (synthetic where redistribution is not permitted; `recorded/` for captured payloads).
- `tools/*` CLIs: provider-validator, provider-recorder, worldpack, benchmark, license-audit, release, doctor.
- `apps/desktop` Electron main / preload / renderer.

## Provider development
See docs/providers/BUILDING-A-PROVIDER.md. Flow: create provider → manifest → data policy (+ record in config/licenses/providers.json) → normalizer → fixtures → `pnpm provider:test <dir>` → register in providers/registry → done. No renderer changes are needed.

## Environments without registry access
`bash tools/dev/link-local-toolchain.sh` links a globally installed typescript/tsx/@types/node into `node_modules` so typecheck and tests run; this is a workaround, not a build path.

## Desktop package
```
pnpm build && pnpm release:package   # → apps/desktop/release/WorldView-Setup-x.y.z.exe, WorldView-Portable-x.y.z.zip
pnpm sbom && pnpm release:verify     # → artifacts/release/*.sbom.json, SHA256SUMS.txt, verification-report.json
```
