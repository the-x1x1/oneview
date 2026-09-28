# Known limitations — 0.1.9

Each line is a limitation a user or operator can run into. Classification follows the
directive's blocker taxonomy: `SIGNING_REQUIRED`, `AUTH_REQUIRED`, `HARDWARE_REQUIRED`,
`REMOTE_ACCESS_REQUIRED`, `LICENSE_REVIEW_REQUIRED`.

- With the CRT visual style on the globe the picture is bent slightly (1.5 % at the
  corners), but clicks are still placed on the unbent picture, so near the edges of the view
  a click can land a few pixels from the marker drawn under it.
- In 2D the visual styles are drawn by the browser over the map canvas, so a screenshot
  exported from the 2D map shows the map without the style; on the globe the style is part
  of the picture and is exported with it. The 2D CRT style has no barrel distortion.
- Dragging the 2D map ends a follow (a pan and a follow would fight over the centre); on the
  globe dragging turns the camera round the object instead.
- On the verification machine the OpenStreetMap basemap looked faded (land and sea near
  white) in 0.1.8. The tiles arrive intact; the likely cause was other maps (TopPlusOpen,
  USGS topo) stacked over it, which 0.1.9 stops. Not yet confirmed on screen.
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
- Forecast cones, forecast tracks, wildfire perimeters and GDACS alerts are marked at a
  point as soon as they arrive, but their outlines are drawn only after you pick a lens
  (events are fetched then, not streamed), and in one colour whatever the alert level. The
  marker sits on the first point of the shape, not its centre (docs/connectors/hazards.md).
- The NOAA nowCOAST radar and GOES definitions were written without reading the live
  service (it refuses automated reading); layer names come from published samples and are
  to be confirmed on a machine with network access. When a new radar frame arrives the
  overlays are redrawn together, so they may blink once every five minutes.
- LICENSE_REVIEW_REQUIRED — GDACS alerts are shipped off: GDACS states no reuse licence,
  only a disclaimer and a request to credit it.
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
- Camera catalogues added on 2026-09-27 (Illinois, Spain, Washington State, Lithuania, and
  the 511 sites of New York State, Utah, Arizona, Georgia and Idaho) were built from their
  published shapes and checked by reading one answer each, not by running WORLDVIEW against
  them; the 511 catalogues need a key and were not fetched at all. Illinois' snapshot host
  refuses automated readers, so whether it serves WORLDVIEW's client is known only once the
  app asks it. A changed shape shows as `camera pack failed` or `rejected camera rows` in
  app.log, and the other packs carry on.
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
  Military aircraft are the exception: adsb.lol's worldwide military list is fetched once a
  minute while zoomed out. "Military" is adsb.lol's database flag; an aircraft it does not
  list is drawn as civil.
- A selected aircraft's earlier track is filled in from the trace file adsb.lol's own map
  uses (`adsb.lol/data/traces/…`), which is not part of its documented API: if adsb.lol
  moves or blocks it, the track is WORLDVIEW's own recording only, with nothing said beyond
  the missing "Filled in" line. Only ICAO addresses are looked up (not TIS-B `~` addresses).
- A selected flight's route is the planned route adsb.lol's route database holds for its
  callsign — a schedule, not today's flight plan. A charter, a diversion, a positioning
  flight or a callsign reused for another route shows the wrong airports; the panel says so
  when adsb.lol's own check or the aircraft's distance from the route disagrees, but not
  always. Callsigns that are not an airline designator plus a flight number (private
  aircraft flying their registration, many military callsigns) are not looked up at all.
- "Flown", "To go" and the arrival estimate are great-circle distances and the current
  ground speed: real routings are longer and aircraft slow down to land, so the estimate is
  usually early, by more on short flights. There is no estimate on the ground or below about
  50 kt.
- Airline and aircraft type names come from Virtual Radar Server's standing data. Where one
  type designator covers civil and military variants the name can be a variant's (B06 reads
  "Bell OH-58 Kiowa"); the designator is always shown beside it.
- Aircraft silhouettes come from the ICAO type designator (short tables of common types)
  or, failing that, the ADS-B emitter category; a type in neither is drawn as the generic
  jet, and an aircraft with neither as the generic jet too.
- A satellite's category comes from CelesTrak's `military` and `gnss` lists, the group it
  was fetched in, or its name; anything else is "Other / not known". CelesTrak's military
  list is its "Miscellaneous Military" group, not every military satellite.
- The selected satellite's predicted path is one orbital period of SGP4 positions over the
  rotating Earth (the ground track at altitude), so it does not close on itself: after one
  period it ends ~23° west of where it began for a low orbit. It is re-fetched when the
  satellite has flown most of it.
- Between reports, aircraft and ships are drawn where their last reported speed and track
  carry them, at most a minute (ships two) ahead of the report; a turn shows when the next
  report arrives. In 2D only the markers in view move, and none when more than 1,500 are in
  view (zoomed out that far a step is under a pixel).
- The local weather-station and air-quality sources are built to the devices' documented
  formats and have not yet been run against real hardware.
- deck.gl is not used: the native adapters meet the performance targets, and a second
  renderer would add risk without evidence (ADR-008).
- A satellite's passes are computed for the middle of the view at the moment they were
  asked for (or when "Passes over the middle of the view now" is pressed), not a saved home
  location, and are only as good as its element set: seconds for a fresh one, minutes for
  one several days old. They say when the satellite is above 10°, not whether it can be seen
  (sunlit against a dark sky). A pass that stays above 10° for only a few seconds can be
  missed.
- The SATCAT record reader was written from CelesTrak's format documentation; the live
  query endpoint could not be read from the build environment, so the first real answers
  are to be checked on a machine with network access. Its code lists (owners, launch sites)
  are a snapshot of September 2026; a newer code shows as the code.
- A ship's destination is shown as the text it broadcasts. No line is drawn to the port: the
  text is free-form ("NL RTM", "ROTTERDAM", "FOR ORDERS"), and without a bundled, openly
  licensed port list whose positions could be checked here it cannot be resolved without
  guessing. The flag is read from the MMSI's first digits; a wrong or borrowed MMSI shows
  the wrong flag.
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
