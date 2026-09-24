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

<!-- phase:arcgis -->

<!-- phase:stac -->

<!-- phase:files -->

<!-- phase:mqtt -->

<!-- phase:home-assistant -->

<!-- phase:traccar -->

<!-- phase:ingest -->

<!-- phase:telemetry -->

<!-- phase:provider-migration -->
