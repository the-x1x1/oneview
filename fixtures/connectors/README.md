# Connector fixtures

Recorded or invented responses in the shape each connector's example definition reads:

- `gbfs-station-information.json` — GBFS 2.3 `station_information` (invented stations in the
  published shape; the last two rows test a missing position and a repeated id).
- `gbfs-empty.json`, `gbfs-page1.json`, `gbfs-page2.json` — an empty list, and a two-page
  answer with a `next` link on the endpoint's own origin.
- `usgs-all_day.csv` — three rows in the USGS CSV feed's columns (one with a bad latitude).
- `vehicles-message.json` — one message of the sample WebSocket vehicle feed.

The USGS GeoJSON fixtures live in `fixtures/usgs/`.

Phase fixtures live in a subdirectory per phase (`ogc/`, `arcgis/`, …), each described on
its own slot line below by the phase that adds it:

<!-- phase:ogc --> `ogc/` — recorded from GeoServer, MapServer, QGIS Server, ArcGIS Server, pygeoapi and BKG (capabilities trimmed to a few layers, LF line endings); requests, terms and what each shows in [ogc/README.md](ogc/README.md).

- `arcgis/` — ArcGIS REST responses for `connectors/examples/arcgis/`, all invented in the published shape (field names and types checked against the live NIFC WFIGS incident and perimeter layers and the NOAA NWS watch/warning MapServer layer on 2026-09-23; values, names and ids made up): layer descriptions (`*-layer.json`, one of a 10.31 server without geoJSON), query answers as GeoJSON and as esriJSON (`legacy-query.json` is the same four incidents as `wfigs-incidents.geojson`; one has no geometry), polygons with a hole and with two parts (`wfigs-perimeters.json`), and three pages for `exceededTransferLimit` paging (`paging-*.geojson`). <!-- phase:arcgis -->

<!-- phase:stac -->

<!-- phase:files -->
- `files/` — invented in each format's published shape, none a recording: `diamond-head-walk.gpx` (GPX 1.1; a track in two segments with one bad point, a route, three waypoints — one out of range), `reef-survey.kml` (KML 2.2 with folders, ExtendedData, a polygon with a hole, a mixed MultiGeometry, a `gx:Track`, a NetworkLink that must not be followed and a broken coordinate), `rain-gauges.csv` (one row with only an address), `community-gardens.geojson` (a feature with no id and no geometry), `districts.topojson` (quantized, two polygons sharing an arc, a null geometry) and `parcels-ogr2ogr.geojson`, which stands in for what `ogr2ogr -f GeoJSON -lco RFC7946=YES` writes for a shapefile.

<!-- phase:mqtt -->

<!-- phase:home-assistant -->

<!-- phase:traccar -->

<!-- phase:ingest -->

<!-- phase:telemetry -->

<!-- phase:provider-migration --> `provider-migration` adds no fixtures here: its definitions (`connectors/enabled/pending-review/`, `connectors/examples/migrated/`) read the bespoke providers' own fixtures in `fixtures/usgs/`, `fixtures/nhc/`, `fixtures/aisstream/frames/` and `fixtures/adsb-lol/`, so both are compared on the same bytes (docs/providers/MIGRATION-MATRIX.md).
