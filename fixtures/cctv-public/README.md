# public-cameras fixtures

Synthetic **contract fixtures** for the two catalog packs of `providers/cctv-public`
(provider id `public-cameras`). Both real feeds are CC BY 4.0, but these files were
written in-repo so tests are deterministic and never touch the network. Station and
camera names, ids and coordinates are plausible but invented. Record real payloads with
`pnpm provider:record cctv-public` when network access is available; recorded files go
in `recorded/`.

| File | Feed shape | Purpose |
| --- | --- | --- |
| fintraffic-stations.geojson | `GET https://tie.digitraffic.fi/api/weathercam/v1/stations` (GeoJSON FeatureCollection; `properties.presets[]`) | 3 GATHERING stations carrying 5 `inCollection` presets (= 5 cameras), plus one `inCollection: false` preset and one `REMOVED_TEMPORARILY` station that must be skipped; one preset has a numeric `direction` (95) |
| nsw-traffic-cam.json | `GET https://data.livetraffic.com/cameras/traffic-cam.json` (GeoJSON; `properties.{region,title,view,direction,href}`) | 4 valid cameras (directions `N`, `N-E`, `S-W`, none) plus one row whose `href` is off the pinned TfNSW host and must be rejected |
| empty.geojson | either feed | valid, zero features |
| malformed-rows.geojson | either feed | rows with invalid ids/coordinates/geometry, non-object rows |
| malformed-shape.json | either feed | valid JSON, not a FeatureCollection |
| malformed-notjson.txt | either feed | HTML error page |

No frames are included: frames are never fixtures, never retained. Reference time for
all fixtures: 2026-09-21T08:00:00Z.
