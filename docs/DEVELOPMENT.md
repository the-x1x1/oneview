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

**Windows needs the symlink privilege.** electron-builder's NSIS step downloads
`winCodeSign-2.6.0.7z` and extracts it, and that archive carries macOS symlinks
(`darwin/10.12/lib/libcrypto.dylib`, `libssl.dylib`). Creating a symlink on Windows
requires `SeCreateSymbolicLinkPrivilege`, which an ordinary account holds only with
Developer Mode on. Without it the extraction fails, retries three more times — re-downloading
5.6 MB each attempt — and the run dies _after_ `release/win-unpacked/` has already been
packed correctly, which makes it look like a packaging bug when it is an account privilege.

Turn on **Settings → System → For developers → Developer Mode**, or run the packaging step
from an elevated terminal. `pnpm run doctor` checks for this before you spend the build.

`release/win-unpacked/WorldView.exe` runs directly and needs none of the above; only the
installer and the portable zip do.

## Why `pnpm.onlyBuiltDependencies` is in package.json

pnpm 10 does not run a dependency's install scripts unless the repository names it.
Two here genuinely need theirs: `electron` downloads its runtime binary in a postinstall
step, and `esbuild` fetches its platform binary. Without them `pnpm dev` starts nothing
and `pnpm release:package` has no Electron to package, with only a warning at install
time to say why. They are declared so a fresh clone and CI both work without anyone
running `pnpm approve-builds` by hand.

Nothing else is allowed to run install scripts. Adding to that list means deciding that
a package may execute code on every developer's machine at install time, so it deserves
the same scrutiny as any other dependency decision.
