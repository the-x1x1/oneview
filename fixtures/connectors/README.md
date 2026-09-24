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
- `mqtt/` — invented in each format's published shape, none a recording from a broker: each file is a run of MQTT messages (`{ topic, payload, retained? }`). `rtl_433-events.json` (a Fine Offset WH24 station with Unix time, an Acurite 5-in-1 whose readings are split over two message types with zoned ISO times, a LaCrosse sensor with rtl_433's zone-less local time, an Acurite tower sensor, a Honeywell door contact, and a message on the `states` topic that is not subscribed to), `rtl_433-door-contact.json` (a device of class `other` only), `owntracks-locations.json` (a retained location, a live one, a last-will and a transition on a deeper topic), `meshtastic-packets.json` (a node's nodeinfo, position and telemetry, a second node's position and a text packet that must never be read) and `gps-trackers.json` (two trackers and a status message on another topic).

<!-- phase:home-assistant -->
- `home-assistant/` — invented in the published shapes of Home Assistant's REST and WebSocket APIs (developers.home-assistant.io), not recordings; entity ids, names, values, times, context ids and the Honolulu coordinates are made up. `states.json`: a `/api/states` answer with two zones, a person and a phone tracker (present to prove they are never read), two weather entities (one in °F/inHg/mph, one in °C/hPa/km/h), environmental, energy, unavailable and phone-battery sensors, a door, a light and the sun. `states-empty.json`: no states. `socket-session.json`: what the server sends in one session — `auth_required`, `auth_ok`, the `subscribe_events` result, `state_changed` events (a sensor, the tracker and the person, a weather entity with no `old_state`, a zone removed, a light) and a `pong`. `socket-auth-invalid.json`: the handshake refusing a token.

<!-- phase:traccar -->
- `traccar/` — invented in Traccar's published shapes (the `Device`, `Position` and `Event` models of the Traccar API and its `/api/socket` messages), not recordings; ids, names, positions and times made up, phone numbers from the 555-01xx fiction range. `devices.json` (one device in the category `person`, which the connector leaves out), `positions.json` / `positions-empty.json` (`/api/positions`; speed in knots, one fix not valid), and socket messages `socket-devices.json`, `socket-positions.json` (one position of the `person` device, one of a device the list does not name) and `socket-events.json` (a geofence entry and an SOS alarm). `suite-combined.json` is not a Traccar answer at all: each entry is a device and its position merged into one object, because the shared suite serves one body to every request and that body must answer both `/api/devices` and `/api/positions`.

<!-- phase:ingest -->
- `ingest/` — invented pushes in the `oneview.ingest.v1` envelope, none a recording (there is no source to record: these are what a pusher sends). `weather-stations-envelope.json`: three stations, one without an altitude; `weather-stations-empty.json`: no records; `weather-stations-wrong-source.json`: an envelope for another source; `weather-stations-unmappable.json`: records without an id or a position; `weather-stations-oversized.json`: a valid push over a 2 KiB `maxBodyBytes` (the tests lower the cap; the default is 1 MiB); `soil-sensors-array.json`: a bare array, two records without a time and one without a position. A wrong token is the good envelope sent with another token (in `ingest.test.ts`). `node-red-flow.json`: the Node-RED flow the guide describes (inject → function → http request → debug), not run against a real Node-RED.

<!-- phase:telemetry -->
- `telemetry/` — invented in the published shapes, none a recording: `local-sensors-history.json` (six hours of a local weather station with a one-hour gap and a wind spike, a neighbour 100 m away, and an air-quality sensor whose AQI crosses 100, in the weatherlink-local and purpleair-local payload keys; read through a real history store in `packages/telemetry`), `nws-kphx-latest.geojson` and `nws-kphx-observations.geojson` (api.weather.gov station observations for KPHX, one and three features, a null temperature in the oldest), `nws-empty.geojson`, and `greenhouse-latest.csv` / `greenhouse-log.csv` (a logger's latest-readings file and an append-only log of the same sensors).

<!-- phase:provider-migration --> `provider-migration` adds no fixtures here: its definitions (`connectors/enabled/pending-review/`, `connectors/examples/migrated/`) read the bespoke providers' own fixtures in `fixtures/usgs/`, `fixtures/nhc/`, `fixtures/aisstream/frames/` and `fixtures/adsb-lol/`, so both are compared on the same bytes (docs/providers/MIGRATION-MATRIX.md).
