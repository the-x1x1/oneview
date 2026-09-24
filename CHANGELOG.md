# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **Imagery scenes** as an object type (`imagery-scene`, ADR-002 amendment): one capture by
  a satellite or aircraft — footprint drawn, centre marked, a "Scene" section with the
  collection, platform, capture time, cloud cover, resolution and links to the source page
  and thumbnail; searchable as "imagery" or "scenes"; in the Overview and Space lenses. The
  STAC connector (phase `stac`) produces them.

- **Sources as data** ([ADR-013](docs/adr/ADR-013-connector-architecture.md)). A source
  that publishes JSON, GeoJSON or CSV over HTTPS, or JSON over a WebSocket, is now one
  definition file — where it is, how its records are shaped, how each field becomes part of
  an object — run by a connector written once: `rest-json` (GET or POST, headers, a
  credential the app attaches, page-number, offset, cursor and same-origin next-link
  paging, the viewport as `{south}`/`{west}`/`{north}`/`{east}`), `geojson`, `csv` and
  `websocket-json` (a subscribe frame with the secret, heartbeats, message filters,
  batching, reconnect). Nothing in a definition is executed: paths, a fixed set of
  transforms (units, times, rounding) and filter conditions, and a mapping that cannot
  express something is a transform added with a test, not an expression language. Every
  definition starts with the most conservative data policy — commercial use unknown, no
  redistribution, packs or export, no raw payloads — and only a reviewed one may open any
  of it; endpoints are https to public hosts only. Your own definitions go in
  `%APPDATA%\WorldView\connectors\` and load at startup with their attribution, health
  and credentials like any other source; a file that does not validate is logged with the
  reasons and skipped. Shipped definitions (`connectors/enabled/`) are audited against the
  licence registry like providers.
- `pnpm connector:test <definition>|--all` runs the same fourteen checks on any definition
  from a `<name>.test.json` sidecar (fixtures, expected counts, ids and field values — data,
  not code): validation, parse, empty, malformed, timeout, auth, rate limit, oversized,
  cancellation, mapping error or reconnect, missing fields, attribution, data policy, rate
  policy; `--live` fetches one real sample through the app's own provider host with secrets
  from the environment only. `pnpm connector:add --url` drafts a fail-closed definition
  from one sample (GeoJSON, a JSON array, CSV) and lists what a person still has to decide.
- Example definitions with fixtures: USGS earthquakes as GeoJSON and as CSV, Citi Bike
  GBFS stations, a sample WebSocket vehicle feed.
- Docs: `docs/connectors/` (overview, mapping, each connector, testing),
  `docs/architecture/CONNECTOR-ARCHITECTURE.md`, `CONNECTOR-ECONOMICS.md`,
  `TERRIAJS-HARVEST.md`, `OPENMCT-HARVEST.md`.
- **Parallel phases.** The rest of 0.2.0 is cut into twelve phases — OGC, ArcGIS, STAC,
  local files, MQTT, Home Assistant, Traccar, HTTP ingest, telemetry, the Sources UI,
  provider migration, offline basemaps — each with a brief, a branch, owned paths and a
  slot in the shared files, so they can be built at the same time and merged in a known
  order (`docs/roadmap/PARALLEL-PHASES.md`, `INTEGRATION.md`, `pnpm phase-check`).

## [0.1.0-rc.5] — 2026-09-23

Planes that move and planes all over the world, cameras that show video where the agency
publishes it and say plainly where it does not, Taiwan's road cameras, and a release that
can only ever carry its own files.

### Added

- **Your own AIS receiver** (roadmap 0.5: AIS SDR, NMEA devices). Ships decoded by
  AIS-catcher, rtl_ais, a dAISy or a transponder behind a multiplexer are read as NMEA 0183
  over a TCP connection WORLDVIEW opens to it — this computer, or the one host you name, on
  the port you give (10110 by default). Positions (types 1–3, 18, 19) and static reports
  (5, 24) are decoded here, multi-sentence messages assembled, and each ship's name, call
  sign, type and size added to its positions; a ship also heard through AISStream is one
  object. Off by default; nothing listens, and nothing leaves the network.
- The provider SDK can open a TCP line stream for local sources (ADR-003).
- **Aircraft and ships move between reports**, as satellites do between propagations: each
  is drawn where its last reported ground speed and track carry it — at most a minute ahead
  of the report for an aircraft, two for a ship, then held until the next one — instead of
  standing still and jumping every poll (2.5 km a ten-second poll for an airliner, further
  whenever adsb.lol asks us to wait). On the ground, too slow or with no track reported, a
  report is drawn where it is. In 2D the moving markers in view are drawn from a small
  source of their own, so a step costs what moves, not the whole layer — which also lets
  satellites move between polls on the 2D map for the first time.
- **Aircraft all over the world when zoomed out.** adsb.lol answers no more than 250 nm
  around a point; a view wider than that now also asks for the commonest airliner, regional
  and business-jet types worldwide, one type a poll in turn (still one request every ten
  seconds), and keeps each answer until it is refreshed or ten minutes old. Aircraft of
  other types appear within 250 nm of the view centre or when zoomed in, and Sources says
  which.

- **Camera video.** A camera whose agency publishes video now plays it in the panel: live
  MJPEG from Taiwan's provincial-highway and freeway cameras, live HLS from Caltrans and Iowa
  DOT (in the unverified source, off by default), and TfL's ten-second JamCam clips, looped and
  labelled as a clip. A camera that publishes only stills says "Stills only", with how often a
  new picture comes, and fetches each as it is due — there is no "Live" button that showed a
  still.
- **Cameras in Taiwan**: 2,300 provincial-highway cameras from the Highway Bureau (MOTC),
  under Taiwan's Open Government Data License v1.0, each with live video. The Freeway
  Bureau's national-freeway cameras are there too but off by default: their catalogue server
  did not answer from outside Taiwan in testing. A camera that publishes only a stream gets
  its still from the stream's first frame.
- A QLDTraffic key of your own (Credentials) replaces the shared public one, which is limited
  to 100 requests a minute for everyone and often answers "too many requests".

### Fixed

- A camera catalogue that failed — Queensland's, rate-limited on its shared key, most often —
  took every one of its cameras off the map until it next answered, fifteen minutes later at
  best. Its last good list now stays (up to six hours) while the other catalogues answer.
- Zoomed out to the whole globe, the aircraft query went to 0°, 0° — the middle of the
  world's bounds, in the Gulf of Guinea — so there were no aircraft on the map at all. It
  now goes to where the view is centred (ADR-003).
- **rc.4 was published with rc.3's installer, portable zip and SBOM beside its own.** Nothing
  emptied the release output, and the assets were picked with wildcards. `release:package` now
  empties `apps/desktop/release/` and `artifacts/release/` first (and stops if it cannot), and
  the new `pnpm release:assert-version` fails unless the tag, installer, zip, blockmap,
  `latest.yml`, SBOM, SHA256SUMS and verification report are all this version and this
  commit; the build workflow runs it and uploads by exact name.
- A live MJPEG camera went blank when the agency's server closed the stream (Taiwan's does
  every 35 s): the stream is now read frame by frame and reopened with the last frame still
  showing.
- An unhandled "ReadableStream is locked" error was logged every time a camera stream ended.

## [0.1.0-rc.4] — 2026-09-23

Work since rc.3 on the operator's machine: more of the world on the map, a map that
stays smooth with tens of thousands of objects on it, and a set of places where the
interface said one thing and did another.

### Added

- **A local weather station** (roadmap 0.5). A Davis WeatherLink Live on your network is
  read from its documented local API, once a minute: temperature, humidity, dew point,
  "feels like", wind and gusts, sea-level pressure and its 3-hour trend, rain rate, today
  and 24 h, sun and UV — converted to SI with the US figure beside it. Off by default; it
  contacts nothing until you name the device's address and where the station stands (the
  device does not know), and only that address, over HTTP. Indoor readings are not read.
- **A local air-quality sensor** (roadmap 0.5, environmental sensors). A PurpleAir sensor on
  your network is read from its own JSON every two minutes: PM2.5 (ATM outdoors, CF=1
  indoors, as PurpleAir's own AQI uses), PM10, PM1, the device's US EPA AQI with its
  category, and the uncorrected temperature, humidity and pressure. Its two laser channels
  are averaged, and flagged when they disagree by more than 5 µg/m³ and 70 %. Off by
  default; only the address you name is contacted; the network name is not kept.
  **Unhealthy air is an event**: from AQI 101 until it is back to 90 or below, severity
  following the EPA category, so a watch zone around the sensor notifies — and re-notifies
  when the air gets worse. A reading the two lasers disagree on is not acted on.
- **The local-sensor kit** in the provider SDK: one endpoint policy (loopback, or exactly
  the one host the user names), one conservative detection (probe before polling, "… not
  detected at …" with a back-off, no discovery) and one way to read settings, for every
  source on the user's own machine or network. The ADS-B receiver source uses it too, and
  `docs/providers/BUILDING-A-PROVIDER.md` explains how to build one (ADR-003).
- **Public cameras in more of the world.** London (TfL JamCams), Ontario 511, DriveBC,
  the City of Calgary, the Hong Kong Transport Department, Vegagerðin (Iceland) and
  QLDTraffic (Queensland) join Fintraffic and Live Traffic NSW — every one openly
  licensed and on by default. Singapore (LTA via data.gov.sg) is its own source, polled
  every minute because its catalogue is its frame list. Sweden (Trafikverket, CC0, about
  1,500 cameras) runs once the operator enters their own free key. Caltrans, the City of
  Austin, NYC DOT, Iowa DOT and the NZ Transport Agency, whose image licences are not
  confirmed, are a separate source, off by default, kept for a day at most and never
  exported (docs/operator/cameras.md). About 13,600 cameras on the operator's machine.
- **Satellites move continuously** on the globe between polls, along the chord between two
  SGP4 propagations (the second carried as `nextPosition`), only while the timeline is live.
- **Search knows every country, state and province the map names** (the bundled Natural
  Earth label file), and "fly to <place>", "go to", "take me to" resolve the place.
- **Watch zones are drawn on the map**, and areas (alerts, zones) have an edge on the globe.
- **What changed.** A panel in the context rail lists, for the current view, the alerts
  and events that are new, the objects that ended, and the counts and source status that
  moved since you last looked; the `world.changed` command opens it.
- **Borders and place names.** Faint country and state/province borders and their
  names, on the globe and in 2D, from a bundled Natural Earth snapshot with bundled
  glyphs; two switches in Settings.
- **An object's history.** The selection panel draws an aircraft's or ship's altitude
  and speed over its track and replays from any point of it.
- **Satellites in replay** are propagated to the cursor from their stored element sets;
  every active satellite is shown, not a capped subset.
- **Tile cache.** Basemap tiles are kept on disk under a size cap, with zoom-ahead
  prefetch and an opt-in whole-world preload; cached Esri imagery stays usable offline.
  OpenStreetMap tiles are never cached.
- **Offline packs** show their size, coverage and age and can be outlined on the map.
- The Overview's categories are switches nested under it, each saying when its source
  is limited (the aircraft query's radius, for one). An application icon.
- **The feed can be ordered by relevance** — severity, then how recent, then how near the
  view — as well as newest first.
- **Watch zones escalate.** An event that rises in severity inside a zone notifies again
  ("— now Severe"); a zone can have quiet hours, which hold back everything below Severe,
  and its own minimum severity for desktop notifications.
- **The last search can be exported** as CSV or GeoJSON from the command palette, with its
  time window read from history.
- **`pnpm provider:scaffold`** writes a new GeoJSON point-feed provider — manifest,
  normalizer, provider class, synthetic fixtures, contract plan and a licence record —
  that passes the 16-check contract run as generated. The record is the most conservative
  there is (manual review, off by default, nothing redistributed or exported) until a
  person reads the source's terms (docs/providers/BUILDING-A-PROVIDER.md §0).
- **Signed offline packs.** A pack can carry an Ed25519 signature over its manifest
  (`pnpm worldpack keygen`, `build --sign`, `sign`); Settings → Offline packs says who
  signed each pack, lets the operator add publishers — from a publisher's key file, or from
  a pack whose signature verified — and can refuse everything their publishers did not
  sign. A signature that does not match is refused whatever the setting, and an installed
  pack whose manifest is edited afterwards is set aside. There is no built-in publisher
  (docs/OFFLINE-PACKS.md §4a).
- **Alert supersession.** A weather alert that updates or cancels earlier messages (CAP
  `references`) ends them and takes their place: the feed shows each chain once, as its
  latest message, and an alert's detail lists the messages it replaces or was replaced by
  (and an aftershock its mainshock) under "Related events".
- **Tropical cyclones.** A new source, the NOAA National Hurricane Center's active-storm
  file (public domain, on by default): each storm's position, strength, pressure and
  motion every 15 minutes. Each storm is an event titled by its class ("Hurricane … (Category
  3)"), with the track of its advisories, whether it is strengthening or weakening, and a
  severity that rises with it.
- **Fire growth.** A wildfire cluster carries its footprint in km² and a history of its
  size; one that has half again as many detections, or twice the area, as six hours before
  reads "— growing" and is a severity class higher, so a watch zone over it escalates.
- **Event history.** An event's detail lists what it recorded over time — a storm's
  advisory positions and strength, a fire cluster's size — newest first. An offline pack
  says when it was built and until when its publisher stands by it.
- **Place search at country scale.** Offline packs' place indexes are built into SQLite
  (FTS5) by the app when it runs on a Node with `node:sqlite`, and searched there instead of
  held in memory: 100,000 places answer in milliseconds, with the same ranking as before
  (a two-letter prefix in ~16 ms, a longer query in ~5 ms: entries stored most important
  first, prefix indexes on the token table, one statement per search).
- **Pack updates.** `pnpm worldpack update --from --to` makes an update pack that carries
  only the files that changed and takes the rest from the installed pack, checked byte for
  byte; it applies only to the exact pack it was made from. Installing over an installed
  pack refuses an older one, and a different signer's in place of a signed pack
  (docs/OFFLINE-PACKS.md §5b).

- **Performance budgets enforced in CI** (roadmap 1.0): `pnpm perf:budget` measures the
  presentation pass at 10,000 and 50,000 objects and the place index at 100,000 places,
  and the `perf-budget` job fails when a median passes its ceiling in
  `config/perf-budgets.json` — a local-zoom update of 10,000 objects must fit one 60 fps
  frame; the rest are regression ceilings (docs/architecture/RENDERING.md).

### Changed

- Accessibility: every badge colour now reads at WCAG AA (4.5:1) on its tint over every
  surface, and muted text on a hovered row — eleven did not (the reds at 3.8:1, the
  "unknown/disabled" grey at 2.6:1). A test reads tokens.css and holds them there.
- The map draws every object as its own dot, sized from measured frame rate rather than
  a fixed cap, and spreads big updates over frames. World deltas and snapshots cross to
  the page as JSON in parts of about a megabyte; zooming out past the regional band
  fetches the world a page at a time instead of one ~180 ms task.
- 2D and 3D agree on what a zoom level shows, whatever the window size.
- A public camera still is labelled with the time the image host gives it, and its age;
  when the host gives none, the label says it is the fetch time.
- After a 429 a host is not asked again before its Retry-After, and is then paced; a
  repeating warning is written once per ten minutes with a count — per provider, host,
  pack, group or layer, so one camera pack's warning does not hide another's.
- An unchanged object keeps its map feature between presentation passes; long frames in
  Diagnostics say which script, layout or style work ran in them.
- The globe cannot be zoomed out beyond 150,000 km, so it cannot be lost.
- Credentials are scoped per provider: a provider's HTTP client resolves only the keys
  its manifest names. A new credential mode, `xml-body`, fills a key into a POST body's
  placeholder, XML-escaped (ADR-003); optional keys are listed in Sources → Credentials.
- Camera rejections in app.log name the refused id, or where an off-host frame pointed.
- The parts of a big world delta are applied as one change, and satellites reach the page
  without their element sets: the worst frame during a satellite refresh went from ~100 ms
  to ~40 ms. Perf lines carry the engine's own frame time and each long frame's blocking.
- The feed dates a watch for later by when it was issued; alerts already in force at launch
  and sources settling into "needs a key" are not news. The connection badge reads ONLINE.

### Security

- `pnpm audit --audit-level high` passes again (CI's `dependency-audit` job had failed):
  two high advisories in electron-builder's packaging libraries (GHSA-p2f4-r6v6-j797,
  GHSA-7g7r-gx96-252g) came through an old `electron-builder-squirrel-windows@25.1.8` that
  pnpm kept as an auto-installed peer. `apps/desktop` now declares it at `^26.15.3`, in step
  with electron-builder; the 25.x chain (128 packages) is gone. Approved by the operator
  (docs/security/DEPENDENCY-EXCEPTIONS.md).

### Fixed

- The freshness sweep re-classified objects by the type default instead of their provider's
  declared policy: satellites read STALE two minutes after loading.
- "Nearby" ignored altitude: an earthquake's related objects were satellites overhead.
- The context rail's tabs overflowed behind a scrollbar with all panels open.
- Collect gave no feedback and added duplicates; a new watch zone listened for events the
  installation cannot raise.
- Hong Kong's 40 longer-key cameras were refused; NSW images on the catalogue host too.
- Up to ~200 zone-based weather alerts waited off the map for over an hour after a start.
- A readsb receiver on another machine could not be reached: the "Receiver on another
  machine" setting was accepted but the network layer only ever allowed loopback. The one
  host named there is now allowed, over plain HTTP, and probed (ADR-003).
- A pack built with `pnpm worldpack build`'s defaults required app 0.1.0, which every
  0.1.0 release candidate sorts below, so no existing build would install one. The default
  floor is now 0.1.0-rc.1; packs built before this need rebuilding (or `--min-app`).
- With a pack installed, "Honolulu" listed Honolulu twice and its airport three times: the
  pack, the built-in list and the reference labels each know them under their own id. A
  place of the same kind and name within a few kilometres (15 km for a city, 3 km for an
  airport) is now one result — the pack's record where a pack knows it.
- On Windows the SQLite place index was held open, so removing or updating its pack failed
  (`EBUSY`); it is opened for each search and closed after.

- Electron's and esbuild's install scripts were never running. pnpm 10 blocks a
  dependency's install scripts unless the repository names it, and neither was named:
  `pnpm install` finished with a warning, no Electron binary, and therefore no `pnpm dev`
  and no packaging. Declared in `pnpm.onlyBuiltDependencies`.
- `@duckdb/node-api` was declared as `>=1.2.0`, which matches none of its published
  versions — they all carry an `-r.N` prerelease suffix, and a semver range without a
  prerelease never matches one. `pnpm install` failed outright on the optional history
  backend. Pinned to `1.4.5-r.1` (the `lts-v1.4` line).
- `pnpm doctor` is also a pnpm command, so the script of that name was shadowed: the CI
  step that was meant to run WORLDVIEW's environment checks ran pnpm's own diagnostics
  instead, while `continue-on-error: false` made it look enforced. Every invocation is
  now `pnpm run doctor`, and a test fails the build if a script name is shadowed and
  invoked without `run`.
- The basemap and terrain pickers were never connected to the renderer; they are, and a
  mode with no usable basemap says why.
- The aircraft feed throttled itself; NWS let four alerts in five fail on its own rate
  limit and recorded a refusal as a broken zone.
- History wrote the same observation again and again; it deduplicates, cleans up what
  was written, and honours a size cap.
- A feed item or search result off screen is flown to; a live feed item takes its place
  in time order; replay removes live objects with no history at the cursor.
- A source waiting for a key no longer makes the whole app DEGRADED.
- Provider caches live in `provider-cache/`, not inside Chromium's cache.

## [0.1.0-rc.3] — 2026-09-21

An audit for "code that does less than it appears" found eight more gaps; this
closes them. Nothing here is a new feature in the sense of new scope — it is the
scope that was already documented, made to work.

### Added

- **Local cameras work end to end.** Settings → Cameras adds a camera by URL,
  lists what is registered and removes it. Registrations persist in
  `cameras.json` and are restored into their gateway at startup; camera logins go
  to the OS credential store like provider keys. Previously nothing in the
  interface called `camera.register`, a restart left the marker on the map with
  no registration behind it, and credentials were held in memory while the
  operator guide promised otherwise.
- **Provider settings are configurable.** A provider declares what it accepts in
  its manifest and the source panel renders that declaration — USGS feed window
  and magnitude floor, CelesTrak groups, FIRMS satellites and day range, the NWS
  contact and state filter, public-camera packs, the local ADS-B endpoint.
  `sources.settings.get`/`.set` had been implemented and never called.
- **`events.types.list`** reports which event types this build can actually
  raise, resolved against the registered rules and the enabled sources. The
  watch-zone panel renders it instead of a hardcoded list that offered two types
  nothing could produce and omitted `watch-zone-entry`, without which object
  entry alerts never fire.
- **`camera.list` gains a named contract type**, and the live camera view plays
  MJPEG and polled stills, saying plainly that HLS and WebRTC cannot play here.

### Fixed

- Search commands and parsed queries were clickable no-ops; all thirteen
  commands now run, and a query is executed and framed.
- A failed history read was rendered as "this object has no track"; it is now
  reported in Diagnostics with the reason.
- `world.related`'s comment claimed provider-based relation; it is proximity, and
  the panel now labels that list "Nearby".
- `img-src` allows the loopback camera relay, with a test that loopback is
  permitted in no other directive.

## [0.1.0-rc.2] — 2026-09-21

Four gaps closed between the interface and the runtime, and three overstated claims
corrected. No breaking changes to the frozen contracts; two additive ones.

### Added

- **Map-provider registry** (`map.providers.list`) — the runtime serves the basemap and
  terrain catalog resolved against configured credentials, installed world packs and
  connectivity, so an entry the installation cannot use arrives marked unavailable with
  the reason to show. The interface no longer carries a hardcoded catalog of its own.
- **go2rtc sidecar, composed** — RTSP cameras now work when the operator supplies the
  binary (Settings → Cameras, `AppSettings.cameras.go2rtcPath`). The sidecar was written
  and tested but never constructed, so RTSP could not work in any build. Nothing is
  downloaded or spawned until an RTSP camera is actually used; a relative path is
  rejected, and the spawn runs with no shell.
- **NWS zone geometry** — alerts that carry no polygon of their own (most watches and
  advisories) are drawn from the outlines of the zones they name, fetched from
  api.weather.gov and cached for a month, bounded to 20 new zones per poll. An alert is
  admitted only when every one of its zones is resolved, and is labelled
  `zone-geometry` so its shape is never read as one a forecaster drew.
- **`AppSettings.firstRunCompleted`** — first-run state is persisted settings rather
  than renderer storage, which is unavailable under the sandbox and disagreed with the
  settings file after a reset.
- **Documentation guards** — `tools/dev/docs-claims.test.ts` verifies that every test
  the threat model cites exists and that each threat states mitigation, verification and
  residual risk; `tools/dev/product-boundary.test.ts` enforces the shape of
  `PRODUCT-BOUNDARIES.md` in code.

### Changed

- `basemapId` defaults to `natural-earth` (the bundled, zero-credential imagery).
- The presentation benchmark's headline figure now counts the whole in-thread update
  (present _and_ diff) rather than `present` alone. That changes the reported local-zoom
  frame budget from 100k objects to 50k: the number was an overstatement of roughly the
  cost of the diff, not a regression.

### Fixed

- Registering an RTSP camera with no sidecar configured was accepted and could never
  stream; it is now refused with an explanation.
- The threat model cited six tests that did not exist under those names, and three
  threats were missing a stated residual risk.

## [0.1.0-rc.1] — 2026-09-21

First release candidate: a working Windows desktop application, not a scaffold.

### Added

- **World model** — canonical `Observation`, `WorldObject`, `WorldEvent`, provenance,
  deterministic identifiers, per-type freshness policies, a documented confidence model
  and a dependency-free schema validator (`architecture-contract-v1`).
- **Provider SDK and runtime** — manifests with a mandatory data policy, capability-based
  provider context, host allowlists, timeouts, bounded retries, circuit breakers, rate
  limiting, request coalescing, stale-on-error, structured health, and a 16-check
  contract checklist (`pnpm provider:test`) that is the definition of "provider complete".
- **Providers** — USGS earthquakes, CelesTrak satellites, NASA FIRMS fires (key
  required), NWS weather alerts, adsb.lol aircraft, local readsb receiver, AISStream
  vessels (key required, off by default), public CCTV catalogs (Fintraffic, Live Traffic
  NSW), user cameras, and a bundled airport dataset.
- **World state** — batched ingest, deterministic cross-source identity resolution,
  grid spatial index (100k objects, bbox query in single-digit milliseconds), freshness
  sweeps, expiry, per-object tracks.
- **History and timeline** — partitioned Parquet/NDJSON history with policy-aware
  retention and tiered downsampling; LIVE / PAUSED / REPLAY / HISTORICAL modes with
  honest availability boundaries.
- **Rendering** — one rendering contract with Cesium (3D) and MapLibre (2D) adapters,
  level-of-detail from density cells to icons, clustering, label decluttering, trails,
  2D/3D view synchronisation and suspension of the hidden renderer.
- **Interface** — React shell with lenses, search (deterministic grammar, no LLM),
  context panels by object type, source health, world feed, collections, watch zones,
  settings, diagnostics, command palette, first-run flow and a demo mode labelled
  RECORDED DATA.
- **Offline** — `.worldpack` data containers with hardened import (path traversal,
  symlinks, executables, decompression bombs, checksum verification), a builder CLI, a
  local place index, connection-state monitoring, and a network-disabled test group that
  is the basis for every offline claim.
- **Cameras** — gateway with a loopback-only relay, credential stripping into OS-protected
  storage, optional pinned go2rtc sidecar, and no frame analysis of any kind.
- **Security** — context isolation, sandbox, strict CSP, navigation lock, allowlisted and
  schema-validated IPC with no generic execute/read/fetch channel, DPAPI-backed
  credential storage, central redaction, and a threat model with a verifying test per
  mitigation.
- **Release engineering** — fail-closed CI, Windows packaging, CycloneDX SBOM, license
  audit, verification report, doctor, marker report, and a human QA checklist.

### Known limitations

See [docs/releases/KNOWN-LIMITATIONS.md](docs/releases/KNOWN-LIMITATIONS.md). The
headline ones: builds are unsigned (automatic installation stays disabled), offline 3D
terrain is ellipsoid-only, FIRMS and AISStream need keys, and 27 providers/sources
remain conditional or under legal review and are off by default.

### Upstream

Adapted from [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) at
`0dbde1e3` (MIT). Deliberately not carried over: the Google-3D-first startup path,
non-commercial datasets (TeleGeography cables, Bhote Koshi), Google-derived camera ground
heights, the ALPR layer (privacy boundary), Google News (non-commercial terms), OpenSky
(non-commercial licence), and the voice/director/cockpit subsystems. See
[UPSTREAM.md](UPSTREAM.md).
