# Cyberdeck readiness checklist

One line per thing that has to be true before WORLDVIEW is called ready on the P16s cyberdeck:
who proves it, where, with what evidence, and where it stands. Statuses follow
[NORTHSTAR.md](NORTHSTAR.md): **PASS** (run, evidence recorded), **FAIL**, **UNVERIFIED** (not
yet run where it counts), **BLOCKED** (cannot run here; says why), **EXPECTED EXCEPTION**
(fails for a known reason outside this work, recorded, not hidden).

Owners: **container** — Claude's Linux container (no USB, no GPU, no battery, no npm
registry); **CI** — the `Build desktop` workflow on GitHub (Ubuntu 24.04 / Windows); **operator**
— on the P16s, by hand. Automatic evidence (container, CI) and operator-observed results are kept
in separate columns of the record: the container never stands in for hardware.

State as of branch head after M7 (`feature/linux-cyberdeck-readiness`), 2026-10-08.

## Quality gates

| Gate                                    | Owner     | Environment                  | Evidence                                                               | Status                                                                                                                                                |
| --------------------------------------- | --------- | ---------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`        | CI        | Ubuntu 24.04, Windows        | workflow log                                                           | UNVERIFIED on the branch (container: BLOCKED, no npm registry)                                                                                        |
| `pnpm format:check`                     | container | Prettier 3.9.8               | VERIFICATION.md §M7                                                    | PASS                                                                                                                                                  |
| `pnpm lint`                             | CI        | ESLint from the lockfile     | workflow log                                                           | UNVERIFIED (container: BLOCKED, ESLint not installable)                                                                                               |
| `pnpm typecheck`                        | container | TypeScript 5.9.3, type shims | the same 19 shim-only errors as the v0.2.2 baseline, none new          | PASS against baseline; real-types run is CI's                                                                                                         |
| `pnpm boundary-check`                   | container | —                            | 1,007 files, 0 violations                                              | PASS                                                                                                                                                  |
| `pnpm test`                             | container | Node 22, Linux               | `artifacts/verification/tests/all.json`                                | PASS (VERIFICATION.md §M7 has the count)                                                                                                              |
| `pnpm provider:test --all`              | container | —                            | all providers PASS                                                     | PASS                                                                                                                                                  |
| `pnpm connector:test --all`             | container | —                            | 36 / 38                                                                | EXPECTED EXCEPTION: `nifc-wfigs-perimeters`, `nws-wwa-mapserver` example fixtures disagree with their expected latitudes since before this work (§M0) |
| `pnpm license-audit`                    | container | —                            | 0 errors                                                               | PASS                                                                                                                                                  |
| `pnpm stage:resources -- --check`       | container | —                            | up to date                                                             | PASS                                                                                                                                                  |
| `pnpm build`                            | CI        | Vite 8                       | workflow log                                                           | UNVERIFIED (container: BLOCKED, Vite not installable)                                                                                                 |
| Linux package build (`.deb`)            | CI        | Ubuntu 24.04                 | `worldview-linux-x64` artifact, SHA256SUMS, SBOM, `assert-version`     | UNVERIFIED — job written, not yet run (needs the branch pushed)                                                                                       |
| Packaged-app smoke test                 | CI        | apt-installed `.deb`, Xvfb   | `smoke-linux.mjs` JSON, with and without a keyring                     | UNVERIFIED in CI; the same script PASSES on the official Electron with the branch's main process in the container                                     |
| `test:offline` with the network blocked | container | `WORLDVIEW_NETWORK=off`      | offline group 4/4; strace: 0 DNS, 0 outside connects with Work offline | PASS (container); CI runs the trace on the installed `.deb`                                                                                           |
| Windows build and regression            | CI        | windows-latest               | the Windows job on the branch                                          | UNVERIFIED on the branch — Windows paths are kept (Linux-only code is gated by platform) but the shared main process changed; CI must show it         |

## Field acceptance (the final demonstration, on the P16s, no cloud)

| #   | What                                                                                              | Owner         | Container / CI substitute evidence (not hardware proof)                                       | Proof wanted on the laptop                                  | Status           |
| --- | ------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| A   | Ubuntu boots; WORLDVIEW installed from the `.deb`; launched from the menu, no terminal            | operator      | CI installs the `.deb` and starts it under Xvfb                                               | screenshot, `app.log` head (H2)                             | UNVERIFIED       |
| B   | Wi-Fi off, Ethernet out: no WAN attempts; loopback allowed                                        | operator      | strace trace: 0 DNS / 0 outside with Work offline; control run reaches out (§M2)              | `offline-trace-linux.mjs` on the laptop, screenshots (H7)   | UNVERIFIED       |
| C   | O'ahu PMTiles basemap, search a saved place, local history, restart, still there                  | operator      | offline runtime test searches a pack on a vault; settings survive a restart (smoke)           | screenshots before and after restart (H5, H7)               | UNVERIFIED       |
| D   | T-Beam by USB: node telemetry; with a lock, position with fix time and accuracy; NO FIX otherwise | operator      | serial transport and provider over a pseudo-terminal: fix, STALE, NO FIX off the map (§M4)    | `ls -l /dev/serial/by-id`, screenshots of both states (H10) | UNVERIFIED       |
| E   | RTL-SDR + 1090 MHz antenna: real frames, real aircraft; none heard → healthy, zero                | operator      | real readsb 3.16.17 fed textbook frames, end to end (§M3)                                     | `lsusb`, readsb stats, screenshot (H9)                      | UNVERIFIED       |
| F   | Pull the SSD while running: packs missing, app up, replug recovers, nothing written wrong         | operator      | vault tests: pulled, empty mount point never written, replugged (§M2)                         | log + UI state (H8)                                         | UNVERIFIED       |
| G   | Suspend/resume; unplug/replug serial and SDR; no runaway CPU or log spam                          | operator      | serial unplug → OFFLINE and backoff (pty); `powerMonitor` wired, resume re-checks (§M4, §M5)  | log, `top` (H11)                                            | UNVERIFIED       |
| H   | Linux installation works and the Windows package and tests still pass                             | CI + operator | —                                                                                             | both CI jobs green on the branch                            | UNVERIFIED       |
| I   | Local API: authorised and unauthorised clients, policy refusals                                   | container     | separate client process, other user refused, mesh never given, in the real Electron app (§M6) | the same on the laptop if wanted                            | PASS (container) |

Measurements (H12: idle memory, CPU, GPU, battery draw, Field vs Docked) are taken with
`apps/desktop/scripts/measure-linux.mjs` on battery with a `--baseline` run (FIELD.md):
**UNVERIFIED** until run on the laptop.

## Failure cases with tests

| Case                 | Test                                                                                                                  | Status                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Device disconnects   | serial unplug (`serial-stream.test.ts`, `meshtastic-serial.test.ts`); decoder stopped (`readsb-local` field tests)    | PASS                    |
| Missing keyring      | `credential-store-linux.test.ts` (basic_text / unknown refused); smoke `--expect-keyring refused` in CI               | PASS (unit); CI pending |
| Missing external SSD | `offline.test.ts`: pulled while running, start with it absent, found again                                            | PASS                    |
| Stale ephemeris      | `celestrak/normalize.test.ts` (aging, expired, too old to propagate), `reproject.ts` age limit                        | PASS                    |
| Radio absent         | `local-hardware.test.ts` (no stick, DVB driver, no permission); readsb "not detected"; serial "nothing is plugged in" | PASS                    |
| No GPS fix           | `nodes.test.ts`, `meshtastic-serial.test.ts`: NO FIX, no coordinates, off the map                                     | PASS                    |

## Guides

[LINUX.md](LINUX.md) (install, files, keyring, graphics, development) ·
[USB-DEVICES.md](USB-DEVICES.md) (permissions, udev, stable names) · [T-BEAM.md](T-BEAM.md) ·
[RTL-SDR.md](RTL-SDR.md) · [EXTERNAL-SSD.md](EXTERNAL-SSD.md) ·
[OFFLINE-FIELD.md](OFFLINE-FIELD.md) · [FIELD.md](FIELD.md) · [LOCAL-API.md](LOCAL-API.md) ·
release: [docs/releases/RELEASE-PROCESS.md](../releases/RELEASE-PROCESS.md) (Linux section).
