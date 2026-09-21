# Upstream: God's Eye View (GEV)

WORLDVIEW's application foundation is derived from the open-source God's Eye View
project. Other upstreams (CesiumJS, MapLibre, PMTiles, DuckDB, deck.gl, readsb, go2rtc)
are ordinary dependencies or sidecars and are tracked in their package manifests, not
here.

| Field | Value |
| --- | --- |
| Repository | https://github.com/bilawalsidhu/gods-eye-view |
| Base commit | `0dbde1e36c0177b7664b47702d77ba50f11ddadc` (branch `main`) |
| Base commit date | 2026-09-20 20:01:25 -0700 ("Merge pull request #284 from jrmagnus/fix/trackpad-pinch-zoom") |
| Upstream version | `gods-eye-view` 0.1.1 (package.json) |
| Import date | 2026-09-21 |
| Audit documents | [docs/architecture/GEV-MIGRATION-MATRIX.md](docs/architecture/GEV-MIGRATION-MATRIX.md), [docs/architecture/GEV-AUDIT-NOTES.md](docs/architecture/GEV-AUDIT-NOTES.md) |

## Licence notice

GEV **source code** is MIT-licensed (Copyright (c) 2026 Bilawal Sidhu). The MIT grant
covers code only. Retain the upstream copyright and permission notice in every file or
package that carries adapted GEV code (a `THIRD_PARTY_NOTICES` entry is sufficient for
compiled bundles).

The MIT grant does **not** extend to third-party data or assets that GEV bundles or
fetches. Per GEV's own `LICENSE` and `DATA_SOURCES.md`:

- Not imported into the commercial baseline: TeleGeography submarine cables
  (CC BY-NC-SA 3.0), Bhote Koshi 2026 event pack and `bhoteKoshiFloodPath.js`
  (CC BY-NC 4.0), Google-derived `cctv_ground_heights.json`, `docs/media/*`.
- Imported with their own licences and attribution: `public/models/*.glb` (CC BY 4.0,
  see the upstream `public/models/README.md`), OSM-derived datacenters/dams (ODbL 1.0),
  Natural Earth (public domain), DataSF neighborhoods (PDDL 1.0), FIRMS test fixtures
  (CC0).
- Live sources keep their own terms; OpenSky (non-commercial), Google Maps Platform,
  Google News RSS and adsbdb route data are excluded or disabled in the baseline.
- Code in `aircraftClass.js`, `aircraftIcons.js`, `aircraftMeta.js`, `issPass.js`,
  `motionModel.js`, `routePlausible.js`, `layers/{flights,military}/motion.js`,
  `server/providers/aircraft/enrichment.js`, `server/providers/space/celestrak.js`
  is itself adapted by GEV from skylight (MIT, https://github.com/cpaczek/skylight);
  keep both attributions.

## Migrated directories (to be completed by integration)

Pre-filled from the migration matrix; update as packages land.

| GEV path | WORLDVIEW destination | Status |
| --- | --- | --- |
| `src/app/application.js`, `stateChannel.js` | `packages/runtime` | pending |
| `src/app/viewer.js`, `src/maps/*` (except `google3d.js`) | `packages/render-cesium` | pending |
| `src/maps/google3d.js` | `packages/render-cesium/adapters/google-3d` (optional) | pending |
| `src/sources/live/*`, `src/sources/httpBody.js`, `rateLimit.js` | `packages/provider-sdk`, `packages/provider-runtime` | pending |
| `src/layers/earthquakes/{source,records}.js` | `providers/usgs` | pending |
| `src/layers/satellites/{source,orbits(parseTLE/propagate)}.js`, `server/providers/space/*` | `providers/celestrak` | pending |
| `src/data/firmsCsv.js`, `firmsAdapt.js`, `server/providers/firms.js` | `providers/firms` | pending |
| `src/sources/live/aircraft.js`, `server/providers/aircraft/adsb-lol.js` | `providers/adsb-remote` | pending |
| `server/providers/aircraft/opensky.js` | `providers/opensky` (disabled by default) | pending |
| `src/sources/live/vessels.js`, `server/providers/vessels/*`, `src/data/aisStreamAdapter.js`, `aisWatchdog.js` | `providers/ais` | pending |
| `server/providers/cctv/*`, `src/layers/cctv/source.js`, `config/cctv_sources.*.json` | `providers/cctv-public` | pending |
| `src/data/gtfsRealtime.js`, `transitFeeds.js`, `transitProxy.js`, `src/sources/transitService.js`, `server/providers/gbfs.js` | `providers/transit` | pending |
| `src/layers/traffic/source.js`, `flowDecode.js`, `src/sources/overpassRoads.js`, `src/data/tomtomTiles.js`, `flowMatch.js`, `server/providers/traffic.js` | `providers/traffic` | pending |
| `server/providers/regional/weather*.js`, `src/data/regionalModel.js` | `providers/weather` | pending |
| `server/providers/overpass/*`, `military-installations/*`, `terrain.js`, `src/sources/overpassFeatures.js`, `nominatim.js`, `src/data/infrastructure.js`, `local_data/{datacenters,dams}` | `providers/infrastructure` | pending |
| `src/layers/flights/records.js`, `src/layers/military/records.js`, `src/layers/vessels/records.js`, `src/layers/aircraft/classification.js`, `src/data/aircraftClass.js` | `packages/identity` | pending |
| `src/data/geoid.js`, `renderAltitude.js` | `packages/world-model` | pending |
| `src/data/lifecycle.js` (visibility/intent model), `layerState.js`, `contextStore.js` | `packages/state-engine` | pending |
| `src/data/analystEngine.js`, `naturalEarthRegions.js`, `neighborhoodPolygons.js`, `src/search/*`, `src/keylessGeocoder.js` | `packages/query-engine` | pending |
| `src/overlays/*`, `src/data/labelArbiter.js`, `detectionCohort.js`, `localGeojsonLod.js` | `packages/render-core` / `packages/render-dense` | pending |
| `src/locations.js` (framing), `src/cameraVerbs.js`, `src/data/trackedCamera.js` | `packages/camera-gateway` | pending |
| `src/data/dataCredits.js` (data → manifests) | `packages/provider-sdk` manifests + `packages/render-core` attribution | pending |
| `scripts/check-import-directions.mjs` rules | `tools/boundary-check` | pending |
| `public/models/*.glb` + README | `packages/render-cesium/assets/models` | pending |

## Heavily modified directories (to be completed by integration)

Expected to diverge substantially from upstream (list files here once modified so
upstream diffs are not applied blindly):

- `src/layers/flights/*` + `src/layers/military/*` → merged into one aircraft pipeline
  (identity + render-cesium); rendering/tracking/motion rewritten against the world model.
- `src/data/lifecycle.js` → refresh loop moved to provider-runtime; only the
  visibility-intent model survives.
- `src/app/scene.js`, `src/mapStackController.js`, `src/maps/defaultSources.js` → keyless
  globe is the default; Google 3D is an adapter.
- `server/providers/*` → Vite middleware converted to main-process provider services over
  the ipc-contract; `.gev-cache/` replaced by the offline store.
- `src/ui/*`, `src/*.js` HUD/panel modules → replaced by the React shell (spec only).
- `src/data/contextStore.js`, `pickRegistry.js`, all `gev:*` window events → explicit
  event bus / state slices.

## Retained upstream tests

Kept verbatim (path-adjusted) as regression protection for ported logic; see
GEV-AUDIT-NOTES.md §(d) for the full list. Highlights:

- `src/data/firmsCsv.test.mjs` (+ fixtures), `firmsAdapt.test.mjs`
- `src/data/gtfsRealtime.test.mjs`, `transitFeeds.test.mjs`, `transitProxy.test.mjs`
- `src/sources/live/contract.test.mjs`, `src/data/adsbLolFallback.test.mjs`
- `src/layers/{flights,military,vessels}/records.test.mjs`, `src/layers/aircraft/classification.test.mjs`
- `src/data/{aircraftClass,aircraftMeta,renderAltitude,geoid,motionModel,routePlausible}.test.mjs`
- `src/data/{aisWatchdog,aisWatchdogTransport,aisStreamAdapter,aisStreamSentinels}.test.mjs`
- `src/search/*.test.mjs`, `src/keylessGeocoder.test.mjs`, `src/nominatimGeocode.test.mjs`
- `src/sources/protocols.test.mjs`, `overpassFeatures.test.mjs`
- `src/data/{tomtomTiles,flowMatch,flowTiles}.test.mjs`
- `src/maps/controller.test.mjs`, `sourceFactories.test.mjs`
- `src/app/application.test.mjs`, `stateChannel.test.mjs`
- `src/data/{analystEngine,naturalEarthRegions,neighborhoodPolygons,localGeojsonLod,layerState}.test.mjs`

Not retained: the GC-bracketed allocation probes (Node-24-calibrated), source-text
regression tests (`readLayerSource`/`readShellSource`), voice/director/scenes/cockpit
tests, Pinokio/key-setup tests, puppeteer `scripts/qa-*.mjs` harnesses.

## Upstream port strategy

1. **No blind merges.** After the initial import the trees diverge structurally
   (TypeScript, package split, Electron main/renderer). Never `git merge` or rebase
   onto upstream `main`.
2. **Cherry-pick intentionally.** Watch upstream for fixes in the *retained* areas
   (provider parsers/normalisers, records/eviction policy, map source controller,
   GTFS/FIRMS/TLE decoding, AIS watchdog, search chain). For each candidate upstream
   commit: read the diff, locate the WORLDVIEW counterpart via the tables above, port
   by hand, and reference the upstream commit hash in the WORLDVIEW commit message
   (`Upstream: gods-eye-view@<sha>`).
3. **Track the watermark.** Record the last reviewed upstream commit here:

   | Last reviewed upstream commit | Date | Reviewer |
   | --- | --- | --- |
   | `0dbde1e36c0177b7664b47702d77ba50f11ddadc` | 2026-09-21 | initial import |

4. **Licence re-check on every port.** Any upstream change to `DATA_SOURCES.md`,
   `LICENSE`, `public/models/README.md`, `src/data/local_data/*/README.md` or a new
   bundled dataset must be reviewed for commercial compatibility before code from the
   same commit is ported.
5. **Do not re-import removed areas** (voice, director, scenes, cockpit, ALPR, Google
   News, TeleGeography, Bhote Koshi, Pinokio, Google-only tools) unless a product decision
   reverses the matrix entry.
