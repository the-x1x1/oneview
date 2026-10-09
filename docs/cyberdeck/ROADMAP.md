# Linux and cyberdeck readiness — roadmap

Branch: `feature/linux-cyberdeck-readiness`, from `develop` `092133a` (v0.2.2). Nothing here is
merged, tagged or published without the operator. Status words are defined in
[NORTHSTAR.md](NORTHSTAR.md); evidence is in [VERIFICATION.md](VERIFICATION.md).

| Milestone                                                                         | Priority | Depends on                   | Status                                                                                                                                                         |
| --------------------------------------------------------------------------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Baseline, docs, truth matrix                                                 | P0       | —                            | **Done** (container baseline; Windows/CI baseline is v0.2.2's gate)                                                                                            |
| M1 — Native Linux app, packaging, keyring/XDG/DuckDB, Linux CI, Windows preserved | P0       | M0                           | **Code done; packaging evidence pending CI run.** Runtime verified on Linux Electron in a container; `.deb` build + install + smoke written as CI, not yet run |
| M2 — Offline field reliability, external SSD vault                                | P0       | M1                           | Not started                                                                                                                                                    |
| M3 — RTL-SDR → readsb → local aircraft                                            | P1       | M1 (M2 for offline proof)    | Not started; physical test UNVERIFIED until hardware                                                                                                           |
| M4 — T-Beam USB serial + own GNSS                                                 | P1       | M1                           | Not started; physical test UNVERIFIED until hardware                                                                                                           |
| M5 — Field status, profiles, power evidence                                       | P2       | M3, M4                       | Not started                                                                                                                                                    |
| M6 — Local read-only API for Formicaria                                           | P2       | M1                           | Not started                                                                                                                                                    |
| M7 — Full gates, operator docs, disconnected acceptance                           | P0/P1    | all                          | Not started                                                                                                                                                    |
| Later — Offline topographic map style (Topo GPS-like)                             | P3       | M2, offline terrain decision | Requested by the operator 2026-10-08; not scheduled                                                                                                            |

## M1 — what was done

- `apps/desktop/scripts/platform.mjs` (new): the packaging target for the host (Windows →
  NSIS + zip, Linux x64 → `.deb`, anything else refused) and the Ubuntu 24.04+
  sandbox advice for `pnpm dev`.
- `scripts/package.mjs`: target from the table instead of a hard-coded `--win`; the signing-tool
  seed and the locked-exe probe stay Windows-only; build-first, emptied output and
  `--publish never` unchanged.
- `electron-builder.yml`: `linux` (deb x64, `executableName: worldview`, icon, category,
  desktop entry, `syncDesktopName`) and the `deb` artifact name; validated against
  electron-builder 26.15.3's `scheme.json`. `package.json` `desktopName` and `homepage` (fpm
  refuses to build a `.deb` without one).
- `credential-store.ts` + `main.ts`: refuses Linux `basic_text`/`unknown` backends; asks
  Chromium for libsecret on every desktop but KDE (otherwise sway/i3/Hyprland/LXQt users could
  never save a key, keyring or not); credentials file 0600;
  the startup finding and the log say which backend and how to fix it. `writeFileAtomic` takes
  a `mode`.
- `scripts/dev.mjs`: prints the exact `chrome-sandbox` fix on Ubuntu 24.04+.
- Renderer: an actionable map message when there is no WebGL2.
- `tools/release`: `release:assert-version --platform linux` (the `.deb`, which must be hashed;
  `latest-linux.yml` checked when present; any AppImage or Windows file is foreign); the
  verification report hashes `.deb`.
- `scripts/smoke-linux.mjs` (new): installed-app smoke test; reads the sandbox state of every
  app process from `/proc`.
- `build-desktop.yml`: `linux` job (full checks, package, inspect and validate the `.deb`,
  install with apt, smoke test without and with GNOME Keyring, uninstall keeps user data,
  artifacts only).
- Docs: this folder, including [LINUX.md](LINUX.md).
- An independent review of the first M1 commit found three blockers, all fixed in the second:
  no `homepage` (the `.deb` would not have built), the AppImage launcher's own `--no-sandbox`,
  and Chromium's desktop-based keyring choice (the GNOME Keyring CI check could not have
  passed).

## M1 — what is left before it can be called done

1. Operator pushes the branch and dispatches `build-desktop.yml` on it (commands in
   VERIFICATION.md). The `linux` job is the first real `.deb` build, the first
   Linux `pnpm install --frozen-lockfile`, lint and real-library typecheck on this branch, and
   the first proof that the Linux DuckDB binding loads from a package.
2. Windows: the job's `windows` half (or the laptop's `check.bat` 16-step gate) on this branch.
3. On the P16s under Ubuntu: install the `.deb`, launch from the menu, 2D and 3D on the Radeon
   740M, restart persistence, multi-monitor / fractional scaling. (Hardware checklist.)

## Next (M2), in order

1. Packaged/integration tests of the work-offline gate: blocked WAN through each exit, loopback
   allowed. Note for the cyberdeck: while working offline, HTTP/WebSocket to the LAN is blocked
   too (`network-gate.test.ts`: "the internet and the LAN do"); raw-TCP receivers (Meshtastic,
   NMEA 2000, AIS over TCP) are not fetches and keep running. A readsb on another machine would
   therefore stop offline; on the cyberdeck everything is on loopback, so this does not bite.
2. Operator-granted external data roots (settings + safe path resolution), internal state kept
   on the internal SSD.
3. Vault health: absent / ejected / read-only / low space / remounted; pause and resume, never
   write through a broken mount.
4. Oahu exemplar workflow with multiple regional packs and a SHA-256 bundle manifest.
5. Start-up and shut-down with SSD, RTL-SDR and T-Beam all absent.

## Later — offline topographic map style

Requested by the operator (2026-10-08): a topographic view like the Topo GPS app, selectable
as one of the offline map choices. Down the line, behind M1–M7.

What it would be: a 2D (and draped 3D) basemap style with contour lines, hillshade, terrain
and water features, trails, peaks and spot heights, readable at field zoom levels, chosen in
the same basemap picker as the existing offline PMTiles map and working with WAN disabled.

How it fits what exists, rather than a new system:

- **Elevation** comes from the source chosen in `docs/roadmap/OFFLINE-TERRAIN.md` (Mapterhorn
  Terrarium PMTiles, or NOAA ETOPO 2022 as the public-domain fallback): hillshade drawn from
  it by MapLibre's `hillshade` layer, contours either generated client-side from the DEM
  (the approach of the open-source `maplibre-contour` library; no server) or pre-built into vector tiles at pack time.
- **Features** (trails, peaks, water, landcover) come from an OSM-derived vector PMTiles
  extract with a topographic style — Protomaps' basemap schema already carries most of them.
- **Packaging**: regional `.worldpack`s within the existing zip32 limits (Oahu first), with
  attribution per source, through the license audit before anything ships.
- **Not** a re-host of Topo GPS's own maps or any commercial topo tiles: their licences do not
  allow it. The look is the goal, the data must be open.

Open before it can start: the offline terrain source decision, the license review of every
data source, pack size per region, and whether contours are generated live or at pack time.

## Decisions taken (conservative; reversible)

- Linux packages are built on Linux only (CI or the laptop); no Docker/Wine cross-builds.
- **No AppImage** (the prompt asked for one). electron-builder's AppImage launcher appends
  `--no-sandbox` whenever `unshare -Ur` fails — Ubuntu 24.04+ by default — with no option to
  stop it, which breaks the never-unsandboxed rule on the target OS. `.deb` only until a
  sandbox-preserving portable build exists (a custom launcher, or a tarball run from an
  installed AppArmor profile); worth revisiting if another distribution matters.
- Linux builds are CI artifacts only: no draft release, nothing uploaded to a release.
- On Linux WORLDVIEW passes `--password-store=gnome-libsecret` except on KDE (a user's own
  `--password-store` wins).
- No MIME/file associations until something opens by double-click.
- No GPU command-line switches; behaviour on the 740M is measured before anything is forced.

## Open decisions for the operator

- Publishing Linux assets on a release, and whether Linux builds should notify of updates
  (unsigned builds only notify; with no Linux assets published the check reports none).
- The user-data folder name (`@worldview/desktop`) on both platforms.
- The two pre-existing `connector:test --all` failures (VERIFICATION.md §M0) — fix the example
  fixtures or the expectation; neither is part of the Windows gate or CI today.
