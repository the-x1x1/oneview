# NWS alerts fixtures

Synthetic **contract fixtures** in the api.weather.gov `/alerts/active` GeoJSON
schema (https://www.weather.gov/documentation/services-web-api — `wx:Alert`
features with CAP-derived properties, feature `id` = alert URL, `properties.id` =
URN, timestamps with local offsets). NWS data is US public domain, but these
alerts were written in-repo (not recorded) so tests are deterministic. Record real
payloads with `pnpm provider:record weather` when network access exists; recorded
files go in `recorded/`.

| File | Purpose |
| --- | --- |
| normal.geojson | 9 alerts: 7 with polygons (Extreme/Severe/Moderate/Minor, one `Update`, one marine, one Red Flag with onset after sent), 1 zone-only advisory (geometry null, affectedZones), 1 with neither geometry nor zones |
| empty.geojson | valid FeatureCollection, zero features |
| stale.geojson | 4 long-running alerts sent 3 days earlier and still in effect (→ STALE under the weather-alert policy) |
| malformed-rows.geojson | latitude 95, LineString geometry, expired alert, missing `sent`, invalid id, a non-feature, a valid alert and its duplicate |
| malformed-allbad.geojson | the invalid rows only (atomic admission → MALFORMED) |
| malformed-shape.json | api.weather.gov problem+json error document |
| malformed-notjson.txt | HTML 403 page (missing User-Agent) |

Reference time for all fixtures: 2026-09-21T08:00:00Z. Every alert in
`normal.geojson` is still in effect at that time (earliest `ends` 08:15Z).
