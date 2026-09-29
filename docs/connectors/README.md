# Connector documentation

- [OVERVIEW.md](OVERVIEW.md) — what a connector and a definition are; the definition fields; policy; where files go.
- [MAPPING.md](MAPPING.md) — paths, fields, transforms, conditions; what happens to a record.
- [REST-JSON.md](REST-JSON.md) — the `rest-json` connector: endpoint, response, pagination, viewport, credentials.
- [GEOJSON-CSV.md](GEOJSON-CSV.md) — the `geojson` and `csv` connectors.
- [WEBSOCKET.md](WEBSOCKET.md) — the `websocket-json` connector.
- [TESTING.md](TESTING.md) — the sidecar, the shared suite, `connector:test`, `connector:add`.
- [../architecture/CONNECTOR-ARCHITECTURE.md](../architecture/CONNECTOR-ARCHITECTURE.md) — how the packages fit together.
- [../architecture/CONNECTOR-ECONOMICS.md](../architecture/CONNECTOR-ECONOMICS.md) — why definitions instead of providers, and what it costs.
- [../architecture/TERRIAJS-HARVEST.md](../architecture/TERRIAJS-HARVEST.md), [../architecture/OPENMCT-HARVEST.md](../architecture/OPENMCT-HARVEST.md) — what is taken from those projects, and what is not.

## Connectors

Every connector the registry ships (`packages/connector-runtime/src/registry.ts`). Code the
connectors share (response and message caps, reconnect backoff, credentials by reference,
the rejected-records log line and health message) is in
[`shared/`](../../packages/connector-runtime/src/shared/).

| Connector             | For                                                                                                                        | Guide                                  | Code                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| `rest-json`           | Poll an HTTPS endpoint answering JSON (or CSV, or text); page through it                                                   | [REST-JSON.md](REST-JSON.md)           | [rest-json.ts](../../packages/connector-runtime/src/connectors/rest-json.ts)           |
| `geojson`             | Poll a GeoJSON FeatureCollection; each feature an object at its geometry                                                   | [GEOJSON-CSV.md](GEOJSON-CSV.md)       | [geojson.ts](../../packages/connector-runtime/src/connectors/geojson.ts)               |
| `csv`                 | Poll a CSV file; each row an object, columns by header                                                                     | [GEOJSON-CSV.md](GEOJSON-CSV.md)       | [csv.ts](../../packages/connector-runtime/src/connectors/csv.ts)                       |
| `websocket-json`      | A WebSocket sending JSON messages                                                                                          | [WEBSOCKET.md](WEBSOCKET.md)           | [websocket-json.ts](../../packages/connector-runtime/src/connectors/websocket-json.ts) |
| `wfs`, `ogc-features` | WFS and OGC API – Features as objects: WGS 84 and axis order, paging                                                       | [ogc.md](ogc.md)                       | [ogc/](../../packages/connector-runtime/src/connectors/ogc/)                           |
| `wms`, `wmts`         | WMS and WMTS as raster overlays, time "latest"                                                                             | [ogc.md](ogc.md)                       | [ogc/](../../packages/connector-runtime/src/connectors/ogc/)                           |
| `arcgis-feature`      | One ArcGIS FeatureServer or MapServer layer, GeoJSON or esriJSON, paged by `exceededTransferLimit`, optionally by viewport | [arcgis.md](arcgis.md)                 | [arcgis/](../../packages/connector-runtime/src/connectors/arcgis/)                     |
| `stac`                | STAC API item search and static catalogues; imagery footprints as objects                                                  | [stac.md](stac.md)                     | [stac/](../../packages/connector-runtime/src/connectors/stac/)                         |
| `local-file`          | GeoJSON, CSV, GPX, KML, TopoJSON in a folder the operator granted                                                          | [files.md](files.md)                   | [files/](../../packages/connector-runtime/src/connectors/files/)                       |
| `gdal-import`         | Anything else GDAL reads, through the operator's own `ogr2ogr`                                                             | [files.md](files.md)                   | [files/](../../packages/connector-runtime/src/connectors/files/)                       |
| `mqtt`                | Topics on a broker on this computer or one named host; the `rtl_433`, `owntracks` and `meshtastic` presets                 | [mqtt.md](mqtt.md)                     | [mqtt/](../../packages/connector-runtime/src/connectors/mqtt/)                         |
| `home-assistant`      | Your own Home Assistant, read-only: `/api/states`, then `state_changed` over its WebSocket API                             | [home-assistant.md](home-assistant.md) | [home-assistant/](../../packages/connector-runtime/src/connectors/home-assistant/)     |
| `traccar`             | A Traccar server's devices by REST and, on a public server, live over its socket                                           | [traccar.md](traccar.md)               | [traccar/](../../packages/connector-runtime/src/connectors/traccar/)                   |
| `http-ingest`         | Records pushed by Node-RED, a script or a gateway to a token-protected listener on 127.0.0.1                               | [ingest.md](ingest.md)                 | [ingest/](../../packages/connector-runtime/src/connectors/ingest/)                     |

The `telemetry` block of a definition (which payload keys are readings, their units and
limits) is not a connector; it is described in [telemetry.md](telemetry.md).

## Shipped definitions

The definitions in [`connectors/enabled/`](../../connectors/enabled/) ship with the app
(reviewed, with a licence record each); what they are, their licences and how they draw is
in [hazards.md](hazards.md). Definitions waiting for review to replace a bespoke provider
are in `connectors/enabled/pending-review/` and do not ship.

| Definition                                                                                        | Connector        | Source                                                               | On by default |
| ------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------- | ------------- |
| [gdacs-droughts.json](../../connectors/enabled/gdacs-droughts.json)                               | `geojson`        | GDACS drought alerts (global)                                        | no            |
| [gdacs-earthquakes.json](../../connectors/enabled/gdacs-earthquakes.json)                         | `geojson`        | GDACS earthquake alerts (global)                                     | no            |
| [gdacs-floods.json](../../connectors/enabled/gdacs-floods.json)                                   | `geojson`        | GDACS flood alerts (global)                                          | no            |
| [gdacs-tropical-cyclones.json](../../connectors/enabled/gdacs-tropical-cyclones.json)             | `geojson`        | GDACS tropical cyclone alerts (global)                               | no            |
| [gdacs-volcanoes.json](../../connectors/enabled/gdacs-volcanoes.json)                             | `geojson`        | GDACS volcanic alerts (global)                                       | no            |
| [gdacs-wildfires.json](../../connectors/enabled/gdacs-wildfires.json)                             | `geojson`        | GDACS forest fire alerts (global)                                    | no            |
| [gibs-goes-east-infrared.json](../../connectors/enabled/gibs-goes-east-infrared.json)             | `wmts`           | Satellite infrared, Americas and Atlantic (GOES-East, NASA GIBS)     | yes           |
| [gibs-goes-west-infrared.json](../../connectors/enabled/gibs-goes-west-infrared.json)             | `wmts`           | Satellite infrared, eastern Pacific (GOES-West, NASA GIBS)           | yes           |
| [gibs-himawari-infrared.json](../../connectors/enabled/gibs-himawari-infrared.json)               | `wmts`           | Satellite infrared, western Pacific and Asia (Himawari-9, NASA GIBS) | yes           |
| [gibs-imerg-precipitation.json](../../connectors/enabled/gibs-imerg-precipitation.json)           | `wmts`           | Precipitation rate, worldwide (NASA GPM IMERG, 30-minute)            | yes           |
| [gibs-viirs-noaa20-true-colour.json](../../connectors/enabled/gibs-viirs-noaa20-true-colour.json) | `wmts`           | True colour, worldwide (VIIRS on NOAA-20, NASA GIBS, daily)          | no            |
| [gibs-viirs-snpp-true-colour.json](../../connectors/enabled/gibs-viirs-snpp-true-colour.json)     | `wmts`           | True colour, worldwide (VIIRS on Suomi NPP, NASA GIBS, daily)        | no            |
| [nhc-forecast-cones.json](../../connectors/enabled/nhc-forecast-cones.json)                       | `arcgis-feature` | NHC forecast cones (active tropical cyclones)                        | yes           |
| [nhc-forecast-tracks.json](../../connectors/enabled/nhc-forecast-tracks.json)                     | `arcgis-feature` | NHC forecast tracks (active tropical cyclones)                       | yes           |
| [nifc-wildfire-perimeters.json](../../connectors/enabled/nifc-wildfire-perimeters.json)           | `arcgis-feature` | Wildfire perimeters, US (NIFC WFIGS, current)                        | yes           |
| [nowcoast-goes-infrared.json](../../connectors/enabled/nowcoast-goes-infrared.json)               | `wms`            | Satellite infrared, North America (NOAA nowCOAST GOES)               | no            |
| [nowcoast-radar.json](../../connectors/enabled/nowcoast-radar.json)                               | `wms`            | Weather radar, US (NOAA nowCOAST MRMS)                               | yes           |
| [nws-storm-reports.json](../../connectors/enabled/nws-storm-reports.json)                         | `arcgis-feature` | Storm reports, US (NWS local storm reports: tornado, hail, wind)     | yes           |
| [spc-day1-outlook.json](../../connectors/enabled/spc-day1-outlook.json)                           | `arcgis-feature` | Severe weather outlook today, US (SPC day 1 categorical)             | yes           |

A phase adds its connector's row at the end of the connectors table (this file is a shared
file in `docs/roadmap/phases/ownership.json`); a shipped definition gets its row from the
integrator in the commit that ships it.
