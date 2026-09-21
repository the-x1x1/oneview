# GEV Audit Notes — code-level reuse guide

Companion to [GEV-MIGRATION-MATRIX.md](./GEV-MIGRATION-MATRIX.md). Written so an
engineer can lift GEV code into WORLDVIEW packages without re-reading the GEV tree.
All paths are relative to the GEV clone root (base commit `0dbde1e3`, see
[/UPSTREAM.md](../../UPSTREAM.md)). Line counts and shapes were read from source on
2026-09-21; anything marked *verify* was not confirmed beyond what GEV documents.

Conventions in GEV code: ES modules, 2-space, single quotes, JSDoc on exports, no
TypeScript, no framework. Coordinates are WGS84 degrees, lengths metres, speeds m/s,
times Unix ms unless a field name says otherwise (`speedKts`, `altitudeFt`).

---

## (a) Architecture as found

### a.1 Composition root

`src/main.js` → `src/standalone/application.js` (`createStandaloneApplication`) →
`src/app/application.js` (`createApplication`).

`createApplication({createScene, createControls, createData, createTools})` runs the
four constructors in order, passing `{...earlierComponents, signal, defer}`; teardown
runs tools→controls→data→scene. It is pure and reusable (`src/app/application.js`,
150 lines, tests in `src/app/application.test.mjs`). `getState()` returns
`{status: 'created'|'starting'|'ready'|'destroying'|'destroyed'|'failed', phase}`.

Standalone phase owners:

| Phase | GEV module | What it builds |
| --- | --- | --- |
| scene | `src/app/scene.js` (`createApplicationScene`) | Cesium viewer, credits, Google tileset attempt, `MapStackController`, surface/annotation operations (`src/app/operations.js`) |
| controls | `src/standalone/controls.js` → `src/ui/*` | Style manager, camera presentation, share restoration |
| data | `src/app/data.js` + `src/app/constructCatalog.js` | `LayerLifecycle` + layer catalog, registration, restoration |
| tools | `src/app/tools.js` | Scenes, annotations, voice, page listeners |

### a.2 How a layer is wired (`source.js → records.js → model.js → index.js`)

Every layer family lives in `src/layers/<family>/` and is composed by a factory in
`index.js` that takes `{ source, services, ...config }` and returns a **layer module
object** implementing the lifecycle interface consumed by `LayerLifecycle`:

```
{
  id, name, icon, source,               // presentation metadata
  updateInterval,                        // ms; 0 = no periodic update() (viewport-driven)
  refreshInterval?,                      // optional override for update() cadence
  init(viewer), enable(viewer), disable(viewer), update(viewer, {signal}), destroy(viewer),
  getStats() -> { count, lastUpdate, error, ... },
  setParams?(params, {origin}), getParams?(),
  getAnalystRecords?(max), getDetectableObjects?(), cancelPendingRestore?()
}
```

Per-file roles (the earthquakes layer is the minimal complete example, 404 lines
total; flights is the maximal one, 20 files):

| File | Responsibility | Portable? |
| --- | --- | --- |
| `source.js` | Transport only: `createXSource({fetchImpl})` returns an object with the methods listed in `SOURCE_METHODS` (`src/app/constructCatalog.js`), e.g. `getSnapshot({signal})`. Never renders, never starts a request on construction. | Yes (checked by the import-direction gate) |
| `records.js` | Pure normalisation and identity/retention: e.g. `normalizeEarthquakeSnapshot(geojson)`, `class FlightRecords { receive(observation, ctx) / absence(id, ctx) / forget(id) }`, `class VesselRecords { reconcile(rows, opts, effects) }` | Yes |
| `ingestion.js` | Owns the request lifetime, backoff, freshness (`feed._retryAt`, `feed._lastError`, `feed._lastTrackingRefreshOutcome`) and calls `applySnapshot` | Yes for flights/military/vessels; other families' `ingestion.js` may touch Cesium (documented in `docs/CODE-BOUNDARIES.md`) |
| `model.js` | Colours, overlay entry builders, analyst-record mappers; may import Cesium for `Color` | Partly |
| `state.js` | Mutable per-instance state bag (`createXState`) | – |
| `rendering.js` / `snapshotRenderer.js` | Cesium primitives/entities, per-frame ticks, LOD | No |
| `tracking.js`, `motion.js` | Click-to-track camera, dead reckoning | No |
| `lifecycle.js`, `controls.js`, `queries.js` | `init/enable/disable/destroy`, `setParams`, `getStats` methods that are `Object.assign`ed onto the layer object | No |
| `policy.js` / `recordPolicy.js` | Constants (poll limits, pixel sizes, thresholds) | Yes |
| `testing.js` | `layer.testing` seam for browser harnesses | Drop |

`src/app/layers/<name>.js` (19 small files) binds each family factory to the
application's scene services. Example (`src/app/layers/flights.js`) shows the
service surface a renderer-side aircraft layer expects:

```js
return createCivilFlightLayer({
  source, resolveAsset,
  services: { picking, sprites, trails, aircraftPresentation, camera, militaryRegistry,
    labels, groundFloor, meshFloor, geoid, focus, readout, context, render, groundSnap, recession },
});
```

`src/app/constructCatalog.js` validates that every supplied source has the required
methods (`SOURCE_METHODS`), constructs all layers, and wraps them in
`createLayerCatalog(layers, LAYER_STATE_REGISTRY)` (`src/app/catalog.js`), which
enforces unique ids and one metadata entry per layer. `catalogControlServices`
maps role names (`flightsLayer`, `cctvLayer`, …) to instances for the UI.

Source-method contract as of the base commit:

```
flights/military/vessels: getSnapshot         cctv: getCatalog,getHealth,getFrameUrl,getMediaUrl
radio: getDirectory,recordClick               traffic: requestRoads,getStatus,fetchFlowForBounds,getFlowSessionStats,resetFlowTileCache
bikeshare: getStations                        installations: getMappedSites,searchNearby
satellites: readGroup                         launches: getLaunches,getActiveTle
alpr: fetch   firms: getSnapshot   earthquakes: getSnapshot   cables: fetch   (transit: separate source object)
```

### a.3 Layer lifecycle (`src/data/lifecycle.js`)

`class LayerLifecycle(viewer, {allowQaRegistration})`, 2,314 lines. Key behaviours:

- `register(module)` before `finalizeRegistrations(serializationRegistry)`; after
  sealing only `registerForQa` works. Entry state per layer:
  `{module, enabled, initialized, intervalId, refreshing, refreshEpoch,
  managerRefreshError, lifecycleState: 'disabled'|'enabling'|'enabled'|'disabling',
  lifecycleUncertain, toggleChain, ...}`.
- `setEnabled(id, bool, {origin})` / `toggle(id, {origin})`: origin ∈
  `'user'|'voice'|'tool'|'programmatic'|'share-restore'|'local-restore'`. Explicit
  origins cancel pending tracking restores. Enable calls `module.init(viewer)` once
  then `module.enable(viewer)`, runs an immediate `update()`, then arms the loop.
- `_armUpdateLoop`: `refreshInterval > 0 ? refreshInterval : updateInterval > 0 ?
  updateInterval : 0` → `setInterval(update)`; if `updateInterval === 0` it instead
  publishes a status tick every `statsRefreshInterval || 1000` ms.
- `_runPeriodicUpdate` wraps `module.update(viewer, {signal})` and classifies the
  outcome (`accepted`, `cancelled`, `source-unavailable`) into `getAll()` stats with
  a normalised `{refreshing, error}` presentation.
- Params: `setLayerParams(id, params, {origin})` (validated by module, rejected via
  `LayerParamsRejectedError`) and `adoptLayerParams` (restore path). Params are
  serialised per `LAYER_STATE_REGISTRY` disposition
  (`enabled-only`, `enabled+options`, `enabled+mirrored-options`).
- Subscriptions: `subscribe(cb)` (state changes), `subscribeVisibilityRequests`,
  `addVisibilityGuard(cb)` (can veto), `subscribeBeforeDestroy`, `subscribeActivity`.
- `src/data/manager.js` (`DataLayerManager`) is the compatibility facade that also
  mounts the toggle panel via `src/app/layerPresentation.js`.

WORLDVIEW mapping: the "intent epoch / transaction" model for visibility belongs to
state-engine; the `setInterval` refresh loop belongs to provider-runtime (main
process), and `update()` becomes "apply latest snapshot from the world model".

### a.4 Server proxy providers (`server/providers/*`)

Each provider is a Vite plugin factory `xProxy()` returning
`{ name, configureServer(server), configurePreviewServer(server) }` that mounts
`server.middlewares.use('/api/<route>', async (req, res) => …)` (Connect-style
`http.IncomingMessage`/`ServerResponse`). They are composed in order by
`server/providers/local.js` → `localProviderPlugins()` and attached by
`server/standalone/vite.config.js`. State is module- or closure-scoped (process
lifetime); caches live in memory plus `.gev-cache/*.json` under `process.cwd()`.

Common pattern (FIRMS, CelesTrak, terrain, adsbdb): memory cache → disk cache
(`readDiskOnce`) → TTL check → single-flight refresh (`inflight` promise map) →
serve-stale on failure → sanitised error JSON. Responses set
`Cache-Control: no-store` and a provider-specific cache header
(`x-tle-cache`, `X-ADS-B-Cache`, `X-OpenSky-Cache`, `X-Overpass-Cache`,
`X-Weather-Effects`) with values `HIT|MISS|STALE|INFLIGHT|COOLDOWN`.

Helper API (`server/providers/common/`):

| Module | Export | Signature / behaviour |
| --- | --- | --- |
| `http.js` | `readResponseTextCapped(response, maxBytes, signal?)` (re-exported from `src/sources/httpBody.js`) | Streams a fetch `Response` body with a running byte cap; throws `{code:'RESPONSE_TOO_LARGE'}`; cancels the reader on abort |
| | `readResponseJsonCapped(response, maxBytes, signal?)` | `JSON.parse` of the above |
| | `readResponseBytesCapped(response, maxBytes)` | `Uint8Array` variant for protobuf |
| | `coalesceProxyRequest(inFlightMap, key, create)` | Returns `{promise, shared}`; deletes the map entry only when *that* promise settles |
| | `readCappedResponseText(upstream, maxBytes)` | Older non-throwing variant returning `{tooLarge, text}` |
| `request.js` | `readRequestBodyCapped(req, maxBytes)` → `Buffer` | Throws `{code:'BODY_TOO_LARGE'}` |
| | `readRequestBody(req, maxBytes=1 MiB)` → `string` | Drains after cap so the handler can still answer |
| `rate-limit.js` | `makeRateLimiter({windowMs, max, globalMax})` → `allow(key): boolean` (from `src/sources/rateLimit.js`) | Sliding window per key + global backstop; bounded to 2,000 keys |
| | `makeOptInRateLimiter(envValue)` → limiter or `null` | Unset/0 = unlimited; N = N/min/IP with `globalMax = 20N` |
| | `clientKey(req)` | `req.socket.remoteAddress` only (X-Forwarded-For deliberately ignored) |
| `query.js` | `requiredFiniteQueryNumber(params, key)` → number or null; `clampInt(value, min, max, fallback)` | |
| `geo.js` | `haversineKm(lat1, lon1, lat2, lon2)` | |
| `source-root.js` | `defaultSourceRoot` | Repo root resolved from `import.meta.url` |

Security posture (from `SECURITY.md`, verified in code): no arbitrary-URL fetching
(CCTV only fetches server-registered URLs; transit resolves ids against
`src/data/transitFeeds.js` and validates every redirect hop against the feed's
https origin), response-size caps, timeouts via `AbortSignal.timeout`, sanitised
errors, only `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` reach the browser via
Vite `define` (`build/vite.js`).

### a.5 Live sources and `contract.js`

`src/sources/live/contract.js` defines the browser-side live-source contract:

- `class LiveSourceError(code, message, {status, retryAfterMs=20000, source})`, codes
  `'malformed'|'unavailable'|'limited'|'denied'|'unsupported'`.
- Helpers `finite(v)`, `epoch(v, scale)` (rejects ≤0 and >8.64e15), `cleanText`,
  `coordinates(lat, lon)`.
- `admitRecords(rows, normalize, label)` → `{records, complete, rejectedCount}`; throws
  `malformed` when a non-empty feed yields zero valid rows (atomic admission).
- `readResponse(fetchImpl, url, init, source)` → `{response, payload}`; network
  failure → `LiveSourceError('unavailable')`; `httpError(response, source)` maps
  429→`limited` (retry 45 s), 401/403→`denied`, else `unavailable` (retry 20 s).

Sources expose `getSnapshot(query, {signal})` returning a **snapshot**:

```
{ records: Observation[], complete: boolean, rejectedCount, source: string, coverage: string,
  observedAtMs: number|null, ageMs, stale: boolean, freshness: 'current'|'stale'|'unknown', status }
```

and optionally `getTrack(reference, {signal})` → `{records: TrackPoint[], complete:false}`
and `getEnrichment({kind:'type'|'route', id}, {signal})`. Concrete sources
(`src/sources/live/standalone.js`): `createOpenSkySource`, `createAdsbLolSource`,
`createAisStreamSource({apiUrl})`. `docs/CODE-BOUNDARIES.md` states the rule:
"Records contain observation data only, with no scene objects or transport data".

**Aircraft observation shape** (`normalizeOpenSkyAircraft` / `normalizeReadsbAircraft`):

```
{ id (icao24 lowercase), reference, latitude, longitude, callsign, originCountry,
  positionTimeMs, contactTimeMs, baroAltitudeM, ellipsoidAltitudeM, onGround,
  speedMps, courseDeg, verticalRateMps, category (OpenSky int|readsb string|null),
  typeCode, registration, operator }
```

**Vessel observation shape** (`normalizeVesselObservation`):

```
{ id (mmsi), reference, latitude, longitude, name, imo, type, destination,
  speedMps, courseDeg, headingDeg, observedAtMs, altitudeDatum: 'sea-surface' }
```

**Track point**: `{latitude, longitude, observedAtMs, baroAltitudeM, ellipsoidAltitudeM, onGround}`
(aircraft) or `{latitude, longitude, observedAtMs, altitudeDatum}` (vessel).

This is the closest existing analogue to WORLDVIEW's normalized Observation; the
provider-sdk type should be a superset with `source`, `layerKind`, `datum` and an
explicit `observedAtMs` on every record.

### a.6 Attribution / credits (`src/data/dataCredits.js`)

- `DATA_CREDITS: {key, html}[]` — 36 static entries (OpenSky, adsb.lol, adsbdb,
  AISStream, CelesTrak, LL2, USGS, Overpass, Photon, ALPR/OSM, installations/OSM,
  Nominatim, Open-Meteo, Google News/GDELT, city camera packs, GBFS, Radio Browser,
  Re:Earth, OSRM, datacenters/dams, TeleGeography, Natural Earth, DataSF).
- `registerDataCredits(viewer, credits = DATA_CREDITS)` — calls
  `viewer.creditDisplay.addStaticCredit(new Cesium.Credit(html, /*showOnScreen*/ false))`
  once at scene init, so entries live in Cesium's expandable "Data attribution"
  popover, not the on-globe line.
- `registerDynamicCredit(viewer, {key, html})` — idempotent per key; used when a
  conditional source activates (TomTom, per-transit-feed via
  `transitFeedCredit(feed)`, Bhote Koshi).
- Map-stack credits (Esri "Powered by Esri", OSM) are separate: `src/maps/credits.js`
  `createMapCredits(viewer).show(html)` adds/removes a `Credit(html, true)` (on
  screen) following the active imagery source, including fallback.
- The credit container is a caller-owned `<div id="cesium-credits">` passed as
  `creditContainer` to `Cesium.Viewer` (`src/app/scene.js`), kept visible in clean
  view/recording; `src/creditKeyboard.js` adds keyboard access.
- Rule in DATA_SOURCES.md: adding a source = a DATA_SOURCES.md row **and** a
  `DATA_CREDITS` entry (`src/data/dataCredits.test.mjs` cross-checks).

### a.7 Search (`src/search/*`)

- `createPlaceSearch({providers, signal, timeoutMs=12000})` → `{geocode(query, {bias, signal})}`
  returning `{place: {lat, lng, name, label, types, viewport}|null, answered, fallbackUsed?}`.
  Iterates providers in order, stops at the first `place`; caches definitive answers
  (300 s hit / 30 s miss, 64 entries); `AbortSignal.any([lifetime, signal, timeout])`.
- Default chain (`src/search/defaults.js` `createDefaultPlaceSearch`):
  `createCoordinateGeocoder()` (lat/lon, DMS, MGRS via `mgrs`; `src/search/coordinateParser.js`)
  → `createPresetGeocoder({presets: CITY_POIS})` (bundled names, `src/locations.js`)
  → Google Geocoding (only when `resolveApiKey()` returns a key)
  → `createPhotonGeocoder({fetchImpl, endpoint})` (`src/keylessGeocoder.js`, komoot
  Photon, 6 s timeout, limit 5, OSM tag → Google place-type mapping table
  `OSM_TAG_TO_GOOGLE` so `geocodeNavigationMode` can frame areas vs points)
  → Nominatim via `/api/geocode` (server queue, 1 req/s).
- `createGeospatialServices({providers, signal})` composes independent operations
  `reverseGeocode(lat, lon)`, `textSearch(query, point)`, `nearby(point)`,
  `route(coords[[lon,lat]], profile)` → `{geometry, distanceM, durationS, ok, profile}`;
  reports `capabilities` and `attribution`. Timeouts 5 s (13 s for route).
- `createNominatimProvider({searchEndpoint, reverseEndpoint, fetchImpl})`
  (`src/search/nominatim.js` over `src/sources/nominatim.js`) for explicit instances;
  `normalizeNominatimReverse(hit)` → `{formattedAddress, locality, region, country, types, labels, streetLabels}`.
- Framing policy lives in `src/locations.js`: `geocodeNavigationMode(types)` →
  `'region-overview'|'city-overview'|'neighborhood-close'|'street-corridor'|'area-overview'|'precise-place'`;
  `placeFramingViewport`, `regionFramingPlan` (swath framing above 400 km spans).

### a.8 Cesium viewer creation (`src/app/viewer.js`, `src/maps/*`)

```js
new Cesium.Viewer(container, {
  timeline:false, animation:false, baseLayerPicker:false, geocoder:false, homeButton:false,
  sceneModePicker:false, navigationHelpButton:false, fullscreenButton:false, vrButton:false,
  selectionIndicator:false, infoBox:false, baseLayer:false, creditContainer,
  msaaSamples:4, contextOptions:{ webgl:{ preserveDrawingBuffer:true } },
});
viewer.targetFrameRate = 60; viewer.scene.globe.show = false;   // GEV hides the globe for Google 3D
viewer.scene.skyAtmosphere.show = true; atmosphereLightIntensity = 18; saturationShift = -0.12; brightnessShift = -0.08;
```

`installTrackpadPinchZoom(viewer)` relays Ctrl+wheel (browser pinch) into Cesium's
zoom with an 8× multiplier capped at 120 px.

Map sources (`src/maps/defaultSources.js` → `MAP_STACKS` in `src/maps/catalog.js`):

| id | kind | Keyless? | Factory |
| --- | --- | --- | --- |
| `photoreal` | Google 3D tileset | No (Google key or ion token) | `src/maps/google3d.js` |
| `bing-aerial`, `bing-labels` | ion imagery | No (ion token) | `createIonImagery(style, token)` |
| `esri-imagery` | ArcGIS World_Imagery | **Yes** (default when no key) | `createEsriImagery()` with `enablePickFeatures:false`; construction fallback → `osm`, tile-failure fallback after 2 errors → `osm` |
| `osm` | `OpenStreetMapImageryProvider` `https://tile.openstreetmap.org/` | **Yes** | `createOsmImagery()` |

Terrain: with ion token `createWorldTerrain(token)` (ion asset 1, vertex normals);
otherwise `createKeylessTerrain()` →
`CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid')`
(Re:Earth/Mapterhorn, CC BY 4.0, **ellipsoidal** heights), falling back to
`EllipsoidTerrainProvider`. Terrain factories are lazy (only created when a globe
stack is activated) and cached per `terrain.id`.

`MapSourceController` (`src/maps/controller.js`) API: `getStacks()`, `isStackAvailable(id)`,
`setStack(id, {silent})` → state `{activeId, activeStack, stacks, status:'switching'|'ready'|'error', lastError, hasCesiumIonToken}`,
`onChange(state)`, `onError(message, stack)`, `destroy()`. Switching uses a
generation counter so late async results cannot override a newer selection;
imagery layers are added at index 0; tilesets are toggled via `.show`.

---

## (b) Per-provider reuse pointers

### b.1 Earthquakes (USGS)

- Files: `src/layers/earthquakes/source.js` (`createUsgsEarthquakeSource({fetchImpl})` →
  `getSnapshot({signal})`), `records.js` (`normalizeEarthquakeSnapshot(geojson)`),
  `model.js` (`depthColor`, `createEarthquakeOverlayEntry`, `selectEarthquakeOverlayCohort`,
  `mapAnalystRecord`), `index.js` (`createEarthquakesLayer({source, overlayHost})`).
- Upstream: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`
  fetched **directly from the browser** (USGS sends CORS; no proxy). Cadence:
  `updateInterval: 60000`. No rate limiting.
- Record shape: `{stableId, usgsId, lon, lat, depthKm, mag, place, time}`; M<2.5 or
  missing magnitude dropped; the whole snapshot is rejected (`null`) on any invalid
  row or duplicate id so a bad feed never replaces the last good one.

```js
const [lon, lat, depthKm] = coordinates; const mag = properties.mag;
if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90 ||
    (depthKm != null && !Number.isFinite(depthKm)) || (mag != null && (!Number.isFinite(mag) || mag > 10))) return null;
if (mag == null || mag < 2.5) continue;
const stableId = feature.id == null || feature.id === '' ? `event-${index + 1}` : String(feature.id);
rows.push({ stableId, usgsId: feature.id ?? null, lon, lat, depthKm: depthKm ?? null, mag,
  place: typeof properties.place === 'string' ? properties.place : null,
  time: Number.isFinite(properties.time) ? properties.time : null });
```

- Rendering: one `Cesium.Entity` per event in a `CustomDataSource` with a
  `CLAMP_TO_GROUND` ellipse of radius `2^mag * 1000` m, colour by depth
  (<70 km red, <300 orange, else yellow), static axes (a `CallbackProperty` here
  re-tessellated ground geometry every frame — pinned by a test), plus overlay
  labels `M{mag}` via the world-overlay host (cohort 96, collision capacity 48).
- Tests: `src/data/earthquakes.test.mjs` (mapper, lifecycle, static-axes perf pin,
  idle-render request, failure/malformed handling), `src/layers/earthquakes/ownership.test.mjs`.

### b.2 Satellites (CelesTrak + satellite.js)

- Server: `server/providers/space/celestrak.js` `celestrakProxy()` mounts
  `/api/celestrak/:group` (group must match `/^[a-z0-9-]+$/i`), upstream
  `celestrakTleUrl(group)` = `https://celestrak.org/NORAD/elements/gp.php?GROUP=<g>&FORMAT=tle`
  (`src/data/spaceProviderRequests.js`). TTL 6 h memory+disk (`.gev-cache/celestrak-<group>.json`),
  single-flight per group, serve stale, `User-Agent: gods-eye-view-celestrak-proxy/1.0 (+repo url)`
  (CelesTrak 403s bulk groups without a descriptive UA), body must contain a `^1 ` line.
  Response `text/plain` with `x-tle-cache: HIT|MISS|STALE`.
- Client source: `src/layers/satellites/source.js` `createSatelliteSource({fetchImpl})` →
  `readGroup(group, {signal})` → `{ok, status, text}`; allowed groups
  `stations, visual, gps-ops, glo-ops, galileo, geo, starlink`.
- Catalog policy (`src/layers/satellites/policy.js`): `CATALOG_GROUPS` in dedupe-priority
  order `[stations, visual, gps-ops, glo-ops(tag 'glonass'), galileo, geo]` (~840 sats);
  dense mode adds `starlink` points-only; `ISS_NORAD = 25544`; `ORBIT_PATH_STEPS = 180`;
  `POSITION_UPDATE_MS = 1000`; `refreshInterval: 5 * 60 * 1000` (catalog refetch) with
  `updateInterval: 0`.
- Parsing/propagation (`src/layers/satellites/orbits.js`):

```js
function parseTLE(text) {           // name / line1 / line2 triples
  const lines = text.trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = 0; i < lines.length - 2; i += 3)
    if (lines[i+1].startsWith('1 ') && lines[i+2].startsWith('2 ')) result.push({ name: lines[i], line1: lines[i+1], line2: lines[i+2] });
}
function propagatePosition(satrec, date) {
  const posVel = propagate(satrec, date);            // satellite.js
  const geo = eciToGeodetic(posVel.position, gstime(date));
  return { longitude: degreesLong(geo.longitude), latitude: degreesLat(geo.latitude),
           altitude: geo.height * 1000, speedMps: Math.hypot(v.x, v.y, v.z) * 1000 };
}
```

  Ingestion (`ingestion.js`): fetch all groups in parallel, `twoline2satrec(line1, line2)`
  and skip `satrec.error !== 0`, dedupe by `Number(satrec.satnum)` (first group wins),
  keep the existing catalog if **every** group failed (outage guard). Orbit rings are
  baked at one GMST and re-rotated each second by `orbitFrameModelMatrix(gmstAtBake, now)`
  (Z rotation by `-(gstime(now) - gmstAtBake)`) so the ring closes.
- Rendering: `PointPrimitiveCollection` (`scaleByDistance NearFarScalar(1e6,1.5,2e7,0.6)`),
  `preRender` tick propagates the core fleet at 1 s idle / 200 ms tracked, dense
  Starlink round-robin over ~300 frames; ISS gets a persistent overlay label.
- ISS pass prediction: `src/data/issPass.js` `findNextIssPass`/`lookAnglesAt` (coarse
  30 s scan refined to 5 s).
- Classification colours: `src/data/satelliteClass.js`.
- Tests: `src/layers/satellites/source.test.mjs`, `src/data/satellitesTrackedRefresh.test.mjs`,
  `src/data/satellitesVisibility.test.mjs`, `src/data/issPass.test.mjs`,
  `src/data/satelliteClass.test.mjs`, `src/tooling/spaceProviders.test.mjs` (proxy).

### b.3 FIRMS (NASA active fires)

- Parser `src/data/firmsCsv.js` (pure, 188 lines): `isLikelyCsv(text)` (requires
  header fields `latitude,longitude,acq_date,acq_time,confidence,frp`),
  `parseFirmsCsv(text)` → `[{lat, lon, frp, confidence (raw 'l'|'n'|'h' or number),
  brightness (bright_ti4), brightnessTi5, daynight, acqDate, acqTime (unpadded), satellite, instrument}]`
  or `null` for non-CSV (FIRMS returns HTML/plain-text errors), `acquisitionMsUtc(acqDate, acqTime)`
  (pads `"45"` → `00:45Z`), `filterTrailing24h(records, nowMs)` (window `[now−24h, now+2h]`).
- Server `server/providers/firms.js` `firmsProxy()`: `/api/firms` → 
  `{fetchedAt, stale, ttlMs, sources:[{source,count,ok}], count, fires}`; `/api/firms/status` →
  `{hasKey, lastFetch, count, stale, ttlMs, transactions:{used,limit}|null}`.
  Upstream `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/world/2`
  for `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `VIIRS_SNPP_NRT` fetched **sequentially**
  (quota courtesy; 5,000 transactions / 10 min per key), `days=2` then clamp to 24 h,
  TTL 30 min memory + disk, single-flight, serve-stale, no key → `503 {error:'no_key'}`.
  Note the loop `for (const record of records) fires.push(record)` — a spread blew V8's
  argument limit at ~131k records.
- Client `src/layers/firms/source.js` `createFirmsSource()` → `getSnapshot()` returns the
  payload or `{keyRequired:true}`; `src/data/firmsAdapt.js` `adaptFirmsRecords(fires)` →
  `{index, lat, lon, frp, confidence (0..1: l=0.3,n=0.6,h=0.9, numeric/100), brightness,
  night, acqMs, sensor ('VIIRS'|'MODIS'), satellite, contextEntity:null, position:null}`.
- Cadence: layer `REFRESH_INTERVAL_MS = 600_000` (10 min); proxy TTL 30 min.
- Rendering (`src/layers/firms/rendering.js`, `viewport.js`, `policy.js`): LOD bands by
  camera height — aggregated grid cells (`renderCells`) at altitude, per-detection
  `BillboardCollection` sprites (`renderDetections`) close in, top-N context
  registration, horizon culling via `horizonOccluder`. `src/layers/firms/anchors.js`
  lifts fire anchors onto the ground floor (`FIRE_ANCHOR_LIFT_M`).
- Tests: `src/data/firmsCsv.test.mjs` (uses `src/data/fixtures/firms-viirs-noaa20-sample.csv`,
  45 rows, and `firms-csv-cases.json`), `firmsAdapt.test.mjs`, `firmsProxy.test.mjs`,
  `firmsHeatmap.test.mjs`, `firmsCards.test.mjs`, `firmsLabels.test.mjs`,
  `firmsHorizonCull.test.mjs`, `firmsInteraction.test.mjs`, `fireAnchors.test.mjs`,
  `src/layers/firms/source.test.mjs`.

### b.4 Aircraft (OpenSky, adsb.lol fallback, adsbdb enrichment, military registry)

**OpenSky proxy** `server/providers/aircraft/opensky.js` (`openSkyProxy()`, 701 lines):
`/api/opensky?lat=&lon=` → OpenSky `/states/all` JSON `{time, states: [...]}`.
OAuth2 client-credentials against
`https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`
(`getOpenSkyToken()`, coalesced refresh, 60 s margin), `OPENSKY_AUTH_MODE ∈ basic|oauth|auto|anon`.
Credit governor: base TTL 9 s; adaptive TTL from `X-Rate-Limit-Remaining`
(`>2400 → 9 s, >1200 → 30 s, >400 → 90 s, else 300 s`); 429 cooldown honouring
`X-Rate-Limit-Retry-After-Seconds` bounded 30 s…30 min; serve-stale with headers
`X-OpenSky-Cache`, `X-OpenSky-Auth-Mode-Used`, `X-OpenSky-Auth-Reason`,
`X-OpenSky-Stale-Seconds`, `X-OpenSky-Retry-After-Seconds`, plus `x-flight-source` /
`x-flight-coverage` when the regional fallback answers. When the cached OpenSky
snapshot is older than `OPENSKY_SOURCE_STALE_MS = 120_000` or during cooldown, the
proxy serves an adsb.lol **point** snapshot (`api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/250`)
around the camera anchor (0.25° cache cells, 12 s TTL, 80-entry cache, 8 MB cap).

**adsb.lol → OpenSky-shape mapping** (`src/data/adsbLolFallback.js`,
`normalizeAdsbLolAircraftState(aircraft, nowSeconds)` → 18-element OpenSky state vector):

```js
return [ hex, String(aircraft?.flight || aircraft?.r || '').trim() || null, null,
  Math.max(0, nowSeconds - seenPosition), Math.max(0, nowSeconds - seen), longitude, latitude,
  barometricFeet === null ? null : barometricFeet * FOOT_TO_M, onGround,        // alt_baro==='ground'
  groundSpeedKnots === null ? null : groundSpeedKnots * KNOT_TO_MPS, track,
  verticalRateFpm === null ? null : verticalRateFpm * FPM_TO_MPS, null,
  geometricFeet === null ? null : geometricFeet * FOOT_TO_M, aircraft?.squawk || null,
  aircraft?.spi === 1, 0, emitterCategory(aircraft?.category) ];                  // 'A1'..'B7' → OpenSky ints
```

WORLDVIEW should skip this OpenSky-array detour and use `normalizeReadsbAircraft`
(`src/sources/live/aircraft.js`) directly, which already produces the observation
shape from readsb JSON (`hex, flight, lat, lon, alt_baro ('ground'|ft), alt_geom, gs (kts),
track, baro_rate (ft/min), seen, seen_pos, category, t, r, ownOp`).

**Military** `server/providers/aircraft/adsb-lol.js` (`adsbLolProxy()`): `/api/adsblol/mil`
→ `https://api.adsb.lol/v2/mil`, 12 s cache, Retry-After cooldown (5 s…120 s, default
30 s on 429, 15 s on 5xx), headers `X-ADS-B-Cache: HIT|STALE|MISS`,
`X-ADS-B-Cache-Age-Ms`. Client `createAdsbLolSource()` computes `observedAtMs = now − ageMs`.
Traces: `/api/adsblol/trace?hex=` and `/api/opensky-track?icao24=` in
`server/providers/aircraft/tracks.js`; normalised by `normalizeAircraftTrack(rows, {baseTimeMs, readsb})`.

**Military registry** `src/layers/aircraft/classification.js` `createMilitaryRegistry({source, now})`:
`configureSource(source, {signal})`, `isMilitaryIcao(hex)`, `refreshMilitaryRegistryIfStale()`
(self-polls `source.getIdentities()` every 60 s while the military layer is off),
`setMilitaryLayerActive(bool)` + `onMilitaryLayerActiveChange(cb)`, `dispose()`.
Both aircraft layers share one instance; flights suppresses ICAOs the military layer
renders.

**Records** `src/layers/flights/records.js` `class FlightRecords({geoidHeight, cachedGroundFloor, floorAltitudeM})`:
`receive(observation, {viewerLatDeg, viewerLonDeg, trackedId, floorWarmPoints})` →
`{icao24, prevMeta, meta, groundFlipped, fixEpochMs}`; `absence(id, {complete, likelyLanded})`
→ `'retain'|'stale'|'remove'` (`MISSING_POLL_LIMIT = 3`, `LANDED_MISSING_POLL_LIMIT = 1`,
partial snapshots retain for 300 s); `forget(id)`. `meta` fields:
`sourceReference, observedReceiptMs, callsign (sticky), altitude (sticky baro/MSL — never
overwritten), geoAltitudeM, renderAltitudeM, onGround, wasAirborne, velocity, true_track,
category, klass, turnRateDps, verticalRate, originCountry, lastContactEpochMs, typeCode,
typeName, registration, airline, route, rawLat, rawLon`.
Render height policy (`src/data/renderAltitude.js`):

```js
export function pickRenderAltitudeM({ geoAltM, baroAltM, onGround, surfaceM, geoidN }) {
  if (onGround && Number.isFinite(surfaceM)) return surfaceM;
  if (Number.isFinite(geoAltM)) return geoAltM;                       // already WGS84 ellipsoidal
  if (Number.isFinite(baroAltM)) return baroAltM + (Number.isFinite(geoidN) ? geoidN : 0);
  return null;                                                         // caller applies sticky/default
}
```

**Ingestion** `src/layers/flights/ingestion.js` `createIngestion({feed, getQuery, applySnapshot, setSourceLabel, applyPendingTrackingRestore})`
and `createFlightFeed(source)`; `ERROR_BACKOFF_INTERVAL = 20000`; honours
`error.retryAfterMs`; `feed._lastUpdate` is the **source** epoch, not receipt time.
Poll: flights `updateInterval: 30000`, military `15000`.

**Enrichment** `server/providers/aircraft/enrichment.js` (`adsbdbProxy()`): `/api/adsbdb/type/<hex>`
and `/api/adsbdb/route/<callsign>`; 24 h TTL, negative caching, disk `.gev-cache/adsbdb.json`;
`parseRoute` → `{airline, origin:{code,name,lat,lon}, destination:{…}}`; `parseAircraft`
→ type/model/registration. Client `src/layers/flights/enrichment.js` limits to 4 in
flight, ~5/s, once per key per session, route lookups only for the tracked aircraft.

**Classification** `src/data/aircraftClass.js` `classifyAircraft({typeCode, category})` →
`'airliner'|'widebody'|'quadjet'|'turboprop'|'light'|'helicopter'|'glider'|'fastjet'|…`
(ICAO designator sets adapted from skylight, MIT); `CLASS_SCALE_2D`, `CLASS_SCALE_3D`,
`CLASS_MODEL_URL`, `CLASS_MODEL_REAL` map classes to `public/models/*.glb`.

Tests: `src/layers/flights/{records,ingestion,ownership}.test.mjs`,
`src/layers/military/{records,ingestion,ownership}.test.mjs`,
`src/layers/aircraft/classification.test.mjs`, `src/data/{flights,militaryFlights,adsbLolFallback,aircraftClass,aircraftMeta,motionModel,renderAltitude,geoid,militaryRegistry}.test.mjs`,
`src/sources/live/contract.test.mjs`, `src/tooling/liveProviders.test.mjs`.

### b.5 Vessels (AISStream websocket)

- Server `server/providers/vessels/ais-live.js` (`aisLiveProxy()`): one `ws` socket to
  `wss://stream.aisstream.io/v0/stream`, subscription `{APIKey, BoundingBoxes: [[[-90,-180],[90,180]]],
  FilterMessageTypes: [PositionReport, StandardClassBPositionReport, ExtendedClassBPositionReport, ShipStaticData, StaticDataReport]}`
  (env overrides `AISSTREAM_BOUNDING_BOXES`, `AISSTREAM_MESSAGE_TYPES`). Watchdog
  policy in `src/data/aisWatchdog.js` (pure): silence reported at 120 s, socket recycled
  at 2.5× that, backoff ladder `[5s, 15s, 60s, 300s]`, down retry 15 min, auth probe 1 h,
  tick 15 s. Transport adapter `src/data/aisStreamAdapter.js` (`createAisStreamAdapter`)
  owns monotonic socket generations and identity-checked map mutations.
  Routes: `/api/ais-live?maxRows=` → `{rows, status, newestPositionAt, lastMessageAt,
  refreshing, nextAttemptAt, silentForMs, reconnectAttempt, …}` (503 without key);
  `/api/ais-live/track?mmsi=` → `{mmsi, samples:[{lat,lon,t}], source, retainedSec}`.
- Store `server/providers/vessels/ais-store.js`: `ingestAisStreamEnvelope(envelope)` →
  boolean liveness; `AISSTREAM_CACHE_MAX = 50000`, `AISSTREAM_STALE_MS = 30 min`;
  per-MMSI ring buffers of 64 samples thinned at ≥30 s and ≥25 m.

```js
const messageType = envelope?.MessageType; const message = envelope?.Message?.[messageType] || {};
const metadata = envelope?.MetaData || envelope?.Metadata || {};
const mmsi = stringValue(metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi);
if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') { /* name/type/destination/imo → _aisStreamStatic */ }
const lat = numberValue(metadata.latitude ?? metadata.Latitude ?? message.Latitude);
const lon = numberValue(metadata.longitude ?? metadata.Longitude ?? message.Longitude);
_aisStreamVessels.set(mmsi, { lat, lon, name, mmsi, imo, type, destination,
  speed: normalizedSpeedOverGround(message.Sog ?? message.SOG), course: normalizedCourseOverGround(message.Cog ?? message.COG),
  heading: normalizedHeading(message.TrueHeading ?? message.Heading),
  last_position_UTC: normalizeAisTimestamp(metadata.time_utc ?? metadata.TimeUtc),
  last_position_epoch: aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc), _updatedAt: Date.now() });
```

- Client: `createAisStreamSource({apiUrl})` (`src/sources/live/standalone.js`) →
  `vesselSnapshot(payload)` (`src/sources/live/vessels.js`) adds `transportStatus`,
  `lastMessageAt`, `nextAttemptAt`, `silentForMs`, `reconnectAttempt`, `rawRowCount`.
  `src/layers/vessels/records.js` `normalizeVessel(row)` / `class VesselRecords.reconcile(rows, {complete, selectedRecord, cap}, effects)`
  with effects `{add, beforeUpdate, updated, remove, removed, staleSelected}`;
  `PARTIAL_RETENTION_MS = 5 min`, `SELECTED_PIN_REFRESHES = 3`. Poll `REFRESH_MS = 60000`;
  visibility pass 800 ms.
- Rendering: single `BillboardCollection`, per-record visual in a `WeakMap`
  (`position` lifted by `VESSEL_LIFT_M` above geoid), overlay cards via `vesselLabels.js`.
- Tests: `src/layers/vessels/{records,ingestion,ownership}.test.mjs`,
  `src/data/{aisStreamAdapter,aisStreamSentinels,aisWatchdog,aisWatchdogTransport,aisLiveVessels,aisLiveVessels.analyst,vesselLabels}.test.mjs`.

### b.6 CCTV (catalog, packs, frame proxy)

- Catalog build `server/providers/cctv/catalog.js`: merges file/env sources
  (`CCTV_SOURCES_FILE` default `config/cctv_sources.austin.json`, `CCTV_SOURCES_JSON`)
  with `LIVE_PACKS` loaded via `Promise.allSettled` (each pack independently gated by
  `CCTV_<PACK>_ENABLED`), normalises via `normalizeSourceItem`, caps per pack then
  round-robin to `CCTV_MAX_SOURCES` (default 4,000, ceiling 5,000; `cap.js`), joins
  precomputed ground heights (`groundHeights.js`), caches 15 min (`CCTV_SOURCE_CACHE_MS`).
- Packs (`server/providers/cctv/sources.js`, one loader per pack) and licence as documented:

| Pack | Loader | Catalog endpoint | Frames | Licence (DATA_SOURCES.md) | Keyless |
| --- | --- | --- | --- | --- | --- |
| austin | `loadAustinSourcesFromOpenData` | Socrata `b4k4-adkb` | city stills | City of Austin Open Data ToU (verify) | yes |
| caltrans | `loadCaltransSourcesFromOpenData` | cwwp2.dot.ca.gov per district | stills | Public Caltrans data (courtesy; verify) | yes |
| tfl | `loadTflSourcesFromOpenData` | api.tfl.gov.uk (optional `TFL_APP_KEY`) | TfL S3 stills | TfL Open Data — attribution **required** | yes |
| ontario | `loadOntarioSourcesFromOpenData` | 511on.ca/api/v2/get/cameras | 511on.ca/map/Cctv | OGL Ontario — attribution required | yes |
| fintraffic | `loadFintrafficSourcesFromOpenData` | tie.digitraffic.fi weathercam stations (header `Digitraffic-User`) | weathercam.digitraffic.fi | **CC BY 4.0** | yes |
| drivebc | `loadDriveBcSourcesFromOpenData` | drivebc.ca/api/webcams | drivebc.ca/images/<id>.jpg | OGL British Columbia — attribution required; per-camera partner `credit` | yes |
| txdot | `loadTxdotSourcesFromOpenData` | its.txdot.gov per district (`CCTV_TXDOT_DISTRICTS` default `AUS,SAT`) | JSON `{snippet: base64 jpeg}` decoded by `fetchTxdotSnapshot` | Public TxDOT data (courtesy; verify) | yes |
| tallinn | `loadTallinnSourcesFromCatalog` | `config/cctv_sources.tallinn.json` | ristmikud.tallinn.ee/last/camNNN.jpg | City of Tallinn (courtesy; verify) | yes |
| tarktee | `loadTarkteeSourcesFromDatex` | DATEX2 XML on tarktee.transpordiamet.ee | rotating image URLs | Transpordiamet (courtesy; verify) | yes |
| warendorf | `loadWarendorfSourcesFromCatalog` | `config/cctv_sources.warendorf.json` | webcam.warendorf.de | municipal (courtesy; verify) | yes |
| nsw | `loadNswSourcesFromOpenData` | data.livetraffic.com/cameras/traffic-cam.json | webcams.transport.nsw.gov.au (browser UA required) | **CC BY 4.0** | yes |
| calgary | `loadCalgarySourcesFromOpenData` | Socrata `k7p9-kppz` | trafficcam.calgary.ca | OGL Calgary — attribution required | yes |

- Camera record (`normalizeSourceItem`, served by `/api/cctv/sources` as `{sources:[…]}`):
  `{id, name, city, cityId, provider, lat, lon, headingDeg, headingConfidence, pitchDeg, fovDeg,
  rangeM, mountHeightM, groundElevationM, feedType ('image'|'video'|'hls'|…), sourceKind,
  poseSource ('curated'|undefined), license, credit, code, groundHeights|null}`; internal
  fields `url`, `snapshotUrl` are **never** sent to the client.
- Frame proxy design (`server/providers/cctv.js`): `/api/cctv/frame/<id>?label&city&lat&lon&heading&fov&pitch&ts`
  fetches only `source.snapshotUrl || source.url` (registered server-side); TxDOT JSON
  envelopes are decoded only for the official origin and the JPEG header validated;
  NSW is fetched with a browser User-Agent (`cctvUpstreamUserAgent(url)`); order of
  fallbacks: upstream image → Google Street View Static (needs server key; **drop in
  WORLDVIEW**) → synthetic SVG placeholder (`buildSyntheticCctvSvg`). Response header
  `X-CCTV-Source: upstream-image|streetview|synthetic`; per-camera health map
  (`/api/cctv/health` → `{cameras:{id:{status:'ok'|'degraded', sourceKind, label, message}}}`).
  `/api/cctv/media/<id>` streams video with a canonicalised single `bytes=` Range capped
  at 64 MiB (`range.js`), cancelling upstream when the client disconnects
  (`watchDownstreamClose`). `/api/cctv/stream/<id>` returns a stream descriptor JSON.
- Client `src/layers/cctv/source.js` `createCctvSource()` → `getCatalog()`, `getHealth()`,
  `getFrameUrl(camera, refreshMs)` (cache-busting tick = `floor(now / refreshMs)`),
  `getMediaUrl(camera)`. Active-camera refresh `ACTIVE_FRAME_REFRESH_MS = 10000`;
  ambient stills follow pack cadence (Fintraffic 600 s).
- Rendering (`src/layers/cctv/*`): billboard per camera, frustum wireframe, a textured
  "monitor plane" (1920×1080 canvas) projected in front of the camera pose
  (`projection.js`, `geometry.js`, `cctvFootprint.js` `planeSupportPoints`), calibration
  gizmo (`src/data/cctvGizmo.js`), LOD (`src/data/cctvLod.js`), viewshed
  (`src/data/cctvViewshed.js`). Ground regime logic in `ground.js` distinguishes
  `google-3d` vs `terrain-globe`.
- Tests: `src/data/cctv*.test.mjs` (15 files incl. per-pack source tests
  `cctvCalgary`, `cctvDriveBcSource`, `cctvEstonia`, `cctvFintraffic`, `cctvNswSource`,
  `cctvTxdotSource`, `cctvWarendorf`, plus `cctvProxy`, `cctvMediaRange`, `cctvCatalogCap`,
  `cctvGroundHeights`), `src/layers/cctv/source.test.mjs`, `src/tooling/mediaProviders.test.mjs`.

### b.7 Transit (GTFS-Realtime)

- Decoder `src/data/gtfsRealtime.js` (pure, uses `pbf` `PbfReader`, no generated code):
  `decodeFeedMessage(bytes)`, `normalizeVehicleEntity(entity)`, `decodeVehiclePositions(bytes)`
  → `{version, timestamp, incrementality, entityCount, truncated, vehicles}`; bounds
  `GTFS_MAX_ENTITIES = 50_000`, `GTFS_MAX_STRING_CHARS = 256` (over-long string drops the
  whole record). Vehicle record:
  `{id, lat, lon (6 dp), bearing [0,360)|null, speedMps|null, timestamp (s)|null, routeId, tripId,
  directionId, label, stopId, status ('INCOMING_AT'|'STOPPED_AT'|'IN_TRANSIT_TO'), occupancy}`.
- Registry `src/data/transitFeeds.js` `TRANSIT_FEED_REGISTRY` (7 feeds: `mbta`,
  `capmetro-austin`, `metrotransit-msp`, `hsl-helsinki`, `ovapi-nl`, `entur-norway`,
  `translink-seq`), each `{id, name, operator, region, center, loadRadiusKm, url, headers?,
  license, licenseUrl, attribution, defaultEnabled, terms:{quote, note}, defaultMode, routeMode(routeId), historyRetention?}`.
  Helpers `getTransitFeed`, `transitFeedsInRange(lat, lon, slackKm)`, `transitModeFor`,
  `publicTransitCatalog()` (strips URLs/headers for the browser).
- Proxy mechanics `src/data/transitProxy.js` (pure): TTL 15 s, stale max 10 min,
  timeout 15 s, body cap 8 MB, ≤3 redirects validated by `transitRedirectDecision`,
  admission 8/min/feed and 40/min global, backoff ladder, `buildTransitSnapshot(feed, bytes, now)`
  → `{feedId, name, fetchedAt, feedTimestamp, version, entityCount, truncated, count, vehicles}`
  (rejects differential feeds), `repairVehicleTimestamps`. Service
  `src/sources/transitService.js` `createTransitService({fetchImpl})` and
  `fetchTransitFeed(feed, signal, fetchImpl, validators)` (manual redirect hops,
  ETag/Last-Modified conditional requests). Route `server/providers/transit.js`
  mounts `/api/transit` (`/vehicles/<id>`, catalog, history for MBTA via
  `src/sources/transitHistoryStore.js`, 15 min retention).
- Layer: poll `TRANSIT_POLL_MS = 15_000`; delayed playback between reports
  (`src/layers/transit/movement.js`), billboards with mode colours/icons
  (`src/data/transitIcons.js`, `transitPresetStyle.js`), heights via the ground floor.
- Tests: `src/data/{gtfsRealtime,transitFeeds,transitProxy,transit,transitIcons,transitPresetStyle}.test.mjs`,
  `src/layers/transit/{lifecycle,movement,qaMetrics}.test.mjs`,
  `src/tooling/{transitProvider,transitService,transitQa}.test.mjs`, `server/providers/transitHistory.test.mjs`.

### b.8 Traffic (Overpass + TomTom)

- Roads: `src/layers/traffic/source.js` `createTrafficSource({fetchImpl})` →
  `requestRoads({south,west,north,east}, {majorOnly, timeoutSec, signal})` builds
  `[out:json][timeout:N];(way["highway"~"^(motorway|trunk|primary|secondary[|tertiary|residential|unclassified])$"](s,w,n,e););out geom qt;`
  (viewport ≤10° per axis, timeout 1–30 s), POSTs `data=` to `/api/overpass`, and
  `json()` → `{roads: normalizeOverpassRoads(body)}` where each road is
  `{coordinates: [[lon,lat],…], type: highway tag, oneway: 1|-1|0}` (`src/sources/overpassRoads.js`).
- Overpass proxy `server/providers/overpass.js`: body cap, `sanitizeOverpassBody`
  (`overpass/query.js`: bounds/timeout/element limits), mirror rotation
  (`overpass/transport.js`), disk cache + `resolveOverpassPreflight`, geometry
  simplification (`overpass/geometry.js`), per-IP 90/min + global 300/min, max
  concurrency (`OVERPASS_MAX_CONCURRENT`).
- TomTom: `server/providers/traffic.js` `/api/tomtom/status` → `{hasKey,…}`,
  `/api/tomtom/flow/{z}/{x}/{y}.pbf` (120 s cache, daily budget
  `TOMTOM_DAILY_TILE_BUDGET` default 6,000 via `src/data/tomtomTiles.js` `normalizeBudget`/`isOverBudget`;
  zoom 8–16; `tilesForBounds(bounds, zoom, {maxTiles:64})`). Client decode
  `src/layers/traffic/flowDecode.js` `decodeFlowTile(data, z, x, y)` (MVT layer
  `"Traffic flow"`, props `traffic_level` 0..1, `road_closure`, `road_type`) →
  `[{coords, trafficLevel, roadType, closure}]`; `src/data/flowMatch.js`
  `matchFlowToRoads(roads, flowSegments)` assigns levels to Overpass roads.
- Rendering: `GroundPolylinePrimitive` per road, `PointPrimitiveCollection` dots
  animated along waypoints (simulation speeds/densities in `policy.js`, `MAX_DOTS = 6000`),
  activation below `ACTIVATION_ALTITUDE = 8000` m, fetch debounce 320 ms; `updateInterval: 0`
  (viewport-driven).
- Tests: `src/layers/traffic/{source,navigation}.test.mjs`, `src/data/{traffic,trafficBounds,trafficQueue,trafficFlowStyle,trafficPresetStyle,trafficTiming,flowMatch,flowTiles,tomtomTiles,overpassProxy}.test.mjs`
  (fixture `src/data/fixtures/tomtom-flow-austin-12-935-1686.pbf`).

### b.9 Weather (Open-Meteo)

- `server/providers/regional/weather.js` `fetchRegionalWeather({latitude, longitude})`:
  GET `https://api.open-meteo.com/v1/forecast?latitude&longitude&current=temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility&timezone=UTC`
  through `fetchRegionalJson` (`regional/http.js`: 9 s deadline covering the body,
  512 KB cap here, `redirect` explicit).
- Normaliser `src/data/regionalModel.js` `normalizeRegionalWeather(payload)` →
  `{observedAt (ISO, forced UTC), temperatureC, apparentTemperatureC, precipitationMm,
  cloudCoverPct, windKph, windDirectionDeg, visibilityM, weatherCode}`; `weatherCodeLabel(code)`
  maps WMO codes to text.
- Route `server/providers/regional/weather-effects.js` `/api/weather-effects?latitude&longitude`
  (GET only): 0.1° cache cells, 5 min fresh, 30 min stale-on-failure, 180-entry cache,
  45/min/IP + 120/min global, coalesced; payload
  `{status:'ready'|'cached'|'stale', retrievedAt, coordinates, weather}`.
- Attribution: linked "Weather data by Open-Meteo.com" is **required** (CC BY 4.0).
- Tests: `src/data/regionalProxy.test.mjs`, `src/data/regionalBrief.test.mjs`,
  `src/weatherEffectsMath.test.mjs`.

### b.10 Places (Photon / Nominatim / Google)

- Photon: `src/keylessGeocoder.js` `createPhotonGeocoder({fetchImpl, endpoint = 'https://photon.komoot.io/api/'})`
  → `{geocode(query, {bias, signal})}`; 6 s timeout, 64-entry memo, `limit=5`,
  `PHOTON_TYPE_TO_GOOGLE` + `OSM_TAG_TO_GOOGLE` + `AREA_OSM_KEYS` map OSM classes to
  Google-style `types` so `geocodeNavigationMode` works keylessly.
- Nominatim (server): `server/providers/regional/place.js` `geocodeProxy()` mounts
  `/api/geocode?q&bounds` (Google-shaped response), sharing the 1 req/s queue with
  the reverse lookup used by the cockpit; identifying User-Agent/Referer, 5 min cache,
  bounded queue. Client normalisers in `src/sources/nominatim.js` /
  `src/nominatimGeocode.js` (`nominatimToGeocodeResult`, `nominatimViewboxFromBounds`).
- Google (remove): `src/search/google.js` `createGoogleGeocoder({request})`,
  `normalizeGooglePlace(result)`; server Places proxies in `server/providers/places/google.js`
  (`/api/google/nearby-places`, `/api/google/text-search`, projections in
  `src/data/placeProviderPayloads.js`).
- Tests: `src/search/{placeSearch,geospatial,coordinateParser,offlineGeocoders,nominatim}.test.mjs`,
  `src/keylessGeocoder.test.mjs`, `src/nominatimGeocode.test.mjs`,
  `src/tooling/{placeProviders,nominatimSearchRoute}.test.mjs`.

---

## (c) Cesium rendering reuse pointers

- **Viewer options**: see a.8. Cesium 1.138.0 (package.json `^1.124.0`), loaded via
  `vite-plugin-cesium`. Cesium is importable under Node for tests (`import * as Cesium from 'cesium'`
  works in node:test; tests pass fake `viewer` objects with `dataSources`, `scene.primitives`).
- **Imagery providers used**: `ArcGisMapServerImageryProvider.fromUrl(World_Imagery)`,
  `OpenStreetMapImageryProvider`, `IonImageryProvider.fromAssetId(IonWorldImageryStyle.AERIAL|AERIAL_WITH_LABELS)`.
  **Terrain**: `CesiumTerrainProvider.fromUrl(IonResource asset 1)` or Re:Earth
  ellipsoid mesh; `EllipsoidTerrainProvider` fallback. Google: `createGooglePhotorealistic3DTileset({key, onlyUsingWithGoogleGeocoder:true})`
  or `Cesium3DTileset.fromUrl(IonResource 2275207, {cacheBytes: 1.5 GiB, maximumCacheOverflowBytes: 1 GiB, enableCollision:true})`.
- **Camera / navigation** (`src/locations.js`, `src/cameraVerbs.js`, `src/camera.js`, `src/orbit.js`, `src/data/trackedCamera.js`):
  - `flyToLandmark(viewer, lat, lon, {range=500, pitch=-30, heading=0, buildingHeight=30, groundElevation, duration=3, buildingBounds})`
    samples `scene.globe.getHeight` (falls back to the preset ground elevation because
    Google tiles do not populate globe terrain), then `camera.flyToBoundingSphere` with
    `HeadingPitchRange` and locks with `lookAt` + `lookAtTransform(IDENTITY)` on complete.
  - `flyToGlobeView`, `flyToPresetLocation`, `flyToPOI`; `CAMERA_PRESETS` in `src/camera.js`.
  - Framing by geocode type: `geocodeNavigationMode`, `placeFramingViewport`,
    `regionFramingPlan` (`REGION_SWATH_SPAN_KM = 400`, swath range 280 km),
    `viewportMetrics` (bbox diagonal km).
  - `src/cameraVerbs.js`: `moveCamera(args)`, `adjustOrbitRange`, `flyRoute` (cinematic
    route flights with bank/altitude profiles, `probeMeshFloorM`), `interruptCameraMotion`.
  - Tracked entity: `trackedModelScaleForPixelCap`, `clampTrackedCameraPosition`,
    `applyTrackedCameraFrame(viewer, entity, viewFrom)`; satellites use `Entity.viewFrom`
    `TRACK_VIEW_FROM_LEO = (-450000, -450000, 350000)` m scaled up above 2,000 km.
  - Navigation authority events `gev:navigation-authority-taken` (`src/navigationPolicy.js`)
    and `gev:world-request-focus` (`src/worldFocus.js`) are the arbitration between
    user, voice and layers — model this as camera-gateway ownership tokens.
- **Entity/primitive strategy per layer** (from source):

| Layer | Strategy |
| --- | --- |
| Flights / Military | `BillboardCollection` sprites (SVG data URIs, 20 px / 24 px tracked, `NearFarScalar` scaling, depth test disabled everywhere) + `Cesium.Model.fromGltfAsync` glTF for near contacts (`MODEL_ALT_CEIL_M`, proximity/all modes, `MODEL_MAX`), `Cesium.Entity` only for the tracked target; trails as entity polylines with `depthFailMaterial` (`src/data/trailRenderer.js`); dead-reckoned positions updated per frame (`FLEET_DR_INTERVAL_MS`) |
| Vessels | one `BillboardCollection`; screen-projected rotation (`iconOrientation.js`) |
| Satellites | `PointPrimitiveCollection` + orbit `Primitive(PolylineGeometry)` re-rotated by model matrix |
| Earthquakes | `CustomDataSource` entities with clamped ellipses |
| FIRMS | `CustomDataSource` + `BillboardCollection`, LOD aggregation grid |
| Transit / Bikeshare / Directions / ALPR | `BillboardCollection` / `PointPrimitiveCollection`; directions drapes a `ClassificationType.BOTH` ground polyline with the annotation dash material |
| Traffic | `GroundPolylinePrimitive` roads + `PointPrimitiveCollection` dots |
| Cables | `GeoJsonDataSource` lines classified per stack + landing points |
| Infrastructure (JSONL) | points + stems + overlay cards with LOD ranking (`localGeojsonLod.js`) |
| CCTV | billboard + frustum polylines + textured plane entity |
| Labels/cards everywhere | **not** Cesium labels: the canvas world-overlay host (`src/overlays/worldOverlay.js`) |

- **Clustering / LOD**: no `EntityCluster`. LOD is hand-rolled per layer: camera-height
  bands (FIRMS `LOD_LEVELS`, infrastructure `infraLodBudget(cameraHeightM)` with
  80/200/420 active budgets and incumbent bonus), viewport rectangles with hysteresis
  (`viewChangedEnough`), bounded cohorts (`BoundedCohort`, `stableIdentityHash`),
  horizon culling (`horizonOccluder` in `src/data/iconOrientation.js`).
- **Selection / picking**: each layer installs its own `ScreenSpaceEventHandler`
  LEFT_CLICK; `src/data/pickRegistry.js` (`registerPickOwner(layerId, predicate)`,
  `resolvePickId(picked)`, `isOwnedByOtherLayer`) prevents sibling layers from treating
  another layer's pick as empty space. `src/data/scenePick.js` wraps `scene.pick`;
  `src/data/trackingClickGesture.js` distinguishes click from drag.
- **Credit display**: see a.6.
- **Performance tricks**: idle render governor (`requestRenderMode` when no holds);
  per-frame scratch objects (`Cartesian3`, `Cartographic`, `Matrix4`) reused; static
  ellipse axes (never `CallbackProperty` for ground geometry); billboards resampled from
  larger SVG sources; satellite dense mode round-robin propagation; sprite z-order via
  `src/data/spriteOrder.js`; overlay solver in a Web Worker
  (`src/overlays/worldOverlayAllocation.worker.mjs`); glTF models uncompressed to avoid
  Draco worker contention with photogrammetry; `docs/PERFORMANCE.md` documents the
  2026-08 investigation.
- **Post-processing**: `src/styles/*.js` export `{name, uniforms, fragmentShader}` for
  `Cesium.PostProcessStage`; `src/bloom.js` wraps `scene.postProcessStages.bloom`.
- **Assets / restricted**: `public/models/*.glb` are CC BY 4.0 (attribution + modification
  notice, see `public/models/README.md`); no GPL code or assets were found in `src/`,
  `server/`, `public/`, `tools/`, `scripts/` (a case-insensitive grep for `gpl` only hits
  substrings such as `leastOverlappingPlacement` / `clearPendingPlayback`). Fonts are
  loaded from Google Fonts CDN in `index.html` (Inter, JetBrains Mono, Material Symbols
  subset) — bundle locally for a desktop app. Google 3D Tiles content may not be cached
  or stored (Google ToS as quoted in DATA_SOURCES.md).

---

## (d) Tests worth retaining

Runner: `scripts/run-unit-tests.mjs` discovers `src/**/*.test.mjs`, runs them with
`node --test` in parallel, then runs two GC-bracketed allocation probes serially with
`--expose-gc --test-concurrency=1`: `src/data/focusAllocations.test.mjs` and
`src/overlays/worldOverlayAllocation.test.mjs`. Their byte budgets are **calibrated on
Node 24 only** (`isCalibratedAllocationRuntime` checks `major === 24`); on other majors
they are skipped unless `GEV_REQUIRE_ALLOCATION_GATE=1`. WORLDVIEW (Electron's Node)
should drop the allocation probes or recalibrate.

Retain **verbatim** (pure modules, no DOM/Cesium coupling):

| Test file | Asserts |
| --- | --- |
| `src/data/firmsCsv.test.mjs` (+ `src/data/fixtures/firms-*`) | CSV header detection, column reorder tolerance, unpadded `acq_time`, 24 h window inclusive bounds |
| `src/data/firmsAdapt.test.mjs` | confidence normalisation, acquisition ms, sensor mapping |
| `src/data/gtfsRealtime.test.mjs` | field decoding, extension skipping, bounded entities/strings, duplicate-id newest-wins |
| `src/data/transitFeeds.test.mjs`, `transitProxy.test.mjs` | registry integrity, redirect decisions, backoff ladder, snapshot building |
| `src/sources/live/contract.test.mjs` | OpenSky/readsb/AIS normalisation, atomic admission, error classes |
| `src/data/adsbLolFallback.test.mjs` | readsb → state-vector conversions |
| `src/data/aircraftClass.test.mjs`, `aircraftMeta.test.mjs`, `renderAltitude.test.mjs`, `geoid.test.mjs`, `motionModel.test.mjs`, `routePlausible.test.mjs` | classification tables, sticky merge, datum policy, EGM96, turn-rate integration |
| `src/layers/flights/records.test.mjs`, `src/layers/military/records.test.mjs`, `src/layers/vessels/records.test.mjs` | eviction/retention rules, identity stability |
| `src/layers/aircraft/classification.test.mjs`, `src/data/militaryRegistry.test.mjs` | military registry lifecycle |
| `src/data/aisWatchdog.test.mjs`, `aisWatchdogTransport.test.mjs`, `aisStreamAdapter.test.mjs`, `aisStreamSentinels.test.mjs` | watchdog policy, socket generation invariants, liveness rules |
| `src/search/*.test.mjs`, `src/keylessGeocoder.test.mjs`, `src/nominatimGeocode.test.mjs` | geocoder chain, coordinate parsing (DMS/MGRS), Photon type mapping |
| `src/sources/protocols.test.mjs`, `overpassFeatures.test.mjs` | capped readers, coalescing, Overpass feature normalisation |
| `src/data/tomtomTiles.test.mjs`, `flowMatch.test.mjs`, `flowTiles.test.mjs` | tile math, budget, MVT decode against the fixture |
| `src/data/layerState.test.mjs` | codec round trips and rejection rules (adapt to the new workspace schema) |
| `src/data/analystEngine.test.mjs` | filter/scope semantics |
| `src/data/naturalEarthRegions.test.mjs`, `neighborhoodPolygons.test.mjs` | region lookup + pack size budget |
| `src/data/localGeojsonLod.test.mjs` | LOD budget ranking |
| `src/maps/controller.test.mjs`, `src/maps/sourceFactories.test.mjs` | map source switching, fallback cycles, cancellation (Cesium imported in Node) |
| `src/app/application.test.mjs`, `stateChannel.test.mjs` | lifecycle controller |
| `src/loadingFeedback.test.mjs` | loading/notice reducers |
| `src/data/labelArbiter*.test.mjs`, `detectionCohort.test.mjs` | label budget allocation (render-dense) |

Adapt (they drive real modules with fake viewers/fetch but assume GEV file layout):
`src/data/earthquakes.test.mjs`, `src/layers/*/ownership.test.mjs`,
`src/layers/*/ingestion.test.mjs`, `src/data/{flights,militaryFlights,aisLiveVessels,cctv,traffic,transit,bikeshare,radio}.test.mjs`,
provider tests in `src/tooling/*.test.mjs` (they spin the Vite middleware with mock
`req`/`res`; rewrite against the provider-runtime interface).

Drop: the ~74 source-text regression tests (`readLayerSource`, `readShellSource`,
`readFileSync` + string assertions), `src/*Markup.test.mjs`, pinokio/keySetup/devFresh
tests, voice/director/scenes tests, `src/tooling/{format,importDirections,packageBoundaries}.test.mjs`
(re-create for the WORLDVIEW gate).

---

## (e) Bundled data / assets inventory

| Path | What | Size | Licence (as documented) | Commercial baseline? |
| --- | --- | --- | --- | --- |
| `src/data/local_data/datacenters/datacenters.geojsonl` (+README) | 4,351 OSM datacenter features; contact tags stripped; extraction date/query not recorded | 2.5 MB | ODbL 1.0 | Yes, with "© OpenStreetMap contributors" + share-alike on the derived DB; re-extract with provenance before release |
| `src/data/local_data/dams/dams.geojsonl`, `dams.geojson` (+README) | 704 dam features from OpenInfraMap/OSM (`waterway=dam`, `man_made=dam`, `building=dam`) | 0.7 MB each | ODbL 1.0 (+ Open Infrastructure Map credit) | Yes (same conditions); ship only the JSONL |
| `src/data/local_data/natural_earth/regions.json`, `marine.json` (+README) | 1,046 land + 292 marine named polygons, simplified 0.01°, from nvkelso/natural-earth-vector commit `ca96624a` (2026-07-28) | 2.0 MB + 0.6 MB | Public domain | Yes ("Made with Natural Earth" courtesy) |
| `src/data/local_data/neighborhoods/san-francisco.json` (+SOURCE.md) | 41 DataSF Analysis Neighborhoods, simplified 2 m, retrieved 2026-07-30 | 222 KB | PDDL 1.0 | Yes |
| `src/data/local_data/telegeography_submarine_cables/cable-geo.json`, `landing-point-geo.json`, `source.json` (+README) | 712 cables, 1,917 landing points, downloaded 2026-05-24 | 1.1 MB | **CC BY-NC-SA 3.0** | **No — delete** |
| `src/data/local_data/cctv_ground_heights/cctv_ground_heights.json` (+README) | Precomputed WGS84 ground heights for 3,445 cameras + 3×3 plane supports, `provider: "google-3d-tiles"` | 2.0 MB | Derived from Google 3D Tiles sampling (no licence stated; Google content may not be stored) | **No — drop**; regenerate from Re:Earth/own terrain if needed |
| `src/data/bhoteKoshiFloodPath.js` | GeoPera river centreline compiled into JS | 499 lines | **CC BY-NC 4.0** | **No — delete** |
| `public/events/bhote-koshi-2026/{pre,post}.webp`, `event.json`, README | Vantor WorldView-2/3 crops, GeoPera reconstruction | 2.3 MB | **CC BY-NC 4.0** | **No — delete** |
| `public/models/airplane.glb` (747, 88 KB), `jet.glb` (271 KB), `ship.glb` (230 KB), `bell206.glb` (321 KB), `c172.glb` (526 KB), `citation2.glb` (562 KB), `mq9.glb` (543 KB), `b789.glb` (470 KB), `atr72.glb` (264 KB) + README | Sketchfab models, optimised, Y-up, nose −X, origin centred | 3.2 MB total | **CC BY 4.0** each, creators listed in README | Yes, with attribution + modification notice retained |
| `public/logo.svg`, `pin.svg`, `mic.svg`, `location.svg`, `visual-presets.svg` | GEV branding/UI icons | small | Part of GEV MIT code (branding — do not reuse the logo) | Icons only |
| `config/cctv_sources.austin.json` | `[]` (Austin loads live) | 2 B | – | n/a |
| `config/cctv_sources.shinjuku.json` | 3 synthetic "Pilot Feed Pack" cameras whose `url` points at Google's public sample MP4 bucket (`storage.googleapis.com/gtv-videos-bucket/sample/*.mp4`); used only via `CCTV_SOURCES_FILE` to exercise the video projection pipeline | small | "Demo sample stream for projection pipeline testing" (no real camera data) | No — test fixture at most; replace with a WORLDVIEW-owned sample clip |
| `config/cctv_sources.tallinn.json`, `config/cctv_sources.warendorf.json` | Curated poses for Tallinn ristmikud and Warendorf webcam | small | Municipal camera data (courtesy); OSM-derived headings (ODbL) | Verify per pack |
| `src/data/fixtures/firms-viirs-noaa20-sample.csv`, `firms-csv-cases.json` | FIRMS decode fixtures (45 rows) | <20 KB | CC0 / US public domain | Yes (fixtures/*) |
| `src/data/fixtures/tomtom-flow-austin-12-935-1686.pbf` | One TomTom flow tile captured 2026-07-16 | 23 KB | © TomTom (test-only, never served) | Only with legal OK; otherwise synthesise a fixture |
| `scripts/fixtures/voice/full-globe-turn-on-radio.wav` | Voice test clip | – | – | No (voice removed) |
| `docs/media/*` | 19 GIF/PNG demo captures (Google 3D imagery visible) | 68 MB | GEV docs; imagery is Google content | No |
| `src/locations.js` `CITY_POIS` | Hand-authored city/POI presets with ground elevations and building heights | ~500 lines | GEV MIT | Yes |

---

## (f) Hazards

**Google coupling**
- `window.__GOOGLE_MAPS_API_KEY__` is set in `src/app/scene.js` and read by
  `src/mapStackController.js` and `src/search/defaults.js` (`defaultGeospatial` module
  singleton). Remove the global; pass keys explicitly to the optional adapter only.
- Startup path assumes Google 3D first (`loadPhotorealisticTileset`), sets
  `scene.globe.show = false`, and `MapStackController.initialStack` defaults to
  `'photoreal'`; `createDefaultMapSources.unknownId = 'photoreal'`.
- Layers branch on the `photoreal` regime: `src/layers/submarineCables/surface.js`
  (`ClassificationType.CESIUM_3D_TILE` when `activeId === 'photoreal'`),
  `src/services/meshFloorSampler.js` (`setMeshFloorPreferred(id === 'photoreal')`),
  `src/layers/cctv/ground.js` (`google-3d` vs `terrain-globe`), `src/data/bhoteKoshiEvent.js`.
  Generalise to "3D-tiles regime" vs "globe regime".
- CCTV Street View fallback (`server/providers/cctv.js` `streetViewFallback`) and
  precomputed `cctv_ground_heights.json` (`provider: google-3d-tiles`).
- Google Places supplement in installations (`searchNearby`) and `server/providers/places/*`.
- `tools/*` and `scripts/google-server-key.mjs` are Google-only.
- Google Fonts CDN links in `index.html`.

**OpenAI coupling**
- `src/voice/*` (32 files), `server/providers/openai/*`, `src/services/requests.js`
  (`summary: '/api/openai/hud-summary'` endpoint and `createApplicationOperations`
  requires a `summary.summarize` service — remove the requirement),
  `src/hudSummaryResponse.js`, `src/hud.js` AI summary path, `.env.example` OPENAI_* keys,
  `GEV_RATELIMIT_OPENAI_PER_MIN`.

**Cockpit / promotional UI**
- `src/ui/cockpit*.js`, `src/cockpit*.js`, `src/data/cockpitAirLod.js`,
  `cockpitContactDot.js`, `src/weatherEffectsMath.js`, `server/providers/regional/briefing.js`
  (news), `src/director/*`, `src/scenes/*`, `src/firstRunExperience.js`, `src/logoGaze.js`,
  `src/splitFlap.js`, `src/data/tr3bRegistry.js` (TR-3B easter egg swaps aircraft models).
  16 call sites listen to `gev:cockpit-mode-changed`.

**Global singletons / module state**
- `src/renderGovernor.js` (`_viewer`, `_holds` module-level), `src/data/contextStore.js`
  (`window.__gevContextStore`), `src/data/pickRegistry.js` (`_owners` map),
  `src/data/dataCredits.js` (`_dynamicCreditKeys`), `src/search/defaults.js`
  (`defaultGeospatial`), `src/data/geoid.js` (module promise), `src/standalone/application.js`
  (`constructed` flag — one app per page), `src/layers/…/state.js` bags are per instance
  but `src/data/<layer>.js` compatibility entries hold page-scoped defaults.
- Server providers keep process-scoped caches in module variables (`opensky.js`
  `_opensky*`, `ais-live.js` `_aisAdapter`, `weather-effects.js` `_weatherEffectsCache`,
  `overpass.js` `_overpassInFlight`), relying on one process per deployment; fine for
  Electron main but not for tests that construct multiple instances.

**DOM coupling inside data/layer code** (non-UI files that touch `document`/`window`)
- `document.*`: `src/data/bhoteKoshiEvent.js`, `src/data/cockpitContactDot.js`,
  `src/layers/awareness/{model,panel,rendering,subject}.js`, `src/layers/cctv/{cards,frames,geometryQueue,navigation,projection}.js`
  (canvas/image elements for frame textures), `src/layers/firms/model.js`,
  `src/layers/flights/{lifecycle,tracking}.js`, `src/layers/military/{lifecycle,tracking}.js`,
  `src/layers/launches/{lifecycle,overlays,panel}.js`, `src/layers/vessels/cards.js`.
- `window.dispatchEvent/addEventListener` custom events (`gev:*`): `map-stack-changed` (15
  sites), `cockpit-mode-changed` (16), `awareness-subject-selected/cleared`,
  `entity-selected`, `entity-selection-cleared`, `style-change`, `vision-change`,
  `radio-selected`, `world-request-focus`, `navigation-authority-taken`,
  `initial-share-restore-settled`, `cctv-request-focus`. `src/app/surfaceServices.js`
  accepts an injectable `eventTarget` — use that seam and replace the rest with an
  explicit event bus in state-engine/render-core.
- The world-overlay host (`src/overlays/worldOverlay.js`) creates its own DOM root/canvas
  by id (`world-overlay-root`, `world-overlay-canvas`) and an accessibility list.
- `src/data/contextStore.js` guards with `hasContextHost()` for tests; everything else
  assumes a browser.

**Node-24-only / modern-runtime features**
- Runtime code uses `AbortSignal.any` (`src/app/operations.js`, `src/search/*`,
  `src/layers/*/ingestion.js`), `AbortSignal.timeout` (providers, search),
  `Object.hasOwn`, `Array.prototype.at`, `String.prototype.replaceAll` — all fine in
  current Electron/Chromium and Node ≥20, but note `AbortSignal.any` needs Node ≥20.3 /
  Chromium ≥116.
- Tests use `node:test` + `node:assert/strict`; the two allocation-budget probes require
  Node 24 (`scripts/run-unit-tests.mjs`). `package.json` `engines: ">=24.14.0 <25 || >=26 <27"`.
- `server/providers/vessels/ais-live.js` probes for the optional `ws` dependency via
  `createRequire`; `node:crypto` `createHash` for socket hashes.
- No `node:sqlite`, `structuredClone`-dependent, `Promise.withResolvers` or
  `import.meta.dirname` usage was found in runtime code.

**Other**
- Skylight (MIT) code is adapted in `aircraftClass.js`, `aircraftIcons.js`, `aircraftMeta.js`,
  `issPass.js`, `motionModel.js`, `routePlausible.js`, `layers/{flights,military}/motion.js`,
  `server/providers/aircraft/enrichment.js`, `server/providers/space/celestrak.js` —
  keep the attribution comments.
- `.gev-cache/` on-disk caches use `process.cwd()`; Electron main must use
  `app.getPath('userData')`.
- `server/standalone/key-setup.js` writes secrets to `.env` / Pinokio `ENVIRONMENT` in
  plaintext (dev-only, documented); do not port.
- Vite `define` exposes `import.meta.env.GOOGLE_MAPS_API_KEY` / `CESIUM_ION_TOKEN` to the
  renderer bundle (`build/vite.js`); WORLDVIEW must keep *all* keys in main and hand the
  renderer only what an adapter explicitly needs.
