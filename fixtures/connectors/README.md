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

<!-- phase:ogc -->

<!-- phase:arcgis -->

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

<!-- phase:mqtt -->

<!-- phase:home-assistant -->

<!-- phase:traccar -->

<!-- phase:ingest -->

<!-- phase:telemetry -->

<!-- phase:provider-migration -->
