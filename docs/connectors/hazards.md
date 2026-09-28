# Shipped hazard and weather layers

Eleven definitions in `connectors/enabled/` (2026-09-27): sources written as data, reviewed, with a
licence record each in `config/licenses/providers.json`. They run like every other provider — the
host's allow-list, rate limit, cache and Source Health apply — and each can be switched off in
Sources. Tested by their sidecars and `connectors/enabled/shipped.test.ts`; fixtures and their
provenance in `fixtures/connectors/hazards/README.md`.

| Id                                                                                            | What                                                                      | Service                                                                                                                   | Licence                                           | Default                                 | Poll                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------- | ----------------------------- |
| `nowcoast-radar`                                                                              | MRMS base reflectivity, contiguous US, raster overlay                     | `https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms`, layer `conus_base_reflectivity_mosaic`              | U.S. public domain                                | on                                      | 5 min                         |
| `nowcoast-goes-infrared`                                                                      | GOES Band 14 longwave infrared, North America, raster overlay             | `https://nowcoast.noaa.gov/geoserver/observations/satellite/wms`, layer `goes_longwave_imagery`                           | U.S. public domain                                | off (covers the map; licence allows on) | 10 min                        |
| `nhc-forecast-cones`                                                                          | Five-day cone of every active Atlantic / Pacific storm                    | `https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer/7`           | U.S. public domain                                | on                                      | 15 min                        |
| `nhc-forecast-tracks`                                                                         | Forecast centre track of every active storm                               | same MapServer, layer 6                                                                                                   | U.S. public domain                                | on                                      | 15 min                        |
| `nifc-wildfire-perimeters`                                                                    | Current interagency wildfire perimeters in the view (no prescribed burns) | `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0` | U.S. public domain (NIFC disclaimer only)         | on                                      | 15 min                        |
| `gdacs-earthquakes`, `-tropical-cyclones`, `-floods`, `-volcanoes`, `-droughts`, `-wildfires` | Current GDACS events of one type, with alert level and report link        | `https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=EQ` (TC, FL, VO, DR, WF)                            | No reuse licence published; attribution requested | off, fails closed                       | 15 min (EQ), 30 min (TC), 1 h |

Enabled by default follows `connectors/enabled/README.md` and the licence audit: a reviewed
definition (`commercially-reviewed` → record `approved`) may start on; the U.S. Government sources
do, except GOES infrared, which is off only because an opaque picture over a continent should be
the operator's choice. GDACS is `bundled` (record `conditional`) and off: its terms of use are a
disclaimer and state no licence, so its policy stays closed — commercial use unknown, no export,
redistribution, raw retention or offline packs — until the JRC confirms reuse.

## How each is drawn

- **Radar and satellite** are raster overlays (the `wms` connector, `role: overlay`), drawn over
  the basemap and under everything else, on the globe and on the map. `time: "latest"` makes each
  poll pin the newest frame the service lists as the overlay's `TIME`, with the frame in the overlay's
  id (see [ogc.md](ogc.md)), so a new frame replaces the layer on both maps and one picture is never
  half old, half new. Both renderers rebuild their overlay layers when one changes, so radar and
  satellite blink once as a frame arrives. The
  main-process tile cache does not see them: it serves only catalogue basemaps with a `tileCache`
  block (`render-core/map-providers.ts`); the renderers fetch overlay tiles from nowCOAST directly.
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

## Limits

- **Outlines draw as events, and events reach the map only on a lens switch.** Object geometry is
  drawn by presentation only for rules with `drawGeometry` (imagery scenes, when selected), and the
  shell asks for events (`world.events`) only when the operator picks a lens (`store/actions.ts`
  `setLens`); objects stream live, events do not (`store/sync.ts`). So a cone, track or perimeter is
  listed and marked at its point as soon as it arrives, and outlined after the next lens pick. NWS
  alert polygons behave the same today. One line in `render-core/presentation.ts` —
  `drawGeometry: true` on the `weather-alert`/`storm` rule — would draw every outline as part of its
  object, live; that is the renderers' owner's change, not this one's.
- **One colour.** Every weather-alert event is drawn in the theme's alert yellow; a GDACS level
  colour on the map needs a `colorBy` on the rule (render-core). The level is in the feed badge and
  the selection panel.
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
pnpm connector:test connectors/enabled/nhc-forecast-cones.json --live
pnpm connector:test connectors/enabled/nifc-wildfire-perimeters.json --live
pnpm connector:test connectors/enabled/gdacs-floods.json --live
```

Then in the app: radar over the US on both maps, and a new frame within five minutes (Source Health
names the frame time); GOES infrared when switched on; with a storm active, its cone and track after a
lens switch; perimeters in the western US at regional zoom.
