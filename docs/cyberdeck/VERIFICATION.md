# Linux and cyberdeck readiness — verification

Status words: **PASS**, **FAIL**, **SIMULATED**, **BLOCKED**, **UNVERIFIED** (NORTHSTAR.md).
Every row names the machine. "Container" is the cloud Linux container this work was done in:
Ubuntu 24.04.5, x86_64, Node 22.22.0, kernel 6.18, no GPU, **no access to the npm registry**.

## Where the toolchain came from (container)

`pnpm install` cannot run in the container (registry DNS fails; the proxy refuses it). Every
tool below came from an upstream GitHub release or tag, or the operator's machine, and is used
for container checks only. None of it is committed.

| Tool                               | Version used                               | Locked version | Source                                                      |
| ---------------------------------- | ------------------------------------------ | -------------- | ----------------------------------------------------------- |
| TypeScript                         | 5.9.3                                      | 5.9.3          | microsoft/TypeScript release tarball                        |
| `@types/node`                      | 22.20.x (DefinitelyTyped `types/node/v22`) | 22.20.4        | DefinitelyTyped HEAD                                        |
| `@types/react`, `@types/react-dom` | 19.3.x                                     | 19.3.0         | DefinitelyTyped HEAD                                        |
| undici-types, csstype              | 6.21.0, 3.2.3                              | same           | upstream tags                                               |
| Prettier                           | 3.9.8                                      | 3.9.8          | operator's `prettier-3.9.8.tgz`                             |
| tsx                                | 4.23.12                                    | 4.23.15        | container global                                            |
| React, react-dom, scheduler        | 19.2.8 / 0.27                              | 19.3.0 / 0.28  | container global                                            |
| esbuild (main bundle only)         | 0.28.2                                     | lockfile's     | container global                                            |
| satellite.js (main bundle only)    | 6.0.2 source                               | 6.0.2          | shashwatak/satellite-js tag                                 |
| Electron (runtime checks)          | 44.5.1 linux-x64                           | 44.5.1         | electron/electron release; SHA-256 matched `SHASUMS256.txt` |
| electron-builder schema            | 26.15.3 `scheme.json`                      | 26.15.3        | electron-userland/electron-builder tag                      |

Third-party libraries the typecheck cannot find are replaced by `tools/dev/type-shims`
declarations; their results are weaker evidence than a real install (see M0).

## M0 — baseline at `092133a` (v0.2.2), container, 2026-10-08

| Gate            | Command                                                                                                                | Result                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| install         | `pnpm install --frozen-lockfile`                                                                                       | **BLOCKED**: `ENOTFOUND registry.npmjs.org`; proxy CONNECT 403                                                                                                                                                                       |
| format          | `prettier --check .` (3.9.8)                                                                                           | **PASS**: all files formatted                                                                                                                                                                                                        |
| lint            | `pnpm lint`                                                                                                            | **BLOCKED**: typescript-eslint not installable in the container                                                                                                                                                                      |
| typecheck       | **same 19 shim-only errors as baseline, none new** (identical file and message set; only positions in `main.ts` moved) |
| boundary-check  | `node tools/dev/boundary-check.mjs`                                                                                    | **PASS**: 977 files, 0 violations                                                                                                                                                                                                    |
| test            | `node tools/dev/run-tests.mjs`                                                                                         | 324 files, **1,899 pass, 43 fail**: every failure is a file importing a package that is not installed (react 42, react-dom 1, @duckdb/node-api 3, @cesium/engine 2, maplibre-gl 2). With React linked, those files: **215/215 pass** |
| provider:test   | `provider:test --all`                                                                                                  | **PASS**: 16 pass, 0 fail                                                                                                                                                                                                            |
| connector:test  | `connector:test --all`                                                                                                 | **FAIL (pre-existing)**: 36/38 definitions pass; `nifc-wfigs-perimeters` (lat 19.63, expected 19.6) and `nws-wwa-mapserver` (21.475, expected 21.4). Not in CI or the Windows gate                                                   |
| license-audit   | `license-audit`                                                                                                        | **PASS**: 44/44 providers, 0 errors, 0 warnings                                                                                                                                                                                      |
| stage:resources | `stage-resources.mjs --check`                                                                                          | **PASS**: up to date                                                                                                                                                                                                                 |
| build / package | `pnpm build`, `release:package`                                                                                        | **BLOCKED** in the container (no Vite, Electron, electron-builder)                                                                                                                                                                   |

Reference baseline on Windows (from the project record, not re-run here): the laptop's 16-step
gate at `092133a`, 2026-10-05: 16/16 exit=0; tests 2,125 pass / 5 skipped; installer exit=0.

### v0.2.2 on Linux, before any change (container, 2026-10-08 16:33 HST)

The released `WorldView-Portable-0.2.2.zip` (SHA-256 `29eaccbd…6d7`, matches the release's
`SHA256SUMS.txt`) had its `app.asar` placed into the official Electron 44.5.1 linux-x64 build
and was launched under Xvfb, as an unprivileged user, sandbox on, D-Bus session, no keyring.

| Check                                                                                                                                       | Result                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boots, single instance, migrations, 44 providers, `runtime started`                                                                         | **PASS**                                                                                                                                                |
| User data at `~/.config/@worldview/desktop` (XDG via Electron)                                                                              | **PASS**                                                                                                                                                |
| Renderer mounts through `worldview://app` (watchdog found `#root` children; screenshot shows the welcome dialog, lenses, sources, timeline) | **PASS**                                                                                                                                                |
| Chromium sandbox on, no `--no-sandbox` (container allows unprivileged user namespaces)                                                      | **PASS** (does not represent Ubuntu 24.04+'s AppArmor restriction)                                                                                      |
| DuckDB                                                                                                                                      | **expected fallback**: the zip carries only the Windows binding; "DuckDB backend unavailable, falling back to NDJSON", reason logged, history in NDJSON |
| Keyring                                                                                                                                     | "OS secure storage unavailable" startup finding                                                                                                         |
| Map                                                                                                                                         | **SIMULATED/no GPU**: "WebGL2 blocklisted"; MapLibre's "WebGL2 is required" error                                                                       |

## M1 — native Linux app and packaging (branch `feature/linux-cyberdeck-readiness`)

### Container checks on M1 (both commits)

| Gate                             | Result                                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format                           | **PASS** (Prettier 3.9.8 `--write`, then clean)                                                                                                                                                                                        |
| boundary-check                   | **PASS**: 979 files, 0 violations                                                                                                                                                                                                      |
| typecheck                        | **same 19 shim-only errors as baseline, none new** (same files and messages; line numbers in `main.ts` shifted by the edit)                                                                                                            |
| test (whole suite, React linked) | **PASS**: 327 files, **2,135 pass, 0 fail, 16 skipped** on the first commit; **2,137 pass, 0 fail, 16 skipped** on the second (skips: DuckDB/Cesium/MapLibre not installed)                                                            |
| New tests                        | `credential-store-linux.test.ts` 13, `assert-version-linux.test.ts` 6, `packaging.test.ts` +3, `no-webgl.test.ts` 1, all pass. Mutation check: disabling the Linux backend check and the 0600 mode made 5 of the credential tests fail |
| electron-builder config          | **PASS**: the whole `electron-builder.yml` validates against electron-builder 26.15.3's `scheme.json` (Ajv); a bogus `linux` key is rejected (negative control); the v0.2.2 file also validates                                        |
| `.deb` Depends on Ubuntu 24.04   | **PASS** (apt metadata): `libgtk-3-0t64` provides `libgtk-3-0`, `libatspi2.0-0t64` provides `libatspi2.0-0`; libnss3, libxss1, libxtst6, xdg-utils, libuuid1, libsecret-1-0 present                                                    |
| lint                             | **BLOCKED** in the container; written to the repo's rules (prefer-const, no-unused-vars, no-useless-escape) — CI decides                                                                                                               |

### Independent review of the first M1 commit

A separate agent reviewed commit `22a1b64` against electron-builder 26.15.3's source and
Chromium's `key_storage_util_linux.cc`. Confirmed and fixed in the second commit:

1. **The `.deb` could not have built**: fpm requires a project homepage (`FpmTarget`
   "Please specify project homepage"); none was set. → `homepage` in `apps/desktop/package.json`,
   held by a test.
2. **The AppImage would have run unsandboxed on Ubuntu 24.04+**: electron-builder's AppRun adds
   `--no-sandbox` whenever `unshare -Ur true` fails, and defaults the desktop entry to
   `--no-sandbox`; no option disables it. The smoke script would have reported "sandbox on"
   because it only knew what it passed. → no AppImage target; the smoke test now reads every
   app process's command line from `/proc` (negative control below).
3. **The GNOME Keyring CI check could not have passed**: Chromium picks `basic_text` on any
   desktop it does not recognise (CI sets none), even with a keyring running — and so would
   sway/i3/Hyprland/LXQt users. → WORLDVIEW passes `--password-store=gnome-libsecret` except on
   KDE; still refused when no Secret Service answers (observed below).

Not acted on: the smoke test's mount signal depends on the watchdog's media probe succeeding
(a suspicion, not observed); `gnome-keyring-daemon` in CI may need more than `--unlock` +
`--start` to create a default collection (the CI run will say).

### The branch's main process on Linux Electron (container, SIMULATED display)

The branch's `main.ts` bundled with esbuild (same options as `build-main.mjs`) replaced v0.2.2's
`dist/main/main.cjs` (renderer and preload from v0.2.2, which this branch does not change except
the no-WebGL message), run with Electron 44.5.1 linux-x64 under Xvfb by
`apps/desktop/scripts/smoke-linux.mjs --expect-history ndjson --expect-keyring refused`:

First commit (no `--password-store` switch):

```
"ok": true, "firstLaunchMs": 5010, "secondLaunchMs": 5011,
"historyBackend": "ndjson" (Windows-only binding in this tree — expected),
"keyring": { "backend": "basic_text", "usable": false },
"providers": 44, "settingsPersisted": true,
"webgl": "unavailable (expected on a virtual display …)"
```

Second commit (switch on, no Secret Service, D-Bus session bus present):

```
"ok": true, "keyring": { "backend": "gnome_libsecret", "usable": false },
"settingsPersisted": true,
"sandbox": "on: none of 7 app processes (browser, gpu-process, renderer, utility, zygote) has --no-sandbox"
```

Negative control: the same build launched through a wrapper that adds `--no-sandbox` →
`"ok": false`, `"sandbox": "OFF in 6 process(es)"`, one problem line per process.

So on Electron 44.5.1/Linux with no Secret Service: without the switch the backend is
`basic_text`; with it, `gnome_libsecret` reporting encryption unavailable. The branch refuses to
store keys in both. The same script against
unmodified v0.2.2 reports the keyring state as unknown (v0.2.2 does not log it) — the script
says so rather than guessing.

### Still to run (needs the operator)

| Check                                                                                                                              | Where                                  | Status                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Linux `pnpm install --frozen-lockfile`, lint, real-library typecheck, tests                                                        | CI `linux` job                         | **UNVERIFIED** until the job runs                                                                                         |
| `.deb` build; `assert-version --platform linux`; SBOM; hashes                                                                      | CI `linux` job                         | **UNVERIFIED**                                                                                                            |
| `.deb` contents: menu entry validates, Linux DuckDB binding unpacked, AppArmor profile present                                     | CI `linux` job                         | **UNVERIFIED**                                                                                                            |
| `apt install ./worldview_*.deb` on a clean Ubuntu 24.04 runner; sandbox under AppArmor                                             | CI `linux` job                         | **UNVERIFIED**                                                                                                            |
| Installed app smoke: DuckDB loads (`duckdb-parquet`), keys refused without keyring, usable with GNOME Keyring, restart persistence | CI `linux` job                         | **UNVERIFIED**                                                                                                            |
| `apt remove` leaves user data                                                                                                      | CI `linux` job                         | **UNVERIFIED**                                                                                                            |
| Windows still packages and passes its gate                                                                                         | CI `windows` job or laptop `check.bat` | **UNVERIFIED on this branch** (Windows code paths unchanged by design; `package.mjs` dispatches to the same `--win` flag) |
| Real GPU (Radeon 740M + Mesa), 2D/3D, multi-monitor, fractional scaling                                                            | P16s on Ubuntu                         | **UNVERIFIED**                                                                                                            |
| Install from menu, launch with no dev tools, offline packs load                                                                    | P16s on Ubuntu                         | **UNVERIFIED**                                                                                                            |

How to run the CI half (operator, PowerShell or any shell with `gh`):

```bash
git push origin feature/linux-cyberdeck-readiness
gh workflow run build-desktop.yml --ref feature/linux-cyberdeck-readiness -f ref=feature/linux-cyberdeck-readiness
gh run list --workflow build-desktop.yml --branch feature/linux-cyberdeck-readiness --limit 1
```

Artifacts `worldview-linux-x64` (the `.deb`, `SHA256SUMS.txt`, SBOM, verification report,
`linux-smoke-*.json`, `.deb` contents) and `worldview-windows-x64`. Nothing is released.

## Hardware test matrix

| #   | Test                                                                                           | Environment                      | Evidence wanted                                      | Status          |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------- | --------------- |
| H1  | Machine identity: `sudo dmidecode -s system-product-name`, `lscpu`, `lspci -nn \| grep -i vga` | P16s, Ubuntu live USB or install | output pasted                                        | UNVERIFIED      |
| H2  | `.deb` install, menu launch, no terminal                                                       | P16s Ubuntu                      | screenshot + `app.log` head                          | UNVERIFIED      |
| H3  | 2D PMTiles and 3D globe draw; `glxinfo -B`                                                     | P16s Ubuntu                      | screenshots, Diagnostics GPU line                    | UNVERIFIED      |
| H4  | Keyring: save and use an API key                                                               | P16s Ubuntu (GNOME)              | Settings shows key stored; `secure storage` log line | UNVERIFIED      |
| H5  | History in DuckDB after restart                                                                | P16s Ubuntu                      | Diagnostics history line                             | UNVERIFIED      |
| H6  | Multi-monitor and 125%/150% scaling                                                            | P16s + external display          | screenshots                                          | UNVERIFIED      |
| H7  | Wi-Fi off, Ethernet out: start, offline basemap, search, history                               | P16s                             | screenshots + log showing no WAN                     | UNVERIFIED (M2) |
| H8  | External SSD removed/re-inserted while running                                                 | P16s + 2 TB SSD                  | log + UI state                                       | UNVERIFIED (M2) |
| H9  | RTL-SDR + 1090 MHz antenna → readsb → aircraft on map                                          | P16s + RTL-SDR                   | `lsusb`, decoder stats, screenshot                   | UNVERIFIED (M3) |
| H10 | T-Beam over USB: node, battery, GNSS fix or NO FIX                                             | P16s + T-Beam                    | `ls -l /dev/serial/by-id`, screenshot                | UNVERIFIED (M4) |
| H11 | Suspend/resume; unplug/replug serial and SDR                                                   | P16s                             | log, CPU via `top`                                   | UNVERIFIED (M5) |
| H12 | Idle RSS / CPU / battery drain, Field vs Docked                                                | P16s on battery                  | measured table with conditions                       | UNVERIFIED (M5) |

## Acceptance tests (definition of done per phase)

- **M1**: CI `linux` green on the branch, including installed-app smoke with `duckdb-parquet`;
  Windows gate 16/16 on the branch; H2–H6 on the P16s.
- **M2**: H7, H8; packaged offline-gate tests green in CI.
- **M3**: fixture tests for aircraft.json edge cases green; H9 with real frames, or the source
  showing a healthy receiver with zero aircraft.
- **M4**: serial transport fixture tests (connect, disconnect, malformed frames, no fix) green;
  H10.
- **M5**: H11, H12.
- **M6**: unauthorized, remote, oversized and policy-restricted requests fail closed in tests;
  a separate unprivileged client reads an allowed bounded set.
