# USGS fixtures

Synthetic **contract fixtures** that follow the USGS GeoJSON summary-feed schema
(https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). USGS data is U.S.
public domain, but these files were generated in-repo (not recorded from the live
feed) so that tests are deterministic. Record real payloads with
`pnpm provider:record usgs` when network access is available; recorded files go
in `recorded/`.

| File | Purpose |
| --- | --- |
| normal.geojson | 8 events across magnitudes/depths, one automatic, one quarry blast, one tsunami flag, one antimeridian |
| empty.geojson | valid, zero features |
| malformed-rows.geojson | invalid coordinates, non-numeric magnitude, missing geometry, duplicate id |
| malformed-shape.json | valid JSON, not a FeatureCollection |
| malformed-notjson.txt | HTML error page |
| stale.geojson | same events, 3 days old |
| fdsn-query.geojson | FDSN event-query response (historical backfill) |

Reference time for all fixtures: 2026-09-21T08:00:00Z.
