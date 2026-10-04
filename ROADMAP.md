# Roadmap

Versions describe capability, not marketing. Nothing is held back from a release to
make a label fit (directive §126). Work that several people or agents can build at the
same time is cut into phases — one branch, one owner, one brief each — under
[docs/roadmap/PARALLEL-PHASES.md](docs/roadmap/PARALLEL-PHASES.md); how they come back
together is [docs/roadmap/INTEGRATION.md](docs/roadmap/INTEGRATION.md).

## 0.1.0 — Foundation (release candidates; rc.5 published)

Windows desktop, canonical world model, provider SDK and runtime, twelve providers, 3D
and 2D renderers, search, lenses, selection and context, history and timeline, offline
packs, collections, watch zones, source health, diagnostics, credential storage, updater
architecture, CI and release tooling. Aircraft and ships move between reports; public
cameras show video where the agency publishes it; the operator's own AIS receiver,
weather station and air-quality sensor are sources.

Remaining for 0.1.0 final: human QA of the checklist, the installer run, offline with the
network off; then promotion to `main` (§164).

## 0.2.0 — Sources as data (connector architecture)

The acceleration directive: a source is a JSON definition, the code that runs it is a
connector written once. Landed on `develop` from `feature/connector-architecture`:

- [x] `@worldview/connector-sdk`: definition schema, the no-execution mapping (paths, a
      closed transform registry, conditions), fail-closed data policy, endpoint policy
      (https/wss, public hosts, no credentials in URLs), `definitionToManifest`
      ([ADR-013](docs/adr/ADR-013-connector-architecture.md)).
- [x] `@worldview/connector-runtime`: `rest-json` (GET/POST, credentials by reference,
      four pagination strategies, viewport placeholders, JSON/CSV/text), `geojson`, `csv`,
      `websocket-json` (subscribe with `{secret}`, heartbeat, filter, batching, reconnect);
      the registry with a slot per phase; the loader for bundled and operator definitions.
- [x] Runtime and registry wiring: `resources/data/connectors/enabled` (shipped) and
      `<userData>/connectors` (the operator's) load beside the bespoke providers; the
      licence audit covers shipped definitions; `stage:resources` stages them.
- [x] The shared connector suite (14 checks) and `pnpm connector:test` (one definition or
      `--all`, `--live` for a real sample) with `*.test.json` sidecars;
      `pnpm connector:add --url` drafts a definition.
- [x] Docs: connectors guides, architecture, economics, TerriaJS and Open MCT harvest
      notes; the parallel-phase framework and `pnpm phase-check`.

Built as parallel phases (each a brief in `docs/roadmap/phases/`), merged in the order
INTEGRATION.md gives, then a refactor pass and `0.2.0-rc.1`:

- [x] `provider-migration` — every bespoke provider classified KEEP / MIGRATE / HYBRID;
      USGS re-expressed as a definition awaiting review, with parity tests (merged
      `9524304`; A1, A2, A7, A8 landed with it).
- [x] `arcgis` — FeatureServer/MapServer query, esriJSON, `exceededTransferLimit` paging
      (merged `50c7f2f`; live-checked against NIFC and NWS by the operator).
- [x] `ogc` — WFS, OGC API – Features, WMS, WMTS on the ADR-008 overlay contract (merged
      `e6e64d7`; its four findings on the contract fixed at integration).
- [x] `stac` — item search and static catalogues on the `imagery-scene` object type (merged
      `428c14a`; footprints drawn, the cache bounded and the poll budget landed with it).
- [x] `files` — local GeoJSON/CSV/GPX/KML/TopoJSON under a granted folder; GDAL import
      through an installed `ogr2ogr`, never bundled. Merged `a5244b5` with its four amendments landed (the `file` block, the granted folder by real path, `ogr2ogr` through the host, the suite's file mode).
- [x] `mqtt` — a broker on the LAN, rtl_433/OwnTracks/Meshtastic presets. Merged with its
      two amendments landed (the definition keeps its `mqtt` block; the shared suite's MQTT mode).
- [x] `home-assistant` — states and `state_changed` over the WebSocket API, read-only. Merged; `ws://` to a local instance still requested.
- [x] `traccar` — devices and positions, REST, and the live socket with the token in the URL. Merged.
- [x] `ingest` — a loopback HTTP listener with an envelope, for Node-RED and any pusher.
      Merged with A1 (the suite's listener mode) and A3 (health after refusals); A2 (generate the token in the app) landed after.
- [x] `telemetry` — series descriptors and a Readings panel (Open MCT harvest). Merged with R1 and R5; R2–R4 landed after.
- [x] `source-health-ui` — the connector shown in Sources and Source Health; the
      operator's folder managed in-app; an Add-source dialog. Merged with its runtime requests 2–3.
- [x] `offline-basemaps` — Planetiler/Protomaps extracts by tool, a Martin tile source (read side). Merged; B2 (a pack's basemap reaching the 2D map), B3 (pack credit line) and B5 landed; B1 (licence record, operator decision) and B4 (Martin in the app) open.

Found during the connector work and deferred to the refactor pass or a later minor (all
listed with detail in
[docs/architecture/CONNECTOR-ARCHITECTURE.md](docs/architecture/CONNECTOR-ARCHITECTURE.md)):
`mapping.explode` / `concat` / `when` as named no-execution steps if a real source needs
them; `Link`-header and time-window pagination; per-host rate budgets shared across
definitions; point-and-radius and tile bounds queries; WebSocket binary frames, compression
and header auth; per-object-type freshness defaults documented (done: docs/connectors/OVERVIEW.md); signing for bundled
definition sets; offline packs from reviewed definitions; the provider validator and the
connector suite reconciled as one evidence format for the release gate; a `discovery`
phase (CKAN/Socrata/OpenDataSoft/ArcGIS Online/Terria catalogue import into definitions).
From `provider-migration` (its matrix, A3–A6): the `split`, `padStart`, `slice`, `between`
and `urlOnHost` transforms and an exact `headingDegrees`; a `values` lookup, `concat`, a
transform on a condition, `altitudeDatum`, flags from conditions, a `centroid` position,
`effectiveFrom`/`effectiveUntil` and a root path in mappings; an AUTH condition, a
data-silence timeout and viewport bounds on WebSocket sources; CSV `requiredColumns`;
settings substituted into URL, query and headers — each one is what would let NHC, NWS,
FIRMS, AIS or the seed airports become a definition, and what would let the USGS definition
replace its provider. From `stac` (request 3): per-URL fixtures in the connector suite and
the sidecar (`{ urlEndsWith, body }` routes), so a source that reads several documents — a
static catalogue, OGC and ArcGIS paging — can be proved from a sidecar rather than only in
its own test file.

### 0.2.0 ships only when the picture is complete

0.2.0 is not cut on a date. It ships when an operator on an ordinary laptop can open
WorldView and see the whole live world with everything worth knowing about each thing in
it — until then the work goes out as 0.1.x patch releases. The bar:

- [ ] **Aircraft, everywhere:** every aircraft the open feeds carry, military included,
      with its type and class silhouette, and for a flight its **origin, destination,
      airline and route** where public route data has it; its track so far.
- [ ] **Satellites:** the full catalogue by category, with the selected one's orbit, pass
      over the view and what it is (operator, purpose, launch) where CelesTrak/SATCAT say.
- [ ] **Ships:** AIS where a key or local receiver provides it, with destination and ETA
      as broadcast.
- [ ] **Cameras, worldwide:** public traffic and weather cameras across the regions whose
      operators publish open feeds, with each feed's terms shown.
- [ ] **Weather and hazards:** radar, satellite imagery, alerts, storm cones, fires,
      earthquakes, global disaster alerts — live, coloured by severity.
- [ ] **Look and feel:** styles, HUD, day/night, follow, orbit, clean view — smooth on
      integrated graphics (Radeon 740M class) at 1920×1200.
- [ ] The refactor pass (docs/roadmap/INTEGRATION.md), the QA checklist walked on the
      installed build, and nothing in KNOWN-LIMITATIONS that an operator would call broken.

The boxes above are ticked from the QA walk on the installed build, not from the code.

### Outstanding for 0.2.0 (as of 2026-10-03, after 0.1.15, the last release before it)

Decisions only the operator can make:

- [ ] `offline-basemaps` B1: the licence record for a pack's basemap.
- [ ] `home-assistant`: whether `person` and `device_tracker` entities stay refused (§73).
- [ ] The user-data folder: `%APPDATA%\@worldview\desktop\` as built, or
      `%APPDATA%\WorldView\` as the docs say.
- [ ] Legal sign-off on the conditional and manual-review providers (LR-01…LR-19) and
      AISStream's commercial terms; until then they stay off by default.

Engineering:

- [x] 3D models close in: drawn on feature/next (14–17 at Frankfurt, `d44df97`, read from
      the perf log's new `models` field); their on-screen credit was missing and is fixed
      (`469e14a`).
- [x] `offline-basemaps` B4: a Martin source as a 2D basemap (Settings → Rendering). A LAN
      server over plain http stays undrawn unless the operator decides to widen the CSP.
- [x] `home-assistant` request 2 (`connector:test --live --setting key=value`).
- [ ] `home-assistant` request 1 (`ws://` to loopback or the trusted host for local
      sources): a decision for the operator — it relaxes the wss-only rule for sockets.
- [x] The refactor pass (docs/roadmap/INTEGRATION.md): items 1–4 on `feature/refactor`; the
      Windows gate on every build; `connector:test --live` for all 25 bundled definitions
      on 2026-10-04, all LIVE.
- [x] The deferred connector items: none is needed by a shipped source, so all stay for a
      later minor (the list above).
- [ ] Worth a profile, not blocking: on the test laptop the 2D map with the world loaded
      (20–30k features) runs 20–45 fps and sits at the governor's minimal detail most of the
      time (3D runs 50–60); and the renderer's JS heap reads 1–2 GB for a single sample
      right after a start or a 2D↔3D switch before settling at 300–400 MB (QA run
      2026-10-03, the soak). What the perf log shows (47 minutes of 2D at detail 2,
      2026-10-03): the shell's presentation pass is not the cost (median 13 ms, about 15
      passes a minute, the same code as 3D); fps median 41 with frame spikes of 100–470 ms
      and long tasks up to 600 ms. The governor is behaving as designed — climbing needs
      6–30 consecutive seconds at 50 fps, and a second in the 25–49 band resets the run.
      The cost is MapLibre's (worker re-tiling, symbol placement, the motion layer's full
      `setData` of up to 1,500 markers per step), which the log does not time: a DevTools
      performance recording on the laptop is the next step.

QA on the installed build (docs/releases/QA-CHECKLIST-0.2.0.md). The walk of 2026-10-03
(docs/releases/QA-RUN-2026-10-03.md) covered most of it on the laptop and fixed thirteen
defects on the way; what is left:

- [ ] By the operator, which a remote session cannot do: the installer run (SmartScreen,
      Start menu, portable zip) on a machine that has never run WorldView; the offline
      section with the network off; a desktop notification seen from a watch zone; Escape;
      a screenshot of each style as evidence files; a ship's bow against its heading; Task
      Manager GPU and CPU after switching 2D/3D; ISS passes against Heavens-Above; a few
      NWS alerts and the radar against weather.gov.
- [ ] Not yet walked: a flight across 180° (the orbit case passed; no aircraft are in
      adsb.lol's reach near the date line); storm reports against SPC, the SPC outlook and
      tornado tiers (on a day with US weather); the class silhouettes by eye; FIRMS with a
      key; RTSP/go2rtc; the map tile cache offline; lowering the history cap (it deletes
      history: the operator's); the one-hour stability soak on the final build (it passed
      on `65dec59`: +1 % from thirty minutes to sixty). (Passed on 2026-10-03/04: military
      worldwide, the global zoom-out, adding cameras and a camera with a password, the
      infrared seams and a Meteosat frame change in 2D and on the globe, IMERG, NWS alerts,
      NIFC perimeters, the camera previews, the tile cache trim and preload switch, Tab
      order and focus ring with the comparison divider, text scale, reduced motion, the
      soak, satellite history growth, the imagery comparison, the true-colour day and its
      Frame time — six of these after fixes now in CHANGELOG `[Unreleased]`.)
- [ ] The QA run on the build that will be tagged 0.2.0, with the checklist ticked.

## 0.3.0 — Offline everywhere

Bundled basemap extracts for common regions (from the `offline-basemaps` tooling); pack
signing (and signed definition sets); incremental pack updates; offline terrain where a
compatible source is legally clear; SQLite FTS place index at country scale; pack
management UI (size, coverage, freshness, update).

## 0.4.0 — Historical world

Longer retention with tiered downsampling in DuckDB/Parquet as the default backend;
replay of multi-day windows; per-object history views (track playback, altitude and
speed profiles, telemetry readings over long windows); "what changed" as a first-class
screen; export of historical queries where the source policy permits.

## 0.5.0 — Event intelligence

Richer deterministic correlation (aftershock sequences, fire growth, storm tracks,
alert supersession); event timelines and relationships; watch-zone rules with quiet
hours, escalation and telemetry limits; a world feed that ranks by relevance rather than
recency.

## 0.6.0 — Local sensor ecosystem

Beyond what 0.2.0's connectors cover: Meshtastic/LoRa over serial and BLE, NMEA 2000,
LAN device discovery that stays conservative and explicit, a local-sensor SDK with the
same manifest/data-policy contract for devices that need code.

## 0.7.0 — Provider extensions

Third-party providers and connector packs as installable packages — only once signing, a
permission model, process isolation and a review process exist (directive §128). A
provider registry and the scaffold CLI as the supported path.

## 1.0.0 — Stable baseline

Code signing and low-friction updates; macOS and Linux; ARM64; accessibility audit;
performance budgets enforced in CI; documented data-retention defaults reviewed by
legal; the commercial distribution review closed with no outstanding blockers.

## 1.10.0 — Deferred options from the OSIRIS review (each needs a decision first)

OSIRIS (osirisai.live) ships these; the operator asked for them to be recorded as possible
later additions rather than built now. None is scheduled. Each conflicts with a rule this
project already holds, so each needs an explicit, written decision — a change to
[docs/PRODUCT-BOUNDARIES.md](docs/PRODUCT-BOUNDARIES.md) or a licence obtained — and a
legal review before any work starts. Until then the boundary below stands.

- **Reconnaissance toolkit** — username, email and phone lookups, breach and infostealer
  data, port scans and range sweeps. Blocker: named-person search and scanning systems one
  does not own (§73; unauthorised scanning is unlawful in many jurisdictions).
- **Bluetooth device tracking.** Blocker: private-device tracking (§73).
- **Rotating spoofed IP addresses and browser fingerprints to get past rate limits.**
  Blocker: it evades the terms every source is used under (§6–8) and would put the
  operator in breach of them; the supported path is keys and rate budgets.
- **Private-jet owner tagging.** Blocker: ties an aircraft to a named owner (§73).
- **Submarine cable map (TeleGeography data).** Blocker: licensed CC BY-NC-SA, not for
  commercial use. A clean alternative exists (OpenStreetMap `submarine=yes`, ODbL) and can
  be planned independently of this list.

## Deliberately not planned

Named-person search, facial recognition, deanonymisation, private-device tracking,
plate-history databases, camera-frame analysis. See
[docs/PRODUCT-BOUNDARIES.md](docs/PRODUCT-BOUNDARIES.md).
