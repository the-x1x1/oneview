# public-cameras fixtures

Synthetic **contract fixtures** for the six catalog packs of `providers/cctv-public`
(provider id `public-cameras`). Every real feed is openly licensed, but these files were
written in-repo so tests are deterministic and never touch the network. Station and
camera names, ids and coordinates are plausible but invented. Record real payloads with
`pnpm provider:record cctv-public` when network access is available; recorded files go
in `recorded/`.

| File | Feed shape | Purpose |
| --- | --- | --- |
| fintraffic-stations.geojson | `GET https://tie.digitraffic.fi/api/weathercam/v1/stations` (GeoJSON FeatureCollection; `properties.presets[]`) | 3 GATHERING stations carrying 5 `inCollection` presets (= 5 cameras), plus one `inCollection: false` preset and one `REMOVED_TEMPORARILY` station that must be skipped; one preset has a numeric `direction` (95) |
| nsw-traffic-cam.json | `GET https://data.livetraffic.com/cameras/traffic-cam.json` (GeoJSON; `properties.{region,title,view,direction,href}`) | 4 valid cameras (directions `N`, `N-E`, `S-W`, none) plus one row whose `href` is off the pinned TfNSW host and must be rejected |
| tfl-jamcam.json | `GET https://api.tfl.gov.uk/Place/Type/JamCam` (array of `Place`; `additionalProperties[{key,value}]`) | 3 available cameras, one `available: "false"` (skipped) and one whose `imageUrl` is in another bucket on the same S3 host (rejected) |
| ontario-511-cameras.json | `GET https://511on.ca/api/v2/get/cameras?format=json&lang=en` (array; `Views[{Id,Url,Status,Description}]`) | 2 cameras — one `Northbound`, one whose first enabled view is described as down so the next is used — plus a site with only disabled views and one with an off-host view (both skipped) and one outside Ontario (rejected) |
| drivebc-webcams.json | `GET https://www.drivebc.ca/api/webcams/` (array; `location` GeoJSON point, `orientation`, `elevation`, `credit`) | 2 cameras (one a border camera, one partner-supplied with an HTML credit and lower-case `se`), plus one switched off (skipped), a string id and a Los Angeles position (rejected) |
| calgary-cameras.json | `GET https://data.calgary.ca/resource/k7p9-kppz.json` (Socrata rows; `camera_url.url` on http, `point`) | 2 cameras whose http frame URLs are upgraded, one frame on another host and one outside Calgary (rejected) |
| empty-array.json | the four array feeds | valid, zero rows |
| empty.geojson | either GeoJSON feed | valid, zero features |
| malformed-rows.geojson | either feed | rows with invalid ids/coordinates/geometry, non-object rows |
| malformed-shape.json | either feed | valid JSON, not a FeatureCollection |
| malformed-notjson.txt | either feed | HTML error page |

No frames are included: frames are never fixtures, never retained. Reference time for
all fixtures: 2026-09-21T08:00:00Z.

The shapes of the four array feeds (TfL, Ontario 511, DriveBC, Calgary) follow
gods-eye-view's loaders and tests for the same endpoints (MIT); they have not been
checked against a live response from this repository, because the build machines cannot
reach those hosts. The first run on a connected machine is that check: a changed shape
shows as `camera pack failed` (MALFORMED) or `rejected camera rows` in `app.log`.
