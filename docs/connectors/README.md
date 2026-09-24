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

Connector guides added by a phase (see [../roadmap/PARALLEL-PHASES.md](../roadmap/PARALLEL-PHASES.md)) are listed here by the integrator:

- [ogc.md](ogc.md) — the `wfs`, `ogc-features`, `wms` and `wmts` connectors: WGS 84 and axis order, paging, raster overlays. <!-- phase:ogc -->

- [arcgis.md](arcgis.md) — the `arcgis-feature` connector: one ArcGIS FeatureServer or MapServer layer, GeoJSON or esriJSON, paged by `exceededTransferLimit`, optionally by viewport. <!-- phase:arcgis -->

<!-- phase:stac -->

- [stac.md](stac.md) — the `stac` connector: STAC API item search and static catalogues; imagery footprints as objects.

<!-- phase:files -->

- [files.md](files.md) — `local-file` (GeoJSON, CSV, GPX, KML, TopoJSON in a granted folder) and `gdal-import` (the operator's own `ogr2ogr`); the folder grant, formats, polling, limits.

<!-- phase:mqtt -->

<!-- phase:home-assistant -->

- [home-assistant.md](home-assistant.md) — the `home-assistant` connector: your own Home Assistant, read-only — `/api/states`, then `state_changed` over the WebSocket API; the token, the address, what is read and what is never sent.

<!-- phase:traccar -->

<!-- phase:ingest -->

<!-- phase:telemetry -->
