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
- `stac/` — invented in the published STAC 1.0 / STAC API 1.0 shapes, not recordings.
  `search-page1.json`, `search-page2.json`: two pages of Sentinel-2 L2A items over Hawaii
  (field names and layout follow an Earth Search v1 answer seen on 2026-09-23; ids, times,
  bboxes and hrefs are made up), the first ending in a POST `next` link with `body` and
  `merge`; one item has a null `datetime` with `start_datetime`/`end_datetime`, one a
  thumbnail found by role. `search-empty.json`: no items. `search-antimeridian.json`: two
  scenes over Fiji, one with a 4-number bbox across 180° (west > east), one with no bbox and
  a footprint split at 180° into a MultiPolygon. `static/`: a small static catalogue with
  relative links — two hierarchies over the same items, a child on another host, a child
  that does not exist, an http thumbnail — served by URL in `stac.test.ts`.

<!-- phase:files -->
- `files/` — invented in each format's published shape, none a recording: `diamond-head-walk.gpx` (GPX 1.1; a track in two segments with one bad point, a route, three waypoints — one out of range), `reef-survey.kml` (KML 2.2 with folders, ExtendedData, a polygon with a hole, a mixed MultiGeometry, a `gx:Track`, a NetworkLink that must not be followed and a broken coordinate), `rain-gauges.csv` (one row with only an address), `community-gardens.geojson` (a feature with no id and no geometry), `districts.topojson` (quantized, two polygons sharing an arc, a null geometry) and `parcels-ogr2ogr.geojson`, which stands in for what `ogr2ogr -f GeoJSON -lco RFC7946=YES` writes for a shapefile.

<!-- phase:mqtt -->

<!-- phase:home-assistant -->

<!-- phase:traccar -->
- `traccar/` — invented in Traccar's published shapes (the `Device`, `Position` and `Event` models of the Traccar API and its `/api/socket` messages), not recordings; ids, names, positions and times made up, phone numbers from the 555-01xx fiction range. `devices.json` (one device in the category `person`, which the connector leaves out), `positions.json` / `positions-empty.json` (`/api/positions`; speed in knots, one fix not valid), and socket messages `socket-devices.json`, `socket-positions.json` (one position of the `person` device, one of a device the list does not name) and `socket-events.json` (a geofence entry and an SOS alarm).

<!-- phase:ingest -->

<!-- phase:telemetry -->

<!-- phase:provider-migration --> `provider-migration` adds no fixtures here: its definitions (`connectors/enabled/pending-review/`, `connectors/examples/migrated/`) read the bespoke providers' own fixtures in `fixtures/usgs/`, `fixtures/nhc/`, `fixtures/aisstream/frames/` and `fixtures/adsb-lol/`, so both are compared on the same bytes (docs/providers/MIGRATION-MATRIX.md).
