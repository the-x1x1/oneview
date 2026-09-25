# Known limitations — 0.1.8

Each line is a limitation a user or operator can run into. Classification follows the
directive's blocker taxonomy: `SIGNING_REQUIRED`, `AUTH_REQUIRED`, `HARDWARE_REQUIRED`,
`REMOTE_ACCESS_REQUIRED`, `LICENSE_REVIEW_REQUIRED`.

- On the verification machine (RTX 5070, Windows 11) the OpenStreetMap raster basemap
  draws with its area colours faded — land and sea near white, roads and labels faint —
  on the globe and on the 2D map. The tiles arrive intact (the cached files are
  byte-identical to a direct download, which looks normal), and Esri World Imagery is
  unaffected; the cause is not found yet.
- Only pre-releases are published, so an update check on the stable channel reports that
  no stable release exists; turn on "Include pre-release builds" to be told about new ones.
- SIGNING_REQUIRED — builds are unsigned: Windows SmartScreen warns on first run, and the
  updater only checks and notifies; installation is manual until a code-signing
  certificate is configured (ADR-012).
- AUTH_REQUIRED — NASA FIRMS needs a free MAP_KEY; without it the fire provider reports
  AUTH_REQUIRED and stays idle.
- AUTH_REQUIRED — AISStream needs an API key; the maritime provider is off by default and
  its commercial terms are still under review.
- LICENSE_REVIEW_REQUIRED — 18 providers are marked conditional and 9 manual-review in
  `config/licenses/providers.json`; they are off by default until legal sign-off
  (docs/legal/COMMERCIAL-DISTRIBUTION-REVIEW.md, blockers LR-01…LR-19).
- Offline 3D terrain is ellipsoid only: no legally clear terrain source is bundled, so a
  3D view offline shows a smooth globe. Offline 2D is a full PMTiles map (ADR-007).
- No basemap is bundled in a worldpack by default — you supply a PMTiles extract
  (docs/OFFLINE-PACKS.md §5). Packs built without one report `localMap: false` honestly.
- Google Photorealistic 3D Tiles are an optional adapter that needs your own key; they
  are never the default and never cached.
- OpenSky is not shipped: its licence is non-commercial (docs/legal/DATA-SOURCE-LICENSES.md).
- NWS zone-based alerts (no polygon of their own) are drawn from the outlines of the
  zones they name, fetched from api.weather.gov and cached for a month. A cold start
  resolves at most 20 new zones per poll, so on the first few polls after installation
  some zone-based alerts are still missing; they appear as the outlines resolve, and the
  count of unresolved zones is in the provider's log rather than being hidden. An alert
  is drawn only when _every_ zone it names is resolved — a partial outline would
  understate where it applies — and an alert built this way is labelled `zone-geometry`
  so its shape is never mistaken for one a forecaster drew.
- RTSP cameras need the optional go2rtc sidecar, which the operator installs separately;
  MJPEG, HLS and JPEG snapshot cameras work without it.
- Most public road cameras publish stills, not video: a new picture every half-minute to ten
  minutes. For those the panel says "Stills only" and fetches each new picture as it is due;
  there is no "Live" to press. Live video plays where the agency publishes it — Taiwan's
  highway and freeway cameras (MJPEG), Caltrans and Iowa DOT (HLS, in the unverified source,
  off by default) — and TfL's JamCams publish a ten-second clip every few minutes, shown as a
  clip, not as live.
- HLS plays with Chromium's own HLS player, which WORLDVIEW switches on at startup
  (`BuiltInHlsPlayer`); whether this build's Chromium honoured that is logged as
  `renderer media` in app.log. Where it cannot, the panel says so and the stills remain. No
  third-party player is bundled. WebRTC streams do not play in the window.
- Worldpacks are integrity-checked and can be signed (Ed25519), but no publisher ships with
  the app: you decide whose packs to trust (docs/OFFLINE-PACKS.md §4a).
- Aircraft come from adsb.lol, which answers only "within 250 nm of a point" or "every
  aircraft of one type". Zoomed out past one circle, the map shows every aircraft within
  250 nm of the view centre plus about fifty common airliner, regional and business-jet types
  worldwide, fetched one type a poll in turn — so the world fills in over a few minutes, and
  light aircraft and helicopters elsewhere appear only when zoomed in (Sources says so).
- Between reports, aircraft and ships are drawn where their last reported speed and track
  carry them, at most a minute (ships two) ahead of the report; a turn shows when the next
  report arrives. In 2D only the markers in view move, and none when more than 1,500 are in
  view (zoomed out that far a step is under a pixel).
- The local weather-station and air-quality sources are built to the devices' documented
  formats and have not yet been run against real hardware.
- deck.gl is not used: the native adapters meet the performance targets, and a second
  renderer would add risk without evidence (ADR-008).
- The satellite propagator uses satellite.js SGP4; positions are propagated from the
  cached element set and are not a substitute for an operational catalogue.
- History defaults to the NDJSON backend when the DuckDB native module is unavailable;
  the fallback and its reason are shown in Diagnostics. `@duckdb/node-api` is pinned to
  `1.4.5-r.1` (the `lts-v1.4` line): every release of that package carries an `-r.N`
  prerelease suffix, so an ordinary semver range such as `>=1.2.0` matches nothing at
  all and fails the install. Moving to the `1.5.x` line means changing the pin, not the
  range.
- Connector definitions (sources as data) load from `%APPDATA%\@worldview\desktop\connectors\`.
  Sources shows them in its Definitions section (reload, switch, reasons a file was
  refused) and Add source drafts one from an https address; editing a definition's JSON is
  still done in your own editor.
- The ArcGIS, OGC, STAC, file, MQTT, Home Assistant, Traccar and ingest examples are not bundled with the app: they are in
  `connectors/examples/` in the source. Copy one into your connectors folder and restart; it
  loads disabled until you switch it on in Sources. A file source reads only the folder you
  name in its settings, and shows nothing until you do.
- Shapefile, GeoPackage and the other GDAL formats need GDAL's `ogr2ogr` on `PATH`; it is
  not bundled, and the conversion has been tested only against a stand-in program.
- The 2D map draws a WMTS layer only when its tile matrix set is Web Mercator; others are
  reported in Sources and drawn on the 3D globe only.
- A WMS/WMTS layer without an `extent` paints its service's blank tiles outside its
  coverage; the shipped examples set one.
- CelesTrak rate-limits by address: after several restarts in a short time it answers 403
  and satellites stay on the last element sets until it lets requests through again.
- The local-network sources (MQTT, Home Assistant, Traccar, HTTP ingest) have been tested
  against scripted servers and fixtures, not yet against a real broker, Home Assistant,
  Traccar server or Node-RED. Home Assistant's `person` and `device_tracker` entities are
  never read (a privacy decision still open for the operator).
- The ingest listener's token is pasted in Credentials; the app does not generate it yet.
- `pnpm basemap:build` makes a PMTiles pack from your own extract, but the 2D map does not
  draw an installed pack's basemap yet, and packing needs the `osm-protomaps-planetiler`
  licence record, which is not in the registry until you confirm its terms (use
  `--pmtiles-only` meanwhile). A Martin server can be read by the tool, not chosen as the
  app's basemap.
