# Shipped hazard and weather layers

Twenty-three definitions in `connectors/enabled/` (eleven on 2026-09-27, six more for worldwide weather, two daily true-colour layers, and three NHC storm layers and lightning on 2026-09-28): sources written as data, reviewed, with a
licence record each in `config/licenses/providers.json`. They run like every other provider — the
host's allow-list, rate limit, cache and Source Health apply — and each can be switched off in
Sources. Tested by their sidecars and `connectors/enabled/shipped.test.ts`; fixtures and their
provenance in `fixtures/connectors/hazards/README.md`.

| Id                                                                                            | What                                                                                                                                                                         | Service                                                                                                                                                                                                                                                         | Licence                                                                                                               | Default                                       | Poll                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------- |
| `nowcoast-radar`                                                                              | MRMS base reflectivity, contiguous US, raster overlay                                                                                                                        | `https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms`, layer `conus_base_reflectivity_mosaic`                                                                                                                                                    | U.S. public domain                                                                                                    | on                                            | 5 min                         |
| `nowcoast-strike-density`                                                                     | Lightning strike density, 15 min, 8 km, 25° S–80° N from 110° E across the Pacific and the Americas to 0°, raster overlay                                                    | `https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/wms`, layer `ldn_lightning_strike_density`, style `lightning_density`                                                                                                                     | NOAA derived product released for public distribution (from Vaisala NLDN/GLD360); credit required                     | on, 90 % opacity                              | 5 min                         |
| `nowcoast-goes-infrared`                                                                      | GOES Band 14 longwave infrared, North America, raster overlay                                                                                                                | `https://nowcoast.noaa.gov/geoserver/observations/satellite/wms`, layer `goes_longwave_imagery`                                                                                                                                                                 | U.S. public domain                                                                                                    | off (covers the map; licence allows on)       | 10 min                        |
| `nhc-forecast-cones`                                                                          | Five-day cone of every active Atlantic / Pacific storm                                                                                                                       | `https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer/7`                                                                                                                                                 | U.S. public domain                                                                                                    | on                                            | 15 min                        |
| `nhc-forecast-tracks`                                                                         | Forecast centre track of every active storm                                                                                                                                  | same MapServer, layer 6                                                                                                                                                                                                                                         | U.S. public domain                                                                                                    | on                                            | 15 min                        |
| `nhc-forecast-points`                                                                         | Forecast position of every active storm at 12 to 120 h, with time, wind, gusts and expected type                                                                             | same MapServer, layer 5 (`tau > 0`)                                                                                                                                                                                                                             | U.S. public domain                                                                                                    | on                                            | 15 min                        |
| `nhc-past-track`                                                                              | The path every active storm has taken, one piece per stretch at one strength (`ss`)                                                                                          | same MapServer, layer 11                                                                                                                                                                                                                                        | U.S. public domain                                                                                                    | on                                            | 15 min                        |
| `nhc-wind-field`                                                                              | The current 34, 50 and 64 kt wind areas of every active storm, with the radius per quadrant                                                                                  | same MapServer, layer 16                                                                                                                                                                                                                                        | U.S. public domain                                                                                                    | on                                            | 15 min                        |
| `nifc-wildfire-perimeters`                                                                    | Current interagency wildfire perimeters in the view (no prescribed burns)                                                                                                    | `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0`                                                                                                                                       | U.S. public domain (NIFC disclaimer only)                                                                             | on                                            | 15 min                        |
| `gdacs-earthquakes`, `-tropical-cyclones`, `-floods`, `-volcanoes`, `-droughts`, `-wildfires` | Current GDACS events of one type, with alert level and report link                                                                                                           | `https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=EQ` (TC, FL, VO, DR, WF)                                                                                                                                                                  | No reuse licence published; attribution requested                                                                     | off, fails closed                             | 15 min (EQ), 30 min (TC), 1 h |
| `gibs-goes-east-infrared`, `gibs-goes-west-infrared`, `gibs-himawari-infrared`                | Geostationary clean longwave infrared (10.3 µm), 10-minute frames, day and night; each drawn in its slice: GOES-West 180°–106° W, GOES-East 106° W–0°, Himawari-9 80° E–180° | NASA GIBS WMTS `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?LAYER=<layer>`, layers `GOES-East_ABI_Band13_Clean_Infrared`, `GOES-West_ABI_Band13_Clean_Infrared`, `Himawari_AHI_Band13_Clean_Infrared`, `GoogleMapsCompatible_Level6` (zoom 0–6) | GOES: U.S. public domain; Himawari: JMA data distributed openly by NOAA, attribution requested; GIBS credit requested | on, 55 % opacity                              | 10 min                        |
| `gibs-imerg-precipitation`                                                                    | Satellite precipitation rate (mm/h), whole globe, half-hourly, IMERG Early (about 4 h behind)                                                                                | same service, layer `IMERG_Precipitation_Rate_30min`                                                                                                                                                                                                            | U.S. public domain (NASA); GIBS credit requested                                                                      | on, 80 % opacity                              | 30 min                        |
| `gibs-viirs-snpp-true-colour`, `gibs-viirs-noaa20-true-colour`                                | The Earth in daylight in true colour (VIIRS corrected reflectance), one picture a day from each satellite's afternoon passes; today's fills in as passes arrive              | same service, layers `VIIRS_SNPP_CorrectedReflectance_TrueColor`, `VIIRS_NOAA20_CorrectedReflectance_TrueColor`, `GoogleMapsCompatible_Level9` (zoom 0–9), JPEG                                                                                                 | U.S. public domain (NASA/NOAA); GIBS credit requested                                                                 | off (for the Compare imagery command), opaque | 1 h                           |
| `nws-storm-reports`                                                                           | Tornado, funnel cloud, waterspout, hail and thunderstorm-wind reports, last 24 h, as points                                                                                  | `https://mapservices.weather.noaa.gov/vector/rest/services/obs/nws_local_storm_reports/MapServer/0`                                                                                                                                                             | U.S. public domain                                                                                                    | on                                            | 15 min (service: 30)          |
| `spc-day1-outlook`                                                                            | SPC day 1 categorical convective outlook: TSTM, MRGL, SLGT, ENH, MDT, HIGH areas                                                                                             | `https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer/1`                                                                                                                                                                  | U.S. public domain                                                                                                    | on                                            | 15 min                        |

Enabled by default follows `connectors/enabled/README.md` and the licence audit: a reviewed
definition (`commercially-reviewed` → record `approved`) may start on; the U.S. Government sources
do, except GOES infrared, which is off only because an opaque picture over a continent should be
the operator's choice. GDACS is `bundled` (record `conditional`) and off: its terms of use are a
disclaimer and state no licence, so its policy stays closed — commercial use unknown, no export,
redistribution, raw retention or offline packs — until the JRC confirms reuse.

## How each is drawn

- **Radar and satellite** are raster overlays (the `wms` and `wmts` connectors, `role: overlay`),
  drawn over the basemap and under everything else, on the globe and on the map, in the order the
  bundled definitions load, by file name (GIBS infrared, then IMERG, then nowCOAST radar on top). `time: "latest"` makes each
  poll pin the newest frame the service lists — a WMS `TIME`, a WMTS tile path — with the frame in
  the overlay's id and `frame` (see [ogc.md](ogc.md)), so one picture is never half old, half new.
  Both renderers keep every overlay that did not change and lay a new frame over the old one,
  which leaves four seconds later (`overlaySeries`, world-model; render-cesium and render-maplibre
  `raster-overlays.ts`): nothing blinks as a frame arrives. GIBS's capabilities have been seen days
  behind its tiles for GOES-East, so for GIBS the connector also reads the layer's time domain
  (DescribeDomains) and takes the newer frame. The daily true-colour layers name dates rather than
  instants (`2026-09-28`); those are frames too, and their capabilities' default was six weeks
  behind the domain on 2026-09-28. They are opaque, so they are off until the operator turns one
  on — usually to compare it with the other, or with itself pinned to an earlier day, through the
  Compare imagery command (a divider across the map; a cross-fade in 2D). The
  main-process tile cache does not see them: it serves only catalogue basemaps with a `tileCache`
  block (`render-core/map-providers.ts`); the renderers fetch overlay tiles from nowCOAST directly.
- **Storm reports and the SPC outlook** are `weather-alert` objects too, so they sit in the
  Weather layer: a report is a point coloured by type (render-core `WEATHER_ALERT_SUFFIXES` on
  `reportType`: tornado red, hail green, wind blue), an outlook area a faint polygon in SPC's
  colour for its category (`spcCategory`). NWS warnings are coloured by kind first (`alertKind`
  from providers/weather: tornado, its PDS and emergency tiers, severe thunderstorm, flash flood,
  extreme wind, hurricane, storm surge, the watches) with bolder edges (`edgePx` in theme.ts),
  and everything else by severity or GDACS level. Reports and outlook areas have no severity and
  stay out of the feed. A legend (apps/desktop map/weather-legend.tsx) keys what is on the map.
- **Cones, tracks, perimeters and GDACS alerts** are `weather-alert` objects, which the Overview's
  Weather and Disasters layers both show. The object's point is its geometry's first coordinate
  (for a track, the storm's current position; for an area, a vertex of its outline). The
  weather-alert event rule turns each into an event carrying the whole geometry, which presentation
  draws as an outline or a line (`render-core/presentation.ts`, events). Cones, tracks and
  perimeters have no severity, so they stay out of the feed: the storm event from `nhc-storms` is the
  news, and a perimeter is a map layer. A GDACS alert's severity is its alert score — green MINOR,
  orange MODERATE, red SEVERE — which the feed and the selection badge colour; its report is the
  alert's **Source page** link.
- Why `weather-alert` for a fire perimeter and a cone: it is the world model's type for an area an
  authority has issued; `fire-detection` objects are clustered as satellite detections by the
  wildfire rule, and a `storm` object raises a storm event of its own. The event path is the only one
  on which an object's outline reaches the map today (see Limits).

- **Storms** (render-core `storm-style.ts`): each NHC storm (`nhc-storms`) and each GDACS
  cyclone when that source is on is the cyclone glyph in its Saffir–Simpson colour (TD, TS,
  Cat 1–5; GDACS winds are the basin centre's, so its category is marked "eq."), sized by
  category and labelled "Nolo · Cat 4 · 125 kt" at every zoom. NHC's forecast positions are
  smaller glyphs labelled with NHC's own time and the forecast wind ("Tue 8 AM HST · Cat 3 ·
  110 kt"); the past track is a line coloured by the strength of each stretch; the wind field
  is three nested faint areas (34, 50, 64 kt). A tornado warning and a tornado report are the
  tornado glyph, and a tornado warning is drawn above everything else on the map and comes
  first in the feed. An event whose storm or alert is already drawn as an object is not drawn
  a second time (presentation.ts), so a forecast track reads "Hurricane Nolo" once.
- **Lightning** is a raster overlay like the radar, loaded after it (by file name) so it draws
  over it, keyed in the legend with the scale God's Eye View uses for the style.
- **Storms quick view** (command palette): the Overview's Weather and Disasters layers only,
  and the camera on the strongest Category 3+ cyclone, else the most urgent tornado warning,
  else the most severe alert (apps/desktop `storms-view.ts`).

## Limits

- **Outlines** are drawn live under their markers (`drawGeometry` on the weather-alert rule), in
  their object's class colour.
- **The point marker is a vertex, not the centre**, until the mapping has a `centroid` position
  (MIGRATION-MATRIX.md, A4).
- **No incident pages for fires.** WFIGS carries no incident URL; GEV matches InciWeb pages by
  name through a separate API, which a definition cannot express. NHC's link is its home page; the
  `nhc-storms` provider links each storm's advisory.
- **Not read from here.** nowCOAST refuses automated reading and the build container has no
  network: its capabilities fixture is invented, and the service URLs and layer names come from
  God's Eye View and Esri's published sample. A live check on Windows is needed (below).

## Live check (Windows)

```
pnpm connector:test connectors/enabled/nowcoast-radar.json --live
pnpm connector:test connectors/enabled/nowcoast-strike-density.json --live
pnpm connector:test connectors/enabled/nhc-forecast-points.json --live
pnpm connector:test connectors/enabled/nhc-past-track.json --live
pnpm connector:test connectors/enabled/nhc-wind-field.json --live
pnpm connector:test connectors/enabled/nhc-forecast-cones.json --live
pnpm connector:test connectors/enabled/nifc-wildfire-perimeters.json --live
pnpm connector:test connectors/enabled/gdacs-floods.json --live
pnpm connector:test connectors/enabled/gibs-goes-east-infrared.json --live
pnpm connector:test connectors/enabled/gibs-himawari-infrared.json --live
pnpm connector:test connectors/enabled/gibs-imerg-precipitation.json --live
pnpm connector:test connectors/enabled/nws-storm-reports.json --live
pnpm connector:test connectors/enabled/spc-day1-outlook.json --live
```

Then in the app: infrared clouds over the Americas, the Pacific and East Asia with no seam
doubling at 106° W or 180°, and precipitation worldwide, on both maps, each advancing within ten
(IMERG: thirty) minutes with no blink (Source Health names the frame, and says when the time
domain gave a newer one than the capabilities); storm report dots and SPC areas over the US on a
day with severe weather; with NWS alerts switched on, a tornado warning's bold red outline; the
legend at the bottom left. Then: radar over the US on both maps, and a new frame within five minutes (Source Health
names the frame time); GOES infrared when switched on; with a storm active, its cone and track after a
lens switch; perimeters in the western US at regional zoom.

Storms (2026-09-28): with a storm active, each one a cyclone glyph in its category colour with
"Name · Cat n · kt" readable at global zoom on both maps, its forecast positions labelled with
time and wind along the track, its past track coloured by strength, and its wind field rings;
the glyphs crisp at 1920×1200 on the 740M (sprite size is the theme's, not measured here);
lightning density over the Americas and the Pacific, above the radar, advancing about every
fifteen minutes, with its legend scale matching the tiles; a tornado warning's tornado glyph and
its place at the top of the feed; and the palette's "Storms quick view" leaving only Weather and
Disasters on and flying to the strongest major hurricane.
