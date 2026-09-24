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
- [ ] `arcgis` — FeatureServer/MapServer query, esriJSON, `exceededTransferLimit` paging.
- [ ] `ogc` — WFS, OGC API – Features, WMS, WMTS (raster overlays need the ADR-008
      overlay-layer amendment).
- [ ] `stac` — item search and static catalogues (an `imagery-scene` object type).
- [ ] `files` — local GeoJSON/CSV/GPX/KML/TopoJSON under a granted folder; GDAL import
      through an installed `ogr2ogr`, never bundled.
- [ ] `mqtt` — a broker on the LAN, rtl_433/OwnTracks/Meshtastic presets (needs the
      ADR-003 MQTT transport amendment).
- [ ] `home-assistant` — states and `state_changed` over the WebSocket API, read-only.
- [ ] `traccar` — devices and positions, REST first, socket when the query-credential
      amendment lands.
- [ ] `ingest` — a loopback HTTP listener with an envelope, for Node-RED and any pusher
      (needs the ADR-003 listener amendment).
- [ ] `telemetry` — series descriptors and a Readings panel (Open MCT harvest).
- [ ] `source-health-ui` — the connector shown in Sources and Source Health; the
      operator's folder managed in-app; an Add-source dialog.
- [ ] `offline-basemaps` — Planetiler/Protomaps extracts by tool, a Martin tile source.

Found during the connector work and deferred to the refactor pass or a later minor (all
listed with detail in
[docs/architecture/CONNECTOR-ARCHITECTURE.md](docs/architecture/CONNECTOR-ARCHITECTURE.md)):
`mapping.explode` / `concat` / `when` as named no-execution steps if a real source needs
them; `Link`-header and time-window pagination; per-host rate budgets shared across
definitions; point-and-radius and tile bounds queries; WebSocket binary frames, compression
and header auth; per-object-type freshness defaults documented; signing for bundled
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
replace its provider.

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

## Deliberately not planned

Named-person search, facial recognition, deanonymisation, private-device tracking,
plate-history databases, camera-frame analysis. See
[docs/PRODUCT-BOUNDARIES.md](docs/PRODUCT-BOUNDARIES.md).
