# Known limitations — 0.1.11

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
- Queensland cameras use QLDTraffic's shared public key, which is refused for about half of
  each day (seen 12:00–00:00 UTC on 2026-09-28 and 29). The cameras stay on the map from
  their last good list for up to a day, but a start during that window shows none until it
  lifts. A personal key (Settings → Providers → Public cameras → Credentials) avoids it.
  `AUTH_REQUIRED`
- Live camera previews: HLS cameras play in a preview only where Chromium plays HLS itself;
  elsewhere they preview as stills. The demo build's previews show its synthetic still, not
  a camera.
- The 3D models close in stand in for a class, not a type: every narrow-body jet is the 747
  model drawn at an A320's length, every fast jet the private-jet model at fighter size, and
  every ship the same cargo ship, at its AIS length where it broadcasts one (120 m where not). A
  ship's bow direction was read from the model's geometry and has not been checked on screen.
  With 3D terrain on, a ship or an aircraft on the ground is placed on the terrain, which
  Cesium re-samples every frame for those models.
- The imagery comparison splits the view side by side on the globe only; the 2D map fades
  between the two sources as the divider moves, because MapLibre cannot draw a layer on part
  of the screen. A frame being handed over (a new day or radar frame arriving) keeps its old
  opacity in 2D for the four seconds of the handover.
- "Yesterday against today" in true colour needs one of the two GIBS layers pinned to
  yesterday's date by hand (its Frame time setting); there is no relative "previous day".
- LICENSE_REVIEW_REQUIRED — online place search uses the public Nominatim and Photon
  services, which ask that the traffic of all an application's users together stay within
  their limits (Nominatim: one request a second). Each installation keeps to that on its
  own; a large number of installations would need a geocoder of its own. Settings → Search
  switches it off or to the other service.
- Only pre-releases are published, so an update check on the stable channel reports that
  no stable release exists; turn on "Include pre-release builds" to be told about new ones.
- SIGNING_REQUIRED — builds are unsigned: Windows SmartScreen warns on first run, and the
  updater only checks and notifies; installation is manual until a code-signing
  certificate is configured (ADR-012).
- AUTH_REQUIRED — NASA FIRMS needs a free MAP_KEY; without it the fire provider reports
  AUTH_REQUIRED and stays idle.
- AUTH_REQUIRED — AISStream needs an API key; the maritime provider is off by default and
  its commercial terms are still under review.
- Ships without a key come from Digitraffic Marine AIS (Fintraffic) and cover the Baltic
  around Finland only — the Gulf of Finland, the Archipelago and Bothnian Seas and the
  northern Baltic Proper. Elsewhere ships need AISStream (your key) or your own AIS receiver.
  Norway's open AIS stream is a raw TCP connection to a public address, which providers are
  not allowed to open, and the other open sources found are historical or need membership
  (docs/legal/DATA-SOURCE-LICENSES.md, "Ship and aircraft sources considered on 2026-09-28").
- Aircraft have one keyless source, adsb.lol. airplanes.live and adsb.fi were considered as a
  second source for areas adsb.lol covers thinly; both limit their free data to non-commercial
  use, so neither is shipped.
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
- The legend's radar scale is the standard NWS reflectivity palette, which nowCOAST's style
  follows; it has not been compared pixel by pixel with the live tiles.
- Satellite infrared covers the globe between 60° N and 60° S in five slices (GOES-West,
  GOES-East, Meteosat 0°, Meteosat-9 IODC, Himawari-9), thinning out from 50°, none towards
  the poles. Over Europe, Africa, the Middle East and the Indian Ocean (37.5° W to 93° E) the Meteosat frames come every
  15 minutes rather than 10, from EUMETSAT's EUMETView. Its tile cache renders tiles on demand,
  so a new frame can take several seconds longer to fill in than the NASA layers; the previous
  frame stays underneath until it has (up to 30 seconds). Their clouds-only threshold (`fadeBelow` 80,130) comes from a brightness scale inferred from sampled
  values, not a published one; if their clear sky looks different from the GIBS slices beside them,
  tune it (docs/connectors/hazards.md). The credit names the year 2026, as EUMETSAT's attribution
  form asks for the year of distribution: revise it with each year's release.
- Satellite frames are 20 to 50 minutes old when they appear (GIBS's processing), and
  IMERG precipitation about four hours. A new GIBS frame is drawn only once one of its tiles
  answers (GIBS lists frames a minute or two before they are whole), so it can appear a poll
  later than GIBS lists it. IMERG (about 10 km a pixel) is hidden from zoom 9 in, where it
  would be large squares over a town. All GIBS and EUMETSAT definitions were checked live on
  the reference laptop on 2026-09-29.
- Lightning (nowCOAST strike density): its legend scale is God's Eye View's key for the
  style, not compared with the live tiles. It covers
  25° S to 80° N from 110° E across the Pacific and the Americas to 0°: none over Europe,
  Africa, the Middle East, most of Asia or the Indian Ocean. It is a 15-minute density on an
  8 km grid, not individual strikes.
- NHC's forecast positions, past track and wind field are keyed by the service's row number,
  which changes with each advisory: every advisory replaces them, and a selected forecast
  position is deselected when it does. The wind field is the current one only; NHC's forecast
  wind radii and wind-speed probabilities (layers 15 and 29–32) are not read.
- A storm glyph's label is drawn when the renderer's label placement has room for it; where
  labels collide the lower-priority one is dropped, so two storms close together can show one
  label until zoomed in. Labels from different layers (a storm and its forecast points)
  compete for the same space.
- There is no radar outside the US: no openly licensed global radar mosaic was found
  (RainViewer's free API is for personal and educational use only).
- Tropical cyclones outside the NHC's basins (the western Pacific, the Indian Ocean, the
  southern hemisphere) come only from GDACS, which is off by default (no reuse licence); JTWC
  publishes its warnings as bulletins and KMZ files, which no connector reads. Their clouds
  show on the satellite layers regardless.
- Warnings (tornado, severe thunderstorm, flash flood, hurricane) come from the NWS alerts
  source, on by default. Without a contact of your own the User-Agent api.weather.gov asks
  for names WorldView's project page; if the service ever refuses it, set a contact in
  Sources.
- A storm report's id is the NWS service's row number, which it may renumber when it
  republishes every 30 minutes: a report can be replaced by an identical one under a new id,
  and a selected report may be deselected.
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
  them; the 511 catalogues need a key and were not fetched at all. Illinois' list is read
  and drawn on the reference laptop (about 2,100 cameras on 2026-09-29); its ~900 Lake County
  PASSAGE views are left out, since that agency's own image host publishes no reuse terms. A
  changed shape shows as `camera pack failed` or `rejected camera rows` in app.log, and the
  other packs carry on.
- HLS plays with Chromium's own HLS player, which WORLDVIEW switches on at startup
  (`BuiltInHlsPlayer`); whether this build's Chromium honoured that is logged as
  `renderer media` in app.log. Where it cannot, the panel says so and the stills remain. No
  third-party player is bundled. WebRTC streams do not play in the window.
- Worldpacks are integrity-checked and can be signed (Ed25519), but no publisher ships with
  the app: you decide whose packs to trust (docs/OFFLINE-PACKS.md §4a).
- Aircraft come from adsb.lol, which answers only "within 250 nm of a point" or "every
  aircraft of one type", and at a rate it does not publish. WorldView finds that rate as it
  goes (four to six requests a minute; less after a 429), so a region is filled in circle by
  circle: over the contiguous United States or Europe the busiest airspace is on the map
  within two or three minutes, the whole view within about ten, and an aircraft's position
  can be up to several minutes old between refreshes of its circle (it is moved along its
  last track meanwhile). When adsb.lol is busy and allows less, a pass takes longer; Sources
  shows the current rate and pass time. A 429 now and then is still expected — the rate is
  only found by meeting it — but far less often than one a few minutes.
- Zoomed out past about 80 circles (wider than a continent), the map shows every aircraft
  within 250 nm of the view centre plus about fifty common airliner, regional and business-jet
  types worldwide, fetched one type a poll in turn — so the world fills in over a few minutes,
  and light aircraft and helicopters elsewhere appear only when zoomed in (Sources says so).
  Military aircraft are the exception: adsb.lol's worldwide military list is fetched once a
  minute at that zoom. "Military" is adsb.lol's database flag; an aircraft it does not
  list is drawn as civil.
- adsb.lol has no API key, token or feeder tier today (its documentation says one will be
  required "in the future"), so there is nothing to enter to raise the rate; WorldView
  identifies itself with its own User-Agent. If adsb.lol starts requiring a key, aircraft
  positions stop until support for it is added.
- A selected aircraft's earlier track is filled in from the trace file adsb.lol's own map
  uses (`adsb.lol/data/traces/…`), which is not part of its documented API: if adsb.lol
  moves or blocks it, the track is WORLDVIEW's own recording only, with nothing said beyond
  the missing "Filled in" line. Only ICAO addresses are looked up (not TIS-B `~` addresses).
- A selected flight's route is the planned route adsb.lol's route database holds for its
  callsign — a schedule, not today's flight plan. A charter, a diversion, a positioning
  flight or a callsign reused for another route shows the wrong airports; the panel says so
  when the aircraft is far off the route's great circle, but not always. Routes come from
  adsb.lol's static route files (its route API went empty on 2026-09-29); only the callsign
  is sent to look one up. Callsigns that are not an airline designator plus a flight number (private
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
