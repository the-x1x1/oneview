# WORLDVIEW

A local-first browser for the physical world.

WORLDVIEW puts aircraft, vessels, satellites, earthquakes, fires, weather alerts,
cameras and infrastructure into one coherent model — live, historical and offline — and
lets you inspect it on a 3D globe or a 2D map. It runs on your machine. There is no
account, no cloud backend, and nothing is uploaded.

> Release 0.1.0-rc.5 — release candidate. Builds are unsigned; see
> [known limitations](docs/releases/KNOWN-LIMITATIONS.md).

## What it does

- **One world model, many sources.** Every provider normalizes into the same
  `Observation` → `WorldObject` → `WorldEvent` model, so a new data source never means a
  new UI, a new database or another settings system.
- **Honest data.** Everything carries provenance, an observation time and a freshness
  class (LIVE / RECENT / STALE / HISTORICAL). Cached data says "cached". Live mode never
  substitutes mock data — if a source is down, it says so.
- **Source health you can act on.** Every source shows its state, last error, refresh
  interval, cache behaviour, credentials and licence in one panel.
- **Time as a first-class axis.** Pause, scrub, replay at 0.25×–60×, jump back to live.
  The timeline shows where history actually exists instead of pretending.
- **Offline for real.** Install a `.worldpack` (data only, never code), pull the network,
  and keep a 2D map, local place search, collections, history and any local receivers.
  This is verified by a test suite that runs with networking disabled.
- **A privacy boundary, on purpose.** No named-person search, no facial recognition, no
  plate databases, no private-device tracking — see
  [PRODUCT-BOUNDARIES.md](docs/PRODUCT-BOUNDARIES.md).

## Install

Download `WorldView-Setup-0.1.0-rc.5.exe` (per-user install, no admin) or
`WorldView-Portable-0.1.0-rc.5.zip` from the releases page, verify it against
`SHA256SUMS.txt`, and run it. Windows 10/11 x64. The app opens straight to Earth: no
credentials are needed for the default globe, earthquakes, satellites or weather alerts.

```powershell
Get-FileHash .\WorldView-Setup-0.1.0-rc.5.exe -Algorithm SHA256
```

Because the build is not yet code-signed, SmartScreen will warn on first run.

## Screenshots

Captured during release-candidate verification and attached to the GitHub release —
this repository deliberately ships no mock-ups that could be mistaken for the product.

## The provider model

A data source is a directory:

```
providers/<name>/
  src/manifest.ts     id, object types, transport, capabilities, credentials,
                      refresh policy, data policy, attribution, allowed hosts
  src/normalize.ts    payload → Observation[]
  src/index.ts        the provider
  test/contract/      fixture-driven contract plan
fixtures/<name>/      normal / empty / stale / malformed payloads
```

A provider never renders, never touches the UI, and never opens a socket itself: it
receives a capability context (HTTP with an allowlist, cache, credentials-by-key,
settings, local file access) and returns normalized observations. Adding one takes a
manifest, a normalizer, fixtures and a passing checklist — no renderer changes.

```
pnpm provider:test usgs
```

```
Manifest         PASS  id=usgs-earthquakes v0.1.0 transport=http review=approved
Data Policy      PASS  cache=true raw=true norm=true … (matches legal registry)
Normalization    PASS  all 8 observations valid; types=earthquake
World Mapping    PASS  8 objects (8 authoritative ids); deterministic across order
Offline          PASS  offline → DEGRADED; reconnect → LIVE
16 pass, 0 fail, 0 skip → PASS
```

Ten providers ship today: USGS earthquakes, CelesTrak satellites, NASA FIRMS fires,
NWS weather alerts, adsb.lol aircraft, local readsb, AISStream vessels, public CCTV
catalogs, local cameras, and a bundled airport dataset.
See [docs/providers/BUILDING-A-PROVIDER.md](docs/providers/BUILDING-A-PROVIDER.md).

## Connectors: sources as data

Most open-data feeds differ only in a URL, a record path and field names, so they are not
code at all: a **connector definition** is one JSON file that a shared connector runs
([ADR-013](docs/adr/ADR-013-connector-architecture.md)).

```json
{
  "schema": "oneview.connector.v1",
  "id": "usgs-earthquakes-connector",
  "connector": "geojson",
  "objectType": "earthquake",
  "endpoint": {
    "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    "intervalSeconds": 300
  },
  "mapping": {
    "externalId": "id",
    "observedAt": { "path": "properties.time", "transform": "unixMillis" },
    "position": { "geometry": "geometry", "altitude": false },
    "properties": { "magnitude": { "path": "properties.mag", "transform": "number" } }
  },
  "attribution": { "text": "U.S. Geological Survey Earthquake Hazards Program (public domain)" }
}
```

Nothing in a definition is executed — paths, a fixed set of transforms and filter
conditions — and its data policy fails closed until a human reviews the source's terms.
`rest-json`, `geojson`, `csv` and `websocket-json` ship; the OGC family, ArcGIS, STAC,
local files, MQTT, Home Assistant, Traccar and an HTTP ingest are the parallel phases in
[docs/roadmap/PARALLEL-PHASES.md](docs/roadmap/PARALLEL-PHASES.md).

```
pnpm connector:add --url https://data.example.org/things.geojson    # draft a definition
pnpm connector:test connectors/examples/usgs-earthquakes-geojson.json # the shared suite
```

Your own definitions go in `%APPDATA%\WorldView\connectors\`. See
[docs/connectors/OVERVIEW.md](docs/connectors/OVERVIEW.md).

## Offline

```
pnpm worldpack build --region hawaii --include map,places,airports,earthquakes
```

A `.worldpack` is a signed-in-spirit data container: manifest, PMTiles basemap, GeoJSON
and Parquet/NDJSON datasets, a local search index and the licence notices, with SHA-256
for every file. Import validates it against path traversal, symlinks, executables,
decompression bombs and tampering before writing anything, and a pack may only contain
sources whose data policy permits offline redistribution.
See [docs/OFFLINE-PACKS.md](docs/OFFLINE-PACKS.md).

## Development

```bash
corepack enable && corepack prepare pnpm@10.28.0 --activate
pnpm install
pnpm dev                     # Electron + Vite
pnpm typecheck && pnpm test && pnpm boundary-check
```

pnpm workspace monorepo: `packages/*` are code boundaries (never services),
`providers/*` are data sources, `apps/desktop` is the Electron shell, `tools/*` are the
CLIs (`provider:test`, `connector:test`, `connector:add`, `worldpack`, `benchmark`,
`license-audit`, `sbom`, `release:verify`, `doctor`, `phase-check`). Dependency direction is enforced by
`pnpm boundary-check`: providers never render, renderers never fetch, the UI only
consumes the typed IPC client.

More: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) ·
[architecture](docs/architecture/) · [ADRs](docs/adr/)

## Privacy

Local-first and account-free. Collections, watch zones, settings, history and installed
packs stay on your machine and are never uploaded. There is no third-party analytics and
no telemetry in this release. Credentials live in OS-protected storage (DPAPI on
Windows) and are never readable by the interface layer; logs and diagnostics bundles are
redacted centrally.

## Legal

The application code is MIT. **Data and assets are licensed separately from the code** —
every source declares its own policy (caching, retention, redistribution, offline packs,
export, commercial use, attribution) in `config/licenses/providers.json`, and the
application obeys it: data that may not be retained is not archived, data that may not
be redistributed cannot enter a worldpack, and sources whose commercial terms are
unclear are off by default.

- [Software licences](docs/legal/SOFTWARE-LICENSES.md)
- [Data source licences](docs/legal/DATA-SOURCE-LICENSES.md)
- [Asset provenance](docs/legal/ASSET-PROVENANCE.md)
- [Commercial distribution review](docs/legal/COMMERCIAL-DISTRIBUTION-REVIEW.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

WORLDVIEW is built on [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)
(MIT) — see [UPSTREAM.md](UPSTREAM.md) for what was adapted and what was deliberately
left behind.

## Security

Report vulnerabilities privately: [SECURITY.md](SECURITY.md). The full analysis lives in
[docs/security/THREAT-MODEL.md](docs/security/THREAT-MODEL.md).
