# WORLDVIEW — Software licence inventory

Status: **draft for legal review** · Generated 2026-09-21 · Machine-readable twin: [`config/licenses/software.json`](../../config/licenses/software.json) (schema `worldview/licenses/software/v1`)

This file inventories every third-party **software** component WORLDVIEW plans to build on, adapt, ship, launch as a sidecar, talk to as an external process, or merely consult as a reference. It deliberately says nothing about **data**: code licence ≠ data licence. Data providers are in [DATA-SOURCE-LICENSES.md](DATA-SOURCE-LICENSES.md); bundled files in [ASSET-PROVENANCE.md](ASSET-PROVENANCE.md).

Rules used when filling the table:

- A licence is stated only when it comes from package metadata (`package-lock.json` `license` field of the GEV clone at commit `0dbde1e3`), from a repository page read on 2026-09-21, or from a GEV source comment. Anything else is marked **verify**. Nothing was guessed.
- Versions come from GEV's lockfile where WORLDVIEW inherits the dependency. Everything else is `unpinned` because WORLDVIEW has not been scaffolded yet; the release checklist must re-run the notices generator against the real lockfile.
- `integration` distinguishes *how* the code enters the product. The distinction matters for copyleft: `external-service` (readsb) is never distributed; `sidecar` (go2rtc) is a separate binary that may be optionally downloaded; `adapted-source` (GEV, skylight) is compiled into WORLDVIEW.

## 1. Summary

| Count | Meaning |
| --- | --- |
| 37 | software records |
| 35 approved / 2 conditional / 0 excluded / 0 manual-review | commercial review status |
| 20 bundled / 7 optional / 10 not-distributed | what reaches the installer |

The two conditionals are not licence incompatibilities; they are process conditions (see §4).

## 2. Inventory

### 2.1 Adapted source (compiled into WORLDVIEW, modified)

| Component | Version / commit | Licence | Distribution | Review | Notes |
| --- | --- | --- | --- | --- | --- |
| **gods-eye-view** | `0dbde1e36c0177b7664b47702d77ba50f11ddadc` (0.1.1, 2026-09-20) | MIT | bundled | approved | Copyright (c) 2026 Bilawal Sidhu. MIT covers code only ([GEV LICENSE](https://github.com/bilawalsidhu/gods-eye-view/blob/main/LICENSE) lines 25-62 carve out all data/assets). Notice reproduced in `THIRD_PARTY_NOTICES.md` and tracked in `UPSTREAM.md`. |
| **skylight** (cpaczek/skylight), via GEV | commit unknown — **verify** | MIT (per GEV source comments) — **verify upstream LICENSE + copyright holder** | bundled | approved | GEV files that carry skylight-derived logic: `src/data/aircraftClass.js`, `aircraftIcons.js`, `aircraftMeta.js`, `issPass.js`, `motionModel.js`, `routePlausible.js`, `src/layers/{flights,military}/motion.js`, `server/providers/aircraft/enrichment.js`, `server/providers/space/celestrak.js` (GEV-AUDIT-NOTES.md §(f)). This is a **second attribution layer** GEV's own THIRD_PARTY treatment does not surface — WORLDVIEW must credit both. |

### 2.2 Runtime dependencies (bundled in the installer)

| Component | Version | Licence | Review | Obligations / notes |
| --- | --- | --- | --- | --- |
| electron | unpinned | MIT | approved | Ships Chromium (BSD-3-Clause + many) and Node.js (MIT + many). The Electron binary carries `LICENSE` and `LICENSES.chromium.html`; electron-builder keeps them in `resources/` — verify they survive packaging. |
| electron-updater | unpinned | MIT | approved | |
| react, react-dom | unpinned | MIT | approved | |
| cesium (@cesium/engine 22.3.0, @cesium/widgets 14.3.0 in GEV lock) | 1.138.0 (GEV lock) | Apache-2.0 | approved | Apache-2.0 §4: ship LICENSE and reproduce NOTICE content. CesiumJS `LICENSE.md` has a long third-party section (draco, earcut, knockout, mersenne-twister, protobuf, …) — reproduce it in notices. CesiumJS works without Cesium ion; ion is a data provider (see DATA-SOURCE-LICENSES.md). |
| maplibre-gl | unpinned | BSD-3-Clause | approved | Reproduce copyright + disclaimer, including the Mapbox GL JS v1 copyright the fork retains, and its bundled third-party list. Keep `AttributionControl` on. |
| pmtiles | unpinned | BSD-3-Clause | approved | Library only; archive contents are data. |
| @duckdb/node-api (+ @duckdb/node-bindings) | unpinned | MIT (repo page, 2026-09-21) | approved | Disable extension auto-install in a local-first app or vendor extensions explicitly. |
| duckdb (engine) | unpinned | MIT | approved | Include DuckDB's LICENSE (covers its `third_party/`). |
| satellite.js | 6.0.2 (GEV lock) | MIT | approved | |
| egm96-universal | 1.1.1 (GEV lock) | MIT (lock `license` field) | approved | Embeds the NGA EGM96 grid (public domain). Repository URL and copyright holder **verify** before writing the notice line. |
| mgrs | 2.1.0 (GEV lock) | MIT | approved | proj4js contributors. |
| pbf | 5.1.2 (GEV lock) | BSD-3-Clause | approved | Copyright (c) 2017, Mapbox. |
| @mapbox/vector-tile (+ @mapbox/point-geometry, ISC) | 3.0.0 (GEV lock) | BSD-3-Clause | approved | Copyright (c) 2014, Mapbox. Only needed for the optional TomTom flow sub-provider. |
| Material Symbols (self-hosted subset) | unpinned | Apache-2.0 | approved | GEV loads from Google Fonts CDN (`index.html` line 16); WORLDVIEW bundles locally (matrix row 84). Ship Apache-2.0 text. |
| Inter, JetBrains Mono (self-hosted) | unpinned | OFL-1.1 | approved | Only if the design system keeps them. OFL text + copyright must accompany font files; fonts may not be sold alone. |
| Natural Earth physical-region polygons | nvkelso/natural-earth-vector `ca96624a` | Public domain | approved | Data, listed here because it ships in the bundle. Also in providers/assets. |

### 2.3 Optional runtime dependencies (not in Release 1 or candidate only)

| Component | Status | Licence | Review | Notes |
| --- | --- | --- | --- | --- |
| h3-js | candidate | Apache-2.0 | approved | Ship Uber NOTICE if adopted. |
| rbush (+ quickselect, ISC) | candidate | MIT | approved | |
| deck.gl (+ luma.gl, loaders.gl, math.gl) | not R1 | MIT | approved | May pull draco/basis decoders (Apache-2.0). Re-run notices if adopted. |
| gtfs-realtime-bindings | candidate | Apache-2.0 | approved | Replaces GEV's hand-written pbf decoder; pulls protobufjs. No NOTICE file known — **verify**. |
| protobufjs | 8.8.0 (GEV lock, transitive) | BSD-3-Clause | approved | Copyright (c) 2016, Daniel Wirtz. Uses `new Function` code-gen by default — CSP concern, not licence. |
| ws | 8.21.3 (GEV lock) | MIT | approved | Electron's Node ships a global `WebSocket`; ws may be unnecessary. |

### 2.4 Sidecars and external processes

| Component | Version | Licence | Integration | Distribution | Review | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| **go2rtc** | pin **v1.9.14** (latest release page, dated 2026-01-19, read 2026-09-21) | MIT (repo badge) | sidecar | optional, not bundled by default | **conditional** | Condition: WORLDVIEW must not redistribute FFmpeg alongside it. go2rtc optionally execs an external `ffmpeg` binary (FFmpeg is LGPL-2.1+/GPL-2.0+ depending on build); shipping FFmpeg inside a proprietary installer is a separate review. Pin the tag, verify release checksums at download time. |
| **readsb** | user-installed, not pinned | **GPL-3.0** (repo badge) | external-service | **never distributed** | **conditional** | Hard rule: never bundled, linked, vendored, patched or forked into this repo. WORLDVIEW reads readsb's network outputs (`aircraft.json`, Beast TCP) from a process the user installs and runs. Communicating with a separately distributed GPL program over a documented network protocol does not make WORLDVIEW a derivative work. Condition: the installer does not download readsb on the user's behalf; docs link to upstream and never call readsb "part of" WORLDVIEW. |

### 2.5 Build-time only (never in the installer)

| Component | Version | Licence | Notes |
| --- | --- | --- | --- |
| electron-builder | unpinned | MIT | NSIS stub is zlib/libpng; no runtime obligation. |
| vite | 6.4.3 (GEV lock) | MIT | |
| esbuild | 0.25.12 (GEV lock) | MIT | |
| typescript | unpinned | Apache-2.0 | Emitted JS contains no TS-licensed code (tslib is 0BSD). |
| tsx | unpinned | MIT | |
| vite-plugin-cesium | 1.2.23 (GEV lock) | MIT | May be replaced by an explicit asset-copy step. |

### 2.6 Reference-only (no code copied)

| Component | Licence | Notes |
| --- | --- | --- |
| mediamtx | MIT (repo badge, 2026-09-21) | Future go2rtc alternative; same FFmpeg caveat. |
| kepler.gl | MIT | UX reference. If code is ever adapted, reclassify as adapted-source and add the Uber copyright. |
| tileserver-gl | BSD-2-Clause | Reference for local tile serving; not used at runtime. |

## 3. Obligations checklist (what the build must do)

1. **Reproduce notices.** `THIRD_PARTY_NOTICES.md` must be shipped in the installer (and reachable from Help → About). Regenerate it from the real lockfile before every release; the hand-written version in this repo is the seed, not the final artefact.
2. **Apache-2.0 NOTICE files** (cesium, h3-js if adopted, gtfs-realtime-bindings if adopted, Material Symbols): ship LICENSE text and reproduce NOTICE contents.
3. **BSD-3-Clause / BSD-2-Clause** (maplibre-gl, pmtiles, pbf, @mapbox/vector-tile, protobufjs, tileserver-gl if ever used): reproduce copyright + conditions + disclaimer.
4. **MIT** (everything else): reproduce copyright + permission notice. For GEV and skylight this means naming the authors, not just the licence.
5. **OFL-1.1 fonts:** keep the OFL text next to the font files; do not sell fonts separately.
6. **Electron:** keep `LICENSE.electron.txt` and `LICENSES.chromium.html` in `resources/`.
7. **GPL boundary (readsb):** enforce in CI that no `readsb` source, binary or fork enters the repo or the installer (a simple path/dependency denylist test).
8. **FFmpeg boundary (go2rtc):** enforce that the optional go2rtc download step never fetches FFmpeg and that the app does not bundle an `ffmpeg` binary.

## 4. Items for legal sign-off (software only)

| # | Item | Why |
| --- | --- | --- |
| S-1 | readsb (GPL-3.0) external-process boundary | Confirm the "separate program over network protocol" analysis and the rule that the installer never downloads readsb itself. |
| S-2 | go2rtc optional sidecar | Confirm the FFmpeg exclusion and the process for downloading a pinned third-party MIT binary at first use (EULA/consent text). |
| S-3 | skylight attribution | Confirm the upstream copyright holder and licence text before the notice line is finalised. |
| S-4 | Electron notice packaging | Confirm the packaged app retains Chromium/Node licence files. |

## 5. Sources consulted

- GEV `package.json`, `package-lock.json` (licence fields), `LICENSE`, `DATA_SOURCES.md` at commit `0dbde1e3`.
- GEV-AUDIT-NOTES.md §(e), §(f); GEV-MIGRATION-MATRIX.md rows 14, 24, 65, 74, 82, 84, 85.
- Repository pages read 2026-09-21: AlexxIT/go2rtc (+ releases/latest), wiedehopf/readsb, bluenviron/mediamtx, duckdb/duckdb-node-neo.
- The npm registry was not reachable from this environment (egress policy), so "unpinned" versions are stated as such rather than guessed.
