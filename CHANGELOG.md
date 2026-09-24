# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.7] — 2026-09-24

All twelve 0.2.0 phases are in. New sources on your own network — MQTT brokers (rtl_433,
OwnTracks, Meshtastic), Home Assistant, Traccar, and an HTTP listener for anything that
can POST — a Readings section for sensor values over time, the Sources panel's connector
badge, Definitions section and Add source, and a tool to build your own offline basemap.

### Added

- **Build your own offline basemap** (guide in `docs/OFFLINE-BASEMAPS.md`):
  `pnpm basemap:build --region hawaii --out <dir> --osm <file.osm.pbf>`.
  - **What it does:** takes an OpenStreetMap extract you downloaded yourself and runs
    Planetiler with the Protomaps basemap profile on it, cut to the region. The result is
    a PMTiles file in the schema the 2D styles draw, plus a world pack holding it for
    Settings → Offline packs → Install offline pack. The map does not draw a pack's
    basemap yet; the phase brief's amendment requests say what is missing.
  - **What it finds:** Java 21+ and the Protomaps basemap jar, already on the machine
    (`--java`/`JAVA_HOME`/`PATH`, `--jar`/`ONEVIEW_PLANETILER_JAR`/`PATH`). It recognises
    the jar by its contents without running it, and refuses a stock Planetiler jar, whose
    OpenMapTiles layers the styles would not draw.
  - **It downloads nothing:** not Java, not Planetiler, not the extract, not the profile's
    other inputs, and never anything from OpenStreetMap's tile servers. Every input must
    already be on disk, and an extract whose header bounding box misses the region is
    refused. Planetiler runs:
    - with every download, refresh and Wikidata switch off;
    - without `PLANETILER_*` variables or Java's option variables in its environment;
    - in a directory of its own for each run, removed when the run ends, even after
      Ctrl-C (the child is waited for).
  - **Checks:** `--dry-run` checks everything, runs only `java -version`, and prints the
    Java command. The output is checked before it is packed: vector tiles, the Protomaps
    layers, and tiles present.
  - **Report:** the file next to the pack records the extract's SHA-256 and the page it came
    from (`--osm-url`, never fetched), the Java version, the jar's SHA-256, the full
    command, how long it took and what came out.
  - **Licence:** the pack is filed under the registry record `osm-protomaps-planetiler`,
    credited "© OpenStreetMap contributors, ODbL" with the Protomaps licence (BSD-3-Clause,
    design CC0) and ESA WorldCover (CC BY 4.0) for the landcover. Until that record is in
    `config/licenses/providers.json`, packing is refused and `--pmtiles-only` builds the
    file alone.
- **Martin tile sources, read side** (`packages/offline/src/basemaps/martin.ts`). A Martin
  server's source is read through its TileJSON for the tile template, zoom range, bounds
  and attribution, and `/catalog` lists its sources.
  - Only loopback or the one host you trust may be named over http; anything else must be
    https under a public name.
  - Tile templates must keep the server's scheme and origin, redirects are not followed,
    and the document is capped at 1 MiB with a 10 s timeout.
  - A source without the Protomaps layers is refused, and the refusal names the layers it
    has; so is one that credits nobody.
  - The app cannot select a Martin basemap yet: the renderer descriptor, catalog entry, CSP
    origin and package export it needs are amendment requests.
- **MQTT brokers as sources** (phase `mqtt`): the `mqtt` connector subscribes to topics (`+`/`#` filters, QoS 0 or 1) on a broker on this computer (127.0.0.1) or on the one host the operator names in the source's Broker address setting, through the runtime's own MQTT 3.1.1 client. Nothing is published, nothing is discovered. The username is in the definition and the password is a stored credential that only the runtime sees. Each JSON message is mapped as a WebSocket message is (`itemsPath`, message filter, batching by id). The topic reaches the mapping as `_topic` and its levels as `_topic[n]`. A payload that is not JSON is a record `{ raw, topic }`. A retained message is mapped once, not again on every reconnect. A dropped connection is reopened with a back-off from 2 s to a minute.
- **Positions for sensors that send none**: a device is placed from the payload, else from a per-device table in the definition (`mqtt.positions`), else — for a stationary source only — from the operator's `position.fixed` setting. Such observations carry the `configured-position` flag. A device with no position is named in Source Health instead of disappearing.
- **Presets** for `rtl_433` (events topic, device `model:channel:id`, weather station/sensor/other class with tyre-pressure sensors always `other`, one unit per reading, readings merged per device, only unambiguous times), **OwnTracks** (location messages, device from the topic; for the operator's own devices, as the operator decided against the product boundary on phones) and **Meshtastic** JSON gateways (position, node info and telemetry merged per node, 1e-7 degrees; text messages are never read).
- `docs/connectors/mqtt.md`, five example definitions with sidecars (rtl_433 weather stations and sensors, OwnTracks, Meshtastic, a generic GPS tracker), invented fixtures, and `mqtt.test.ts` (the suite's MQTT mode on every example, topic matching, the definition block, connect options, reconnect and back-off, a changed broker address, retained handling, batching, raw payloads, the three position sources, the presets).
- **The definition carries its `mqtt` block** (ADR-013 amendment M1) and `pnpm connector:test` runs MQTT definitions through `testing.FixtureMqtt` (M2), so the five MQTT examples are checked like every other in `connectors/examples/mqtt/`.
- **Home Assistant as a source** (phase `home-assistant`): the `home-assistant` connector shows the operator's own Home Assistant — its zones, its weather entities and the environmental and energy sensors a definition selects — through Home Assistant's documented APIs with a long-lived access token stored under Sources → Credentials and named in the definition only by reference. It reads `GET /api/states`, and over the WebSocket API sends only `auth`, `subscribe_events` for `state_changed`, and `ping`. No service is ever called.
- The instance is the source's own settings (host, port, TLS), under the local-endpoint policy: this computer, or exactly the one host the operator names. A definition never holds an address. Entity patterns and a positions table (a fixed point, or a zone) narrow and place what a definition selects; weather and sensor definitions can fall back to Home Assistant's home location.
- Readings reach the payload in SI units through the transform registry (°F to °C, K to °C for a temperature, mph/km/h/kn to m/s, inHg/Pa/kPa/mmHg/psi to hPa, in to mm, mi/km/ft to m), and only when Home Assistant states the unit.
- `person` and `device_tracker` entities are never read: dropped on arrival, whatever a definition or a setting selects (PRODUCT-BOUNDARIES: no private-device tracking). A zone keeps its place and radius but not who is in it: its person count, its `persons` list and its update times are dropped, and an arrival or departure emits nothing.
- `docs/connectors/home-assistant.md`, three example definitions (zones, weather, sensors) with sidecars, invented fixtures in the APIs' published shapes, and `home-assistant.test.ts` (the shared suite on every example; the socket handshake, events, reconnect and resubscribe, ping and silence, `auth_invalid`; entity selection and positions; unit conversion; and a check that no frame other than the three and no request other than `GET /api/states` is ever sent).
- An instance on plain HTTP is read from `/api/states` once a minute (the host opens only `wss://` sockets; `ws://` to a local host is still a request), and Source Health says why.
- **Traccar as a source** (`traccar` connector, phase `traccar`). A Traccar GPS tracking server's devices appear as objects at their latest positions, with speed (knots converted to m/s), course, altitude, battery, ignition, motion, protocol and — over the socket — the event Traccar raised (geofence entry and exit, alarms, …) on the device's latest observation. The connector reads `/api/devices` (every five minutes) and `/api/positions` by REST with the token as a bearer credential reference, and — on a public https server with a `websocket` — follows `/api/socket` live, the token put in the dialed URL by the host (`?token=`); the poll keeps running underneath, so a server whose socket refuses the token still shows positions (DEGRADED, with the reason). A server on this computer, or on the one host named in the source's `host` setting, is read by REST every 30 seconds under the local-endpoint policy. Devices in Traccar's `person` category are left out, failing closed (nothing is shown until a device list has been read), and a device's `uniqueId`, phone, contact and driver id never reach an observation. Three disabled, user-configured examples (`connectors/examples/traccar/`), invented fixtures, a guide (`docs/connectors/traccar.md`) and 37 tests.
- **HTTP ingest (`http-ingest`).** Anything that can POST — a Node-RED flow, a script, a Raspberry Pi, a gateway — can
  push records into a source: while the source runs, the host listens for it on `127.0.0.1` only, at
  `/ingest/<source id>`, on the port in the source's `port` setting (default 47311), and takes a `POST` only with the
  source's bearer token. A push is the `oneview.ingest.v1` envelope (`schema`, `source`, `records`) or a bare JSON array;
  each record goes through the definition's mapping and lands as a delta. The pusher gets `202` with accepted, rejected
  and filtered counts (and up to five reasons), or `400` with why; the host's own refusals are `401` (token), `404`,
  `405`, `413` (size, 1 MiB by default), `421` (Host) and `429` (rate, 600 a minute by default). Records without a time
  get the receipt time and the `fetch-time` flag. Source Health shows where the source listens, the last push, the
  pusher's User-Agent, and what was refused. Changing the port setting moves the listener; a port
  that is busy is tried again until it is free. Guide:
  `docs/connectors/ingest.md`, with curl, PowerShell and a Node-RED flow to import.
  `pnpm connector:test` runs pushed sources through the fixture listener (ADR-013 amendment A1), so both ingest examples are checked like every other; a refused push or a new token shows in Source Health within a second (A3).
- **Readings: a sensor's values over time** (`@worldview/telemetry`, the context panel's
  Readings section; guide in `docs/connectors/telemetry.md`). Selecting a weather station
  or a sensor plots its readings — temperature, humidity, pressure and wind for a
  station; every number a sensor reports, with PM2.5, AQI and the other known keys named
  and given units — one chart per reading on a shared time axis over the last 1 h, 6 h,
  24 h or 7 d. The window ends at the timeline's cursor, so replay moves it and nothing
  after the cursor is shown; pointing at a chart reads every value at that moment, and a
  click, Enter or Space puts the replay cursor there. Limits are shaded (the AQI's 100 and
  150 category edges by default) and the value at the cursor says when it is past one;
  nothing alerts on them. A connector definition names its readings, units, formats and
  limits in a `telemetry` block, validated with the manifest, and those win over the
  defaults. Values come from history through the existing `history.query` request, at
  most one per sixtieth of the window (the last in each), with long gaps shown as breaks
  and at most 2,000 points a series; an empty window says "No readings in this window".
  Two examples, disabled: the latest observation of an NWS station (KPHX) and a
  greenhouse logger's CSV.
- Sources shows which sources are connector definitions: the connector (`rest-json`, `geojson`, …) sits under the source's name, and the open row names the definition file.
- A Definitions section in Sources: the operator's folder, Open folder, Reload without restarting (it says which sources started, restarted or stopped), a switch per file, and the reasons a file was rejected. Demo mode has no folder and shows no section.
- Add source: an https address is fetched once and drafted into a definition, with the validator's verdict and what is still to decide; Save writes it into the folder, disabled. A draft that does not validate cannot be saved.
- A definition's description can no longer make a manifest the host refuses: ` Connector: <name>.` is kept within the manifest's 500 characters (ADR-013 amendment, R5 of phase `telemetry`).

## [0.1.6] — 2026-09-24

The first release with sources as data: a source is a definition file run by a connector,
and ArcGIS layers, OGC services (WFS, OGC API Features, WMS, WMTS), STAC catalogues and
local files (GeoJSON, CSV, GPX, KML, TopoJSON, and more through your own GDAL) can be added
without code — examples for each are in `connectors/examples/`. Versioning moves from release candidates to plain patch numbers (0.1.6,
0.1.7, …) until 0.2.0.

### Added

- **Definitions from the app** (ADR-013/ADR-004 amendment, for phase `source-health-ui`).
  The runtime lists every connector-definition file — accepted ones with their connector,
  refused ones with the reason — reloads the folder while sources run (a removed file's
  source stops, a new one starts disabled, a changed one restarts, the rest are left
  alone), switches a file's source on or off, opens the folder in Explorer, drafts a
  definition from a URL in the main process (the same drafter as `pnpm connector:add`,
  which now lives in `@worldview/connector-runtime`) and saves it into the folder disabled.
  Source Health entries say which connector and file a source came from. The Sources panel
  UI for this is the `source-health-ui` phase.

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
- **Telemetry descriptors** (ADR-003/013 amendment): a source — a provider's manifest or a
  connector definition's `telemetry` block — can say which of its readings to plot, with
  names, display units, a fixed format and warning/critical limits. The Readings panel
  (phase `telemetry`) builds on it; the new `@worldview/telemetry` package is its home.
- **A listener on this computer, for sources that push** (ADR-003 amendment): a
  local-process source can open one HTTP listener on 127.0.0.1 and receive POSTs that carry
  its token — the app compares the token and refuses everything else (other addresses, a
  foreign `Host`, other paths and methods, oversized bodies, floods) before the source sees
  a request. It is what phase `ingest` (Node-RED, scripts) builds on; nothing listens unless
  such a source is switched on. The threat model covers it (T16), and the granted folder and
  `ogr2ogr` (T17).
- **A socket credential in the URL** (ADR-003/013 amendment): a WebSocket definition can
  say `"credential": { "name": "…", "as": "query" }` and the app puts the secret in the URL
  it dials (`?token=…`, or the `param` named) instead of the subscribe frame — Traccar's
  socket takes it that way — with the secret in no log, health line or definition.
- **Raster overlays** (ADR-008 amendment): a source can offer tile layers — XYZ, WMS or
  WMTS over https — that the map and the globe draw under the reference layers, with the
  source's attribution; at most 32 per source, no credentials in a URL. The OGC connector
  (phase `ogc`) offers a WMS or WMTS service's layers this way.
- **A folder you name** (ADR-003 amendment): a file source whose manifest declares a
  `grantedFolderSetting` reads from the one folder its setting points at — the runtime
  resolves paths inside it, refuses anything outside, and watches it for changes — instead
  of only its own resource directory. Phase `files` builds on it.
- **MQTT** as a local transport (ADR-003 amendment): a source on this computer or on the
  one host you name can subscribe to topics on an MQTT broker — the app speaks MQTT 3.1.1
  itself, with your broker password from the credential store and never a publish — with
  payload and rate caps and typed refusals. The MQTT connector and the rtl_433, OwnTracks
  and Meshtastic presets (phase `mqtt`) build on it.
- **Which built-in sources could be definitions, with the evidence**
  (`docs/providers/MIGRATION-MATRIX.md`). All sixteen bespoke providers are classified:
  USGS earthquakes can be carried by a definition today; NHC storms, NWS alerts, NASA
  FIRMS, AISStream and the seed airports get part of the way and the matrix names exactly
  what each is missing; adsb.lol, CelesTrak, the public cameras and the local-device kit
  stay code. Nothing the app does changes: every built-in provider stays registered, on or
  off by default as before.
  Three defects in the connector layer turned up on the way: a key in the URL path
  (`credential.as: "path"`) never reached the request, because the REST connector
  percent-encoded the `{TOKEN}` placeholder first; external ids containing `:` (URNs,
  composite ids) were refused by every mapping (both fixed below); and the
  `headingDegrees` transform returns 92.39999999999998 for 92.4 (the refactor pass).
- A USGS earthquakes definition (`connectors/enabled/pending-review/usgs-earthquakes-feed.json`)
  that matches the built-in provider's ids, positions (depth as a negative altitude), times
  and field values on its own fixtures. It waits for review — user-configured, off, and not
  shipped — and the matrix carries the licence-registry record and the four steps to ship
  it, rehearsed. It is not yet a replacement: it lacks the provider's feed-window and
  minimum-magnitude settings and the `aliases` list, is more lenient with malformed rows,
  and could not keep earthquake history indefinitely as the provider does (a reviewed
  definition now can, below).
- Examples of how far a definition gets for NHC storms, AISStream vessels and a fixed-point
  adsb.lol query (`connectors/examples/migrated/`), and a test that compares every
  definition with the built-in normalizer on the same fixtures, field by field
  (`connectors/examples/migrated/migration.test.ts`).

- **Local files as sources** (phase `files`): the `local-file` connector reads a GeoJSON, CSV, GPX, KML or TopoJSON file from a folder the operator grants in the source's Folder setting, looks at its modification time on every poll (30 s by default, never more often than 5 s) and reads and maps it again only when it changed. Records without a time of their own are dated by the file (`file-time`), so an unchanged file yields the same observations on every poll.
- **GPX, KML and TopoJSON readers with no dependency**: a GPX track is one object at its last point with the whole track as its geometry, a route a line, a waypoint a point; KML Placemarks in any Folder with Point, LineString, Polygon (with holes), MultiGeometry, `gx:Track` and `ExtendedData`; TopoJSON arcs decoded, shared and reversed. The XML is read by a tolerant tag scanner that never expands an entity. A NetworkLink is never followed and an address is never geocoded.
- **`gdal-import`**: a shapefile, GeoPackage, File Geodatabase, FlatGeobuf, MapInfo, DXF, SpatiaLite or KMZ is converted to WGS 84 GeoJSON by the operator's own `ogr2ogr` — found on PATH and its version logged, never bundled, installed or downloaded — whenever any file of the dataset changes. Formats that can point elsewhere (VRT, GML) are refused.
- A file source's path stays inside its folder twice over: the connector refuses absolute, drive, UNC, device, `..` and Windows-aliased paths, and the host compares real paths so a link or junction out of the folder is refused.
- `docs/connectors/files.md`, six example definitions with sidecars (`connectors/examples/files/`, under `pnpm connector:test --all`), invented fixtures, and `files.test.ts` (the shared suite on every example; path escapes, mtime polling, size caps, encodings, the readers); the host's side — real links and junctions, UNC paths, a FIFO, and `ogr2ogr` run as a real child process by a stand-in — is tested in the runtime.
- **The contracts a file source needed** (ADR-003 and ADR-013 amendments): a definition keeps its `file` block; the granted folder is resolved by real path (a link or junction out of it is refused, only a regular file is read, the size is checked before a byte is read) and a source that declares its folder setting reads that folder and nothing else; `ogr2ogr` is offered to such sources through the host, with a fixed argument list, no shell, a minimal environment and self-contained input formats only; the shared connector suite runs a file definition in file mode, each fixture served as the file.

- **ArcGIS layers as sources** (`arcgis-feature`, phase `arcgis`). One definition reads one
  FeatureServer or MapServer layer — the way most US and Canadian cities, counties, states,
  utilities and agencies publish live data. Name the layer and, if you like, a `where`
  clause and the fields you want; the connector reads the layer's description first (page
  size, formats, field types, whether it can page), asks for GeoJSON or, from servers older
  than 10.4 or without geoJSON, esriJSON, which it converts — points, lines, polygons with
  their holes and parts in the right order — so the same definition works against either.
  Date fields arrive as ISO 8601 in both. It pages with `resultOffset` while the server says
  `exceededTransferLimit`, stops on a short or repeated page, and says in Source Health when
  a layer holds more than it read. A page too large for the download limit (heavy polygons
  over a wide view) is asked for again in smaller pages, and the smaller size is kept. With `boundsQuery` the viewport becomes the query's
  envelope, split in two across the antimeridian. A token is a credential the app attaches,
  never a value in the file. ArcGIS's "HTTP 200 with an error inside" is reported for what
  it is: an expired or missing token as AUTH, anything else with the server's own message.
  The layer check logs fields the definition names that the layer lacks, dates read with
  the wrong transform, and the layer's copyright text when the attribution leaves it out.
  Three examples (NIFC wildfire incidents and perimeters, NOAA NWS watches and warnings from
  a MapServer layer), disabled, with fixtures and a guide
  ([docs/connectors/arcgis.md](docs/connectors/arcgis.md)).

- OGC connectors (phase `ogc`, [docs/connectors/ogc.md](../../../connectors/ogc.md)): `wfs` (WFS 2.0.0 and 1.1.0 GetFeature as GeoJSON), `ogc-features` (OGC API – Features, Part 1), `wms` (1.3.0 and 1.1.1) and `wmts` (1.0.0, RESTful and KVP), registered in the connector registry.
- A dependency-free, tolerant GetCapabilities reader, linear on hostile input, for WMS, WMTS and WFS: nested WMS layers with the 1.3.0 inheritance rules (CRS and styles added; bounds, attribution, dimensions and scale limits replaced), 1.1.1 `SRS`, `LatLonBoundingBox`, `Extent` and `ScaleHint`, WMTS tile matrix sets, resource URL templates and KVP endpoints, WFS feature types, output formats and paging constraints, and OGC exception documents reported in the service's own words.
- WFS asks for `urn:ogc:def:crs:EPSG::4326` (CRS84 only when a feature type lists it and not EPSG:4326: GeoServer's CRS84 answer for Vienna was 290 m off), decides the axis order from the coordinates against the feature type's WGS 84 bounds (an operator setting can pin it), and records a swap on each observation as `payload.crsNote`. GeoServer and QGIS Server (recorded) and MapServer (probed) answer GeoJSON longitude first whatever the CRS is called, and GeoServer's `crs` member names the latitude-first URN over longitude-first coordinates.
- WFS viewport queries write `BBOX` in the axis order of the CRS they name, or fill `{west}`…`{north}` inside a `cql_filter` (GeoServer refuses both together); paging by `startIndex` runs to `numberMatched`/`totalFeatures` when the answer has one (past pages the server shortened), and otherwise stops at a short page; a repeated page or `maxPages` stops it with a word in Source Health.
- OGC API – Features follows `rel="next"` links on the endpoint's own origin only, adding back definition parameters a link dropped, with `bbox` from the viewport and `datetime`/`limit` passed through.
- WMS and WMTS publish their layer as a `RasterOverlay` through `WorldProvider.overlays()` (the ADR-008 raster overlay contract), reading the capabilities each time the host asks (before the first poll too, and with the settings as they are then), answering with the last good descriptor when a read fails, checking each descriptor against `rasterOverlaySchema` before it leaves, and producing no observations. WMS reads the endpoint URL's own query with `endpoint.query` under the same rules, carries vendor parameters and `TIME` in `parameters`, and reports which view a layer's CRS list rules out (EPSG:3857 for the map; `CRS:84` in 1.3.0 and EPSG:4326 in 1.1.1 for the globe); WMTS publishes the service's own tile template with `{Style}`, `{TileMatrixSet}` and dimensions filled, `tileMatrixLabels` when matrices are not named by zoom, and prefers a matrix set whose name the 2D map recognises. GetMap and GetFeature go to the definition's endpoint, never to URLs the capabilities advertise; the WMTS tile template and an advertised KVP GetTile URL are used only when https on exactly the definition's host, with no user, password, percent-encoding or placeholder in the host.
- Five example definitions with sidecars (Vienna WLAN sites over WFS, Canadian hydrometric stations over OGC API, the North American radar composite and the USGS topographic map over WMS, BKG TopPlusOpen Light over WMTS) and 27 fixtures recorded from GeoServer, MapServer, QGIS Server, ArcGIS Server, pygeoapi and BKG, with their requests and terms.

- **Imagery footprints from STAC** (`stac` connector; guide in `docs/connectors/stac.md`).
  A definition pointed at a STAC API's `/search` shows where and when satellites and
  aircraft imaged the view: one imagery scene per capture at the centre of its bbox, with
  its footprint, capture time, collection, platform, instrument, cloud cover, ground sample
  distance, source page, thumbnail link and asset list — the Scene section of the context
  panel fills in without the definition naming any of it. The search is written once in
  its JSON form; the connector adds the view as `bbox` (a view across 180° is searched as
  two halves), a rolling time window (seven days unless the definition says `P30D` or
  similar, adjustable in Sources as **Time window (days)**, and never longer than scenes
  are kept) and a page size, POSTs it — falling back to GET for servers without POST
  search — and follows `next` links, GET or POST with `body`/`merge`, on the endpoint's own
  origin up to `maxPages`. A definition pointed at a static catalogue (`catalog.json`)
  walks its `child` and `item` links instead, depth first, to a depth cap (**Catalogue
  depth** in Sources) and a document budget, reading each file once and never leaving the
  host. Footprints over 5,000 vertices are thinned so they cannot flood the map, and Source
  Health says when a search stopped with scenes left, a footprint was thinned or dropped,
  or a walk skipped a branch or a host. Imagery itself is not downloaded or drawn, and
  neither, yet, are the footprints: the presentation step draws a geometry only for objects
  without a position.
- Example definitions: Sentinel-2 L2A from Earth Search, and Capella Space's open SAR
  catalogue as a static catalogue — both user-configured and off, with the fail-closed data
  policy.

### Fixed

- Sources stopped, disabled or taken out while they were still starting went on to run and
  poll with nothing able to stop them, and a listener opened during a stop, opened twice at
  once, or closed through its own signal could be left holding its port; the host now
  overtakes a start in flight and refuses or closes such listeners. Two definition reloads
  at once no longer start the same source twice.
- A definition URL (and the Add-source draft) could name `localhost.`, a `.local.` host with
  a trailing dot, a `.internal`/`.lan`/`.home.arpa` name or a single-label host; they are
  refused as not public.

- A definition that pages at a cadence over two minutes could not finish a poll: its request
  budget was an average over the interval, and a poll sends every page within seconds
  against a 60-second limiter (page 6 of 10 refused at a 5-minute cadence). The budget now
  covers one poll's burst twice over, a paged definition carries its own poll budget
  (`pollBudgetMs`; the request timeout had been the whole poll's), and `pnpm connector:test`
  checks both.
- An enabled overlay source on a slow or unreachable service held up the application's
  start by up to its request timeout, and a first capabilities read that failed left no
  overlay until the source was restarted: overlays are now asked for after start without
  waiting, and again after every successful poll.
- A WMTS whose matrix labels are zero-padded (`00`…`18`) was asked for `5/…` where the
  service names `05`: such a set is now reported as undrawable instead of guessed at. A
  provider that knows a matrix set is Web Mercator from the capabilities can say so
  (`webMercator`), whatever the set is named. On the globe, a WMS layer's zoom limits
  appeared one level late (Cesium's geographic tiling starts a level lower than Web
  Mercator's); they are shifted down one level there.
- A WMS or WMTS definition can say where its pictures are (`"extent": "west,south,east,north"`
  in the query, clipped to what the service declares). Services declare the whole world and
  answer opaque tiles outside their coverage — the USGS topographic map painted white over
  every other continent; its example now draws over the contiguous United States only.
- An imagery scene showed as a point only: its footprint is now drawn under the centre mark
  from the regional zooms and whenever the scene is selected.
- The HTTP client's response cache had no eviction, so a source whose URL changes each poll
  (a rolling time window, a query that follows the view) grew it for the life of the
  process; it keeps 256 entries, oldest first.
- A `rest-json` definition with a key in the URL path (`credential.as: "path"`) threw on
  every request: `new URL()` percent-encoded the `{TOKEN}` placeholder and the HTTP client
  looked for the literal one. The placeholder is now kept literal in the path (and only
  there). `param` names a query parameter or header; a path credential always goes where
  `{TOKEN}` is.
- A mapping refused any external id with a `:` in it — every NWS alert (a URN), a NASA
  FIRMS detection, any composite id. Ids are any non-blank string up to 256 characters;
  identity resolution encodes what the object-id grammar cannot carry.
- `connectors/` was in no test root and no type-check include, so a test placed there by
  ownership ran under neither `pnpm test` nor `pnpm typecheck`.
- A reviewed definition may set `"maxRetentionSeconds": null` for no retention cap, as a
  manifest does by leaving the field out; until now every definition was capped (seven
  days unless it named a number), so a definition replacing the USGS provider would have
  pruned earthquake history. An unreviewed file still may not lift the cap.

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
