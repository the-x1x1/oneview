# Linux and cyberdeck readiness — architecture

Baseline: `develop` at `092133a` (v0.2.2), inspected 2026-10-08. This document says what of the
existing system is kept, what is extended, what is new, and what is deferred, and how Linux
support fits without forking anything.

## The system as it is (verified in the repository)

| Area            | What exists                                                                                                                                                                                                                                                          | Linux relevance                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain       | pnpm 10.28.0, Node ≥22.12 <25, TypeScript 5.9 monorepo; `apps/desktop` Electron 44.5.1, React 19.3, Vite 8, Cesium (`@cesium/engine`), MapLibre + PMTiles                                                                                                            | Electron, Vite and Node all run on Linux; nothing in the build is Windows-only except the packaging script's flag and the NSIS signing-tool seed        |
| Main process    | `apps/desktop/src/main/*`: `worldview://app` custom scheme (`app-protocol.ts`), CSP in one response header, `sandbox: true` renderer, single-instance lock, renderer watchdog, network gate, credential store, tile cache                                            | Verified booting on Linux Electron 44.5.1 (VERIFICATION.md §M1)                                                                                         |
| Paths           | Everything under `app.getPath('userData')`, which Electron puts at `$XDG_CONFIG_HOME/@worldview/desktop` (default `~/.config/@worldview/desktop`) on Linux and `%APPDATA%\@worldview\desktop` on Windows; dialogs default to `app.getPath('pictures' / 'downloads')` | Already XDG-correct; no Windows paths in code                                                                                                           |
| Credentials     | `credential-store.ts`: Electron `safeStorage`, fails closed when unavailable, never plaintext                                                                                                                                                                        | Needed a Linux check of the _backend_ (see M1)                                                                                                          |
| History         | `packages/history-store`: DuckDB/Parquet default, NDJSON fallback with a recorded reason when the native module will not load                                                                                                                                        | DuckDB ships prebuilt N-API bindings per platform (`@duckdb/node-bindings-linux-x64` is in the lockfile); `asarUnpack` already matches `node-bindings*` |
| Offline         | Work-offline gate at every exit (`network-gate.ts`; loopback always allowed), tile cache, `.worldpack` (zip32, signed publishers, 2 GiB/entry, 8 GiB declared total), offline basemaps (PMTiles)                                                                     | Platform-neutral                                                                                                                                        |
| Local receivers | `providers/readsb-local` (aircraft.json on loopback), `providers/ais-local` (AIVDM over TCP), `providers/meshtastic-local` (TCP client API, port 4403, own wire reader, text ignored), `providers/nmea2000-local`                                                    | TCP/HTTP, and USB serial for meshtastic-local (M4)                                                                                                      |
| Packaging       | `electron-builder.yml`: Windows NSIS + zip; `scripts/package.mjs`: build-then-package, emptied output, `--win` hard-coded; `tools/release`: SBOM, verification report, assert-version (Windows names)                                                                | Needed a Linux target and Linux-aware release checks                                                                                                    |
| CI              | `ci.yml`: every check on ubuntu-latest (no packaging); `build-desktop.yml`: Windows only                                                                                                                                                                             | Needed a Linux packaging + install + smoke job                                                                                                          |

## KEEP / EXTEND / NEW / DEFER

| Feature                                                                      | Decision                        | Where                                                    | Why                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron main/preload/renderer pipeline, `worldview://` scheme, CSP, sandbox | KEEP                            | `src/main`, `src/preload`                                | Works on Linux unchanged (verified)                                                                                                                                         |
| XDG paths via `app.getPath`                                                  | KEEP                            | `main.ts`, `@worldview/config` `dataDirs`                | Already correct; documented in LINUX.md                                                                                                                                     |
| Credential store                                                             | EXTEND                          | `credential-store.ts`, `main.ts`                         | Refuse Linux `basic_text`/`unknown` backends; ask Chromium for libsecret on every desktop but KDE; owner-only file (0600); reason names the fix                             |
| Atomic writes                                                                | EXTEND                          | `packages/core/src/node.ts`                              | Optional `mode` for secrets                                                                                                                                                 |
| Packaging script                                                             | EXTEND                          | `scripts/package.mjs`, new `scripts/platform.mjs`        | Host-platform target table; Windows steps unchanged and Windows-only                                                                                                        |
| electron-builder config                                                      | EXTEND                          | `electron-builder.yml`, `package.json`                   | `linux` deb x64, menu entry, icon, `desktopName`, `homepage` (fpm requires it)                                                                                              |
| Release tooling                                                              | EXTEND                          | `tools/release`                                          | `--platform linux` (.deb only; `latest-linux.yml` checked when present); hashes `.deb`                                                                                      |
| Linux packaged smoke test                                                    | NEW                             | `scripts/smoke-linux.mjs`                                | Installed-app boot, renderer mount, sandbox read from `/proc`, DuckDB, keyring, restart persistence                                                                         |
| Linux CI packaging job                                                       | NEW                             | `build-desktop.yml` `linux`                              | Builds, inspects, installs, smoke-tests, uninstalls; artifacts only, never a release                                                                                        |
| Dev sandbox advice on Ubuntu 24.04+                                          | NEW                             | `scripts/dev.mjs` + `platform.mjs`                       | Explains the setuid/AppArmor fix instead of an opaque abort                                                                                                                 |
| No-GPU map message                                                           | EXTEND                          | `renderer/main.tsx`, `map/gpu-info.ts`                   | Actionable text instead of MapLibre's generic one                                                                                                                           |
| Work-offline gate                                                            | KEEP + test (M2)                | `network-gate.ts`                                        | Packaged/integration tests of blocked WAN (M2)                                                                                                                              |
| External data roots / vault health                                           | NEW (M2)                        | settings + offline registry                              | Operator-granted roots; absent/read-only/low-space states                                                                                                                   |
| Multiple regional `.worldpack`s                                              | KEEP format (M2)                | `packages/offline`                                       | No zip64 rewrite; several packs instead                                                                                                                                     |
| readsb-local                                                                 | EXTEND (M3)                     | `providers/readsb-local`                                 | Diagnostics, provenance, fixtures; decoder installed separately                                                                                                             |
| Meshtastic over USB serial                                                   | EXTEND (M4)                     | `providers/meshtastic-local`                             | One transport adapter beside TCP, same wire reader and node store                                                                                                           |
| Own GNSS position                                                            | EXTEND (M4, done)               | `meshtastic-local` NodeStore `ownFix`                    | The connected node only, from its own reports, never another node's; fix / STALE / NO FIX (no coordinates, off the map) / set by hand; age, satellites, accuracy when given |
| gpsd as a position source                                                    | DEFER                           | —                                                        | The T-Beam is this deck's GPS; gpsd stays optional and is not required or built                                                                                             |
| Field status / profiles / power                                              | NEW (M5, done)                  | existing shell, `field.status`, provider host poll scale | One strip under the top bar; sysfs battery (no UPower); OS sleep/power events; Field ×3 internet polling                                                                    |
| Sunlight / light theme                                                       | DEFER                           | —                                                        | One dark palette and no theme system today; the spec asks for it only if styles support it                                                                                  |
| Local read-only API                                                          | NEW (M6)                        | main process                                             | Opt-in, Unix socket 0600 or loopback + token, bounded, policy-enforced                                                                                                      |
| AppImage                                                                     | DEFER (rule)                    | —                                                        | electron-builder's AppRun adds `--no-sandbox` itself when `unshare -Ur` fails (Ubuntu 24.04+); no option disables it. Needs a sandbox-preserving launcher first             |
| Flatpak / Snap / rpm / arm64                                                 | DEFER                           | —                                                        | Not needed for the P16s; each adds a sandbox model to verify                                                                                                                |
| Bundled SDR decoder binaries                                                 | DEFER (license)                 | —                                                        | GPL; document separate install instead                                                                                                                                      |
| Meshtastic messages / transmit                                               | DEFER (out of scope)            | —                                                        | Receive-only by design                                                                                                                                                      |
| Offline topographic map style (contours, hillshade, trails)                  | DEFER (later, operator request) | basemap catalog + `packages/offline`                     | Builds on the offline terrain source decision; open data only (ROADMAP "Later")                                                                                             |
| Linux auto-update                                                            | DEFER (operator)                | `@worldview/updater`                                     | Unsigned builds only notify; publishing Linux assets is the operator's decision                                                                                             |

## Compatibility strategy

- **One codebase, small adapters.** OS differences live in `scripts/platform.mjs` (packaging and
  development) and in a `platform` option where runtime behaviour differs (credential store). No
  `if (linux)` spread through the app.
- **Windows defaults stay the defaults.** `assertReleaseVersion` checks Windows names unless told
  otherwise; `package.mjs` behaves byte-for-byte as before on Windows (same flag, same seeding,
  same locked-exe probe); the Windows CI job is untouched.
- **Same names on both.** One SBOM name per version (it describes the lockfile), one
  verification report shape; the platform is in the artifact names.
- **Build where you ship.** Linux packages are built on Linux (CI or the P16s), Windows ones on
  Windows. No Docker/Wine cross-builds.

## Dependencies

M1 adds **no** runtime or development dependency. electron-builder (already present) downloads
`fpm` from its own binaries repository at package time on Linux, the same
way it fetches NSIS on Windows. CI installs `xvfb`, `xauth`, `gnome-keyring` and
`desktop-file-utils` on the runner for the smoke test only; the app requires none of them.
The `.deb` declares electron-builder's default `Depends` (GTK 3, NSS, libsecret, xdg-utils…),
which resolve on Ubuntu 24.04 through the `t64` packages' `Provides` (checked against this
container's Ubuntu 24.04 apt metadata).

## Linux runtime facts this work relies on

- **Sandbox.** Ubuntu 23.10+ sets `kernel.apparmor_restrict_unprivileged_userns=1`. electron-builder
  26.15.3's `.deb` post-install script installs `/etc/apparmor.d/worldview` (when AppArmor
  supports it) and only makes `chrome-sandbox` setuid when user namespaces do not work at all.
  An electron-builder AppImage instead turns the sandbox off where namespaces are restricted
  (its AppRun: `unshare -Ur true` fails → `--no-sandbox`), so none is built.
- **Keyring.** Chromium picks the store from `XDG_CURRENT_DESKTOP`: libsecret on GNOME-family
  desktops and XFCE, KWallet on KDE, and `basic_text` on everything else (sway, i3, Hyprland,
  LXQt, no desktop). WORLDVIEW passes `--password-store=gnome-libsecret` except on KDE. Observed
  in this container with Electron 44.5.1 and no Secret Service: without the switch the backend
  is `basic_text`; with it, `gnome_libsecret` with encryption unavailable. Both are refused.
- **GPU.** A virtual display has no GPU; Chromium blocks WebGL there and the map shows its error
  panel. Radeon 740M + Mesa behaviour is UNVERIFIED until run on the P16s.

## Data flow for the later phases (design, not yet built)

```
RTL-SDR ─USB─ readsb (separately installed, 127.0.0.1) ─HTTP aircraft.json─▶ readsb-local ─▶ Observation → WorldObject → WorldEvent
T-Beam ─USB serial─▶ meshtastic-local (serial transport, same wire reader) ─▶ nodes/telemetry (no text)
                                                     └─▶ this node's own fix (fix, age, accuracy; NO FIX = not drawn)
External SSD (operator-granted root) ─▶ offline registry (packs, history) ─▶ health: present / absent / read-only / low space
Runtime ─▶ local read-only API (opt-in; Unix socket 0600 or 127.0.0.1 + token) ─▶ Formicaria (separate app)
```
