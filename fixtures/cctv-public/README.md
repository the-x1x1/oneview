# public-cameras fixtures

Synthetic **contract fixtures** for the nine catalog packs of `providers/cctv-public`
(provider id `public-cameras`) and, under `unverified/`, the four packs of the
`public-cameras-unverified` provider. Every real feed is openly licensed, but these files were
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
| hongkong-cameras.xml | `GET https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml` (flat XML `<image-list><image>…`) | 3 cameras (entities `&amp;`/`&apos;` decoded; one whose `<url>` is on another host — the frame is rebuilt from the key anyway), an invalid key, a position in London and a repeated key (rejected) |
| hongkong-empty.xml | the same | valid, zero images |
| iceland-webcams.json | `GET https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1` (array; `Slod`, `Breidd`, `Lengd`) | 3 images (one http link upgraded, numbers as strings and as numbers), one outside `/vgdata/vefmyndavelar/`, one off Iceland and a repeated image (rejected) |
| qldtraffic-webcams.geojson | `GET https://api.qldtraffic.qld.gov.au/v1/webcams?apikey=…` (GeoJSON; `direction` as compass words, `image_sourced_from`) | 3 cameras (`NorthEast`, `East` with an http image, none), one third-party image (skipped), one off-host image and one off Queensland (rejected) |
| unverified/caltrans-d4.json, caltrans-d7.json | `GET https://cwwp2.dot.ca.gov/data/d<n>/cctv/cctvStatusD<nn>.json` | 3 in-service cameras across two districts (directions, elevation in feet, one without), one out of service (skipped), one off-host and one off California (rejected) |
| unverified/caltrans-empty-district.json | any other district | valid, zero cameras |
| unverified/austin-cameras.json | `GET https://data.austintexas.gov/resource/b4k4-adkb.json` | 2 cameras, one `TURNED_OFF` (skipped), one off-host (rejected) |
| unverified/nyc-cameras.json | `GET https://webcams.nyctmc.org/api/cameras` | 2 online cameras (coordinates as numbers and as strings), one offline (skipped) |
| unverified/iowa-cameras.json | ArcGIS `Traffic_Cameras_View/FeatureServer/0/query` (`features[].attributes`) | 2 cameras, one off Iowa (rejected) |
| empty-array.json | the four array feeds | valid, zero rows |
| empty.geojson | either GeoJSON feed | valid, zero features |
| malformed-rows.geojson | either feed | rows with invalid ids/coordinates/geometry, non-object rows |
| malformed-shape.json | either feed | valid JSON, not a FeatureCollection |
| malformed-notjson.txt | either feed | HTML error page |

No frames are included: frames are never fixtures, never retained. Reference time for
all fixtures: 2026-09-21T08:00:00Z.

The shapes of the four array feeds (TfL, Ontario 511, DriveBC, Calgary) and of the
unverified packs follow gods-eye-view's loaders and tests for the same endpoints (MIT);
Hong Kong, Iceland and Queensland follow the publishers' own documentation and samples; they have not been
checked against a live response from this repository, because the build machines cannot
reach those hosts. The first run on a connected machine is that check: a changed shape
shows as `camera pack failed` (MALFORMED) or `rejected camera rows` in `app.log`.

- `taiwan-thb-cctvs.xml` — MOTC traffic data standard `CCTVList`, shaped like the Highway
  Bureau's list (`thbapp.thb.gov.tw/opendata/cctv/info/cctvs.xml`, checked 2026-09-23): the
  first record is copied from it; the others test an `http:` stream on the authority's host
  (upgraded), a stream off its hosts, a position outside Taiwan and a repeated id.
- `taiwan-freeway-cctv.xml` — the same standard as the Freeway Bureau publishes it
  (`tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml`): stream-only records, one of them `http:`.
  Invented values in the published shape; the live list could not be fetched from the build
  environment.

Added 2026-09-27 — all **invented** values in the published shapes (names say "Invented" or
"Sample"; ids are in the 9000s). None is a recording: the Illinois snapshot host refuses
automated readers, the 511 catalogues need a key, and the rest were read only to confirm
their shape and terms.

| File | Feed shape | Purpose |
| --- | --- | --- |
| dgt-camaras.json | `GET https://www.dgt.es/.content/.assets/json/camaras.json` (`{ camaras: [ { id, latitud, longitud, carretera, pk, sentido, provincia, imagen, fecha } ] }`, numbers as strings) | 3 cameras (one http still upgraded, one numeric id with no road and an unknown province), one off-host still, one position in London, a repeated id and an invalid id (rejected) |
| illinois-page-0.json, illinois-page-1.json, illinois-page-empty.json | ArcGIS `TrafficCamerasTM_Public/FeatureServer/0/query`, paged by `resultOffset` (`features[].attributes.{ImgPath,CameraLocation,CameraDirection,SnapShot}`) | one device seen facing S and W (two cameras), one facing NONE with an http snapshot, one more on the second page; an off-host snapshot, a row with no Gateway viewer link, one in Texas and a repeat across pages (rejected); page 0 says `exceededTransferLimit` |
| unverified/wsdot-cameras.json | ArcGIS `TravelInfoCamerasWeather/FeatureServer/0/query` (`OBJECTID`, `CameraTitle`, `ImageURL`, `CompassDirection`) | 3 WSDOT cameras (N, none, E; one http), a partner camera on TripCheck (off-host) and one outside Washington (rejected) |
| unverified/lithuania-cameras.json | `GET https://eismoinfo.lt/eismoinfo-backend/camera-info-table` (`x`/`y` in LKS94) | 2 cameras (one whose `image` points elsewhere — the still is rebuilt from the id), a string id, a missing coordinate, a position far outside Lithuania and a repeat (rejected) |
| unverified/udot-cameras.json, unverified/ny511-cameras.json | `GET https://<site>/api/v2/get/cameras?key=…` (the Ontario 511 shape) | Utah: a Northbound camera, one whose first view is down and whose next view is http on the bare host, one with only disabled views and one with an off-host view (skipped), one in Florida (rejected); New York: one camera |
