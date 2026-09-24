# OGC connectors: `wfs`, `ogc-features`, `wms`, `wmts`

The services national mapping agencies, cities and research institutes publish, as definitions. Two of the
connectors produce observations through the GeoJSON path; two publish **raster overlays** (`RasterOverlay`,
ADR-008) that both maps draw between the basemap and the world's objects (see
[The overlay contract](#the-overlay-contract-as-used)).

| Connector      | Service                                    | Produces                           | Example (`connectors/examples/ogc/`)                             |
| -------------- | ------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------- |
| `wfs`          | WFS 2.0.0 and 1.1.0, GetFeature as GeoJSON | observations                       | `vienna-wlan-wfs.json` (GeoServer)                               |
| `ogc-features` | OGC API – Features, Part 1                 | observations                       | `eccc-hydrometric-stations-ogcapi.json`                          |
| `wms`          | WMS 1.3.0 and 1.1.1                        | a raster overlay (no observations) | `eccc-radar-wms.json` (MapServer), `usgs-topo-wms.json` (ArcGIS) |
| `wmts`         | WMTS 1.0.0, RESTful or KVP                 | a raster overlay (no observations) | `bkg-topplus-wmts.json`                                          |

The code is `packages/connector-runtime/src/connectors/ogc/`; the fixtures, all recorded from real
services, are described in `fixtures/connectors/ogc/README.md`.

## What all four share

- **`endpoint.url` is the service**, and `endpoint.query` carries the OGC request parameters. Parameter
  names are case-insensitive, as OGC KVP says: `typeNames`, `TYPENAMES` and `typenames` are the same key.
  Each connector sets some parameters itself (`SERVICE`, `REQUEST`, and per connector `BBOX`, `startIndex`,
  `WIDTH`…); a definition naming one of those is refused with the key named. Anything else in the query is
  passed through as a literal string — vendor parameters included (`format_options`, GeoMet's `layer`
  filter on GetCapabilities). Nothing is templated except the viewport placeholders in a WFS `cql_filter`.
- **Capabilities are read through the provider host** like any other request: the definition's host only,
  its size cap (`endpoint.maxBytes`, 8 MiB by default — a whole national GeoServer can be larger; use the
  service's workspace URL or its own filter), its timeout, its credential. The parser is a small tolerant
  tag scanner in the package, not an XML library: comments, CDATA, a DOCTYPE with an internal subset,
  CRLF line endings, sloppy close tags and OGC exception documents are all handled; entities other than the
  five XML ones and numeric references are left as written; nothing a document names is ever fetched.
- **Requests stay on the definition's host.** GetMap and GetFeature go to the definition's own endpoint,
  never to the URL a capabilities document advertises: recorded services advertise plain `http://`
  (Vienna), `:443` suffixes (ArcGIS) and backend hosts (GeoServer's `next` link to `stp.wien.gv.at`). WMTS
  has to use what the service advertises — its tile template, or its KVP GetTile URL for a RESTful
  endpoint — and does so only when it is https, on exactly the definition's host, with no user or
  password and no `{placeholder}` or percent-encoding in the host part.
- **The request budget covers a poll.** `maxRequestsPerMinute` is at least twice the requests one poll can
  make (capabilities plus every page), so the host's limiter never refuses a poll half way.
- Definitions are `user-configured`, off, and open no data policy, like every example.

## `wfs`

```json
"connector": "wfs",
"endpoint": {
  "url": "https://data.wien.gv.at/daten/geo",
  "query": { "version": "2.0.0", "typeNames": "ogdwien:WLANWIENATOGD" },
  "intervalSeconds": 86400
},
"mapping": { "externalId": "id", "position": { "geometry": "geometry" }, "labels": { "name": "properties.NAME" } }
```

| Query key                                                     | Meaning                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typeNames` (`typeName` 1.1.0)                                | The one feature type. Required.                                                                                                                                                                         |
| `version`                                                     | `2.0.0` (default) or `1.1.0`.                                                                                                                                                                           |
| `srsName`                                                     | Pins the CRS asked for; must be WGS 84 (a CRS84 or EPSG:4326 spelling). Normally left out (below).                                                                                                      |
| `outputFormat`                                                | Pins the GeoJSON format name. Normally left out: the first of `application/json`, `application/geo+json`, `application/vnd.geo+json`, `json`, `geojson` the capabilities list, else `application/json`. |
| `count` (`maxFeatures` 1.1.0)                                 | Page size. Or `pagination: { "strategy": "offset-limit", "offsetParam": "startIndex", "limitParam": "count", "limit": 1000 }`.                                                                          |
| `cql_filter`, `filter`, `sortBy`, `propertyName`, vendor keys | Passed through literally. `sortBy` makes paging stable on services that need it.                                                                                                                        |

Records are the FeatureCollection's `features`; `externalId` defaults to the feature `id` and the position
to its `geometry` (the `geojson` connector's defaults).

**The CRS asked for.** `urn:ogc:def:crs:EPSG::4326`, also when the feature type lists only a national grid,
because the servers recorded reproject on request (Vienna lists only EPSG:31256 and answers WGS 84 when
asked). CRS84 (`urn:ogc:def:crs:OGC:1.3:CRS84`) only when the feature type lists it and not EPSG:4326. Not
CRS84 first, although it would settle the axis order: asked for the same feature both ways, Vienna's
GeoServer put it 290 m apart, and the EPSG:4326 answer is the one at its street address — the CRS84 path
there leaves out the datum shift from the national grid (`geoserver-wien-wlan-page1.json` against
`geoserver-wien-wlan-crs84.json`). A service that answers in another CRS anyway, or with coordinates that
are not degrees, is refused as MALFORMED with the CRS named; the connector does not reproject.

**Axis order is decided from the data.** By the book, `urn:ogc:def:crs:EPSG::4326` is latitude first and a
WFS says which order it used by naming the CRS. The services say otherwise: GeoServer (recorded with the URN on WFS 2.0.0 and `EPSG:4326` on 1.1.0, probed with the other two combinations), QGIS Server (recorded with the URN, probed with `EPSG:4326`) and MapServer's
demo service (probed, not recorded) all wrote their GeoJSON longitude first, and GeoServer's `crs` member
named the latitude-first URN over longitude-first coordinates. Swapping on the name would have
put every Vienna feature in the Indian Ocean. So, per poll, from the first page with coordinates:

1. the operator's `axisOrder` setting (`lon-lat` or `lat-lon`), if the definition declares it and it is set;
2. CRS84 asked for: longitude first;
3. the feature type's WGS 84 bounding box from the capabilities (longitude first by definition): if at
   least 80 % of up to 200 sampled coordinates fall inside it (with a margin) one way and fewer the other
   way, that way;
4. a second value beyond ±90 can only be a longitude: then the values are latitude first;
5. otherwise GeoJSON order, longitude first.

When the connector swaps, every observation of that poll carries `payload.crsNote` saying so and why; when
it does not, there is no note.

**Viewport.** With `boundsQuery: true` the connector writes `BBOX` itself, in the axis order of the CRS it
names: `south,west,north,east,urn:ogc:def:crs:EPSG::4326` or `west,south,east,north,urn:ogc:def:crs:OGC:1.3:CRS84`
(GeoServer honours both; recorded). WFS does not allow `BBOX` beside a `FILTER`, and GeoServer refuses it
beside a `CQL_FILTER`, so with a `cql_filter` the viewport goes inside it —
`"BBOX(geom,{west},{south},{east},{north},'CRS:84') AND …"` — and no `BBOX` is sent. A `cql_filter` without
the placeholders and `boundsQuery` together is a validation error; so is `FILTER` with `boundsQuery`.

**Paging** is by `startIndex`, whichever the version (on 1.1.0 it is a vendor extension). When the answer
carries a total (`numberMatched`, or GeoServer's `totalFeatures`) the total decides: the walk goes on until
`startIndex` reaches it, even past a page shorter than the size asked for — servers cap page sizes on their
own side. Without a total, a page shorter than the size asked for is the last; with no size asked either,
a page as long as the service's `CountDefault` means there may be more, and anything shorter is the end
(QGIS Server sends no counts and lists no default: one request). An empty page ends the walk (said in
Source Health when it comes short of a known total); so does a page that brings only features already read —
a service that ignores `startIndex` answers the first page again — and Source Health says so. `maxPages` (default 10) bounds it all, and stopping there with features left is
said too. GeoServer's own `next` link is ignored. The same repeat check stops an OGC API walk.

**Capabilities** are read before the first GetFeature and every six hours. If they cannot be read for a
reason GetFeature would not share — too large, 4xx/5xx, not WFS — the connector goes on with the defaults
(EPSG:4326 URN, `application/json`, no bounds for the axis check), says so in Source Health, and tries again
after thirty minutes. A timeout, network, auth or rate-limit failure stops the poll. A feature type the
capabilities do not list is MALFORMED, naming what they do list.

## `ogc-features`

```json
"connector": "ogc-features",
"endpoint": {
  "url": "https://api.weather.gc.ca/collections/hydrometric-stations/items",
  "query": { "f": "json", "limit": 500 },
  "intervalSeconds": 3600
},
"pagination": { "strategy": "next-link", "nextLinkPath": "links", "maxPages": 4 },
"boundsQuery": true
```

- `endpoint.url` must be a collection's items resource (`…/collections/{collectionId}/items`).
- `limit`, `datetime` (ISO 8601 instant or interval, `..` for an open end), `f`, property filters and Part 3
  `filter`/`filter-lang` pass through. `crs` and `bbox-crs` other than CRS84 are refused: Part 1 is CRS84,
  and there is no axis question.
- With `boundsQuery` the connector adds `bbox=west,south,east,north` (five decimals, CRS84).
- Paging follows the `rel="next"` link (the GeoJSON one when several are listed), only on the endpoint's
  own origin and never with credentials in it, adding back any definition parameter the link dropped
  without replacing what it carries (pygeoapi's next links leave out `f=json`). It stops at no next link, an
  empty page or `maxPages` (default 10); a next link that left the origin, or a stop at `maxPages` with more
  pages waiting, is said in Source Health. `pagination` may be absent, `none`, or `next-link` with
  `nextLinkPath: "links"`.

## `wms`

```json
"connector": "wms",
"objectType": "place",
"endpoint": {
  "url": "https://geo.weather.gc.ca/geomet",
  "query": { "version": "1.3.0", "layers": "RADAR_1KM_RRAI", "styles": "Radar-Rain_14colors", "format": "image/png", "transparent": true, "layer": "RADAR_1KM_RRAI" },
  "intervalSeconds": 600
},
"mapping": { "externalId": "id" },
"settings": [{ "key": "time", "label": "Radar time", "kind": "string" }]
```

- `layers` is required (a comma list draws them as one image); `styles`, if given, has one entry per layer
  and each must be one the layer offers; `format` is `image/png`, `image/jpeg` or `image/webp` — what the
  renderers draw — and must be offered (default: the first of those GetMap lists); `transparent` defaults to
  true; `version` to 1.3.0, and a service that answers another version is taken at its word.
- The endpoint URL's own query string is read together with `endpoint.query` (which wins on a key in both),
  so a GetCapabilities URL pasted as the endpoint is held to the same rules: `service`, `request`, `crs`,
  `srs`, `bbox`, `width` and `height` are the renderers' and refused wherever they appear, the error saying
  where. Everything else is a vendor parameter: it goes with the GetCapabilities request and into the
  overlay's `parameters`, which the renderers add to every GetMap (GeoMet's `layer` filter above; a
  MapServer `map`). Names must be letters, digits, `_`, `:` and `-`, at most 16 of them.
- The renderers choose the CRS: the 2D map asks for EPSG:3857; the globe tiles geographically and asks
  for `CRS:84` in WMS 1.3.0 and EPSG:4326 in 1.1.1, longitude first either way. CRS lists are inherited
  down the layer tree. A layer that offers neither Web Mercator nor WGS 84 in any spelling is refused; one
  missing what a view asks for is published, and Source Health says which view and what it will ask for.
  GeoMet's radar layer lists EPSG:4326 but not `CRS:84`, so its Source Health says the globe draws it
  only if the server answers `CRS:84` anyway (not probed).
- Time: the operator's `time` setting (ISO 8601 or `current`), else `time` in the query, goes out as the
  `TIME` parameter; otherwise the server's default applies. The layer's time dimension (default and extent,
  as written) is reported in Source Health; the connector never iterates it.
- Zoom limits come from `Min`/`MaxScaleDenominator` (1.3.0) or `ScaleHint` (1.1.1, a pixel diagonal in
  metres): Vienna's layers at "1:400,000 and larger" become `minZoom: 10`. An `opacity` setting between 0
  and 1 is passed on.
- `objectType` and `mapping` are required by the definition schema and not used: the convention is
  `"place"` and `{ "externalId": "id" }`. A mapping with more in it, `boundsQuery`, `pagination` or
  `response` draws a warning, and so does `endpoint.headers` (they go with the capabilities request, not
  with the tiles); a credential is refused, because the renderers fetch the tiles and attach none.

The overlay the example publishes, and the tile template the 2D map derives from it (`overlayTileTemplate`):

```json
{
  "kind": "wms",
  "id": "eccc-radar-rain-wms:radar_1km_rrai",
  "providerId": "eccc-radar-rain-wms",
  "name": "Radar precipitation rate for rain [mm/h]",
  "attribution": "Data Source: Environment and Climate Change Canada",
  "url": "https://geo.weather.gc.ca/geomet",
  "layers": "RADAR_1KM_RRAI",
  "styles": "Radar-Rain_14colors",
  "format": "image/png",
  "version": "1.3.0",
  "transparent": true,
  "tileSize": 256,
  "parameters": { "layer": "RADAR_1KM_RRAI" },
  "bounds": { "west": -170.32, "south": 16.93, "east": -50, "north": 67.19 }
}
```

```
https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=RADAR_1KM_RRAI&STYLES=Radar-Rain_14colors&FORMAT=image%2Fpng&TRANSPARENT=TRUE&CRS=EPSG%3A3857&WIDTH=256&HEIGHT=256&layer=RADAR_1KM_RRAI&BBOX={bbox-epsg-3857}
```

## `wmts`

```json
"connector": "wmts",
"objectType": "place",
"endpoint": {
  "url": "https://sgx.geodatenzentrum.de/wmts_topplus_open/1.0.0/WMTSCapabilities.xml",
  "query": { "layer": "web_light", "tileMatrixSet": "WEBMERCATOR", "format": "image/png" }
},
"mapping": { "externalId": "id" }
```

- `endpoint.url` ending in `.xml` is a RESTful capabilities document, fetched as it is; anything else is a
  KVP endpoint and gets `SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0` plus its vendor parameters.
- `layer` is required; `style` defaults to the layer's default style, `format` to `image/png` when offered,
  `tileMatrixSet` to a linked set that is Web Mercator — preferring one whose name says so (below).
- **Web Mercator only**: the globe tiles WMTS in Web Mercator and the 2D map can draw nothing else. A set
  qualifies when its CRS is EPSG:3857 (or an alias, in any URN spelling), its tiles are 256 × 256, every
  matrix starts at the world's top-left corner and every scale denominator is a zoom level of the standard
  scale set; each matrix is matched to its zoom (so ArcGIS's `default028mm`, whose level-0 matrix is two
  tiles wide, qualifies). The 2D map, however, tells Web Mercator sets by their **name**
  (`isWebMercatorMatrixSet`: `3857`, `GoogleMapsCompatible`, `WebMercator`…), so among qualifying sets one
  with such a name comes first — ArcGIS's `GoogleMapsCompatible` rather than its `default028mm` — and a
  set without one is published with a Source Health note that the map cannot draw it.
- Matrix identifiers must be letters, digits and `._:-` (not all dots), since the renderers put them into
  URLs as they are. When they are not the zoom numbers (BKG names them `00`…`18`) they go into
  `tileMatrixLabels`, index = zoom. Levels the set does not have hold their place in the first real name's
  pattern (`EPSG:3857:1` gives `EPSG:3857:0`), since the 2D map derives one template from the whole list:
  below the first level the renderers ask for nothing (`minZoom`), and a level missing in between is said
  in Source Health.
- The overlay's `url` is the layer's `ResourceURL` for tiles in the chosen format, with `{Style}`,
  `{TileMatrixSet}` and any dimension (`{Time}`: the `time` setting, the query, or the dimension's default)
  filled in and `{TileMatrix}`, `{TileRow}`, `{TileCol}` left for the renderers; without one, the KVP
  endpoint (the definition's own for a KVP service, the advertised GetTile URL for a RESTful one), to which
  the renderers add the GetTile parameters. Either must pass the rule under "What all four share", or the
  definition is refused saying why and naming the host.

The overlay for the example:

```json
{
  "kind": "wmts",
  "id": "bkg-topplus-light-wmts:web_light",
  "name": "TopPlusOpen Light",
  "url": "https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web_light/default/WEBMERCATOR/{TileMatrix}/{TileRow}/{TileCol}.png",
  "layer": "web_light",
  "style": "default",
  "format": "image/png",
  "tileMatrixSet": "WEBMERCATOR",
  "tileMatrixLabels": ["00", "01", "…", "18"],
  "minZoom": 0,
  "maxZoom": 18
}
```

The globe uses those labels as they are. The 2D map derives one template from them (`matrixTemplate`), which
reads `05` as the zoom number 5 and asks for `/5/`; BKG's server answers `/5/` and `/05/` alike (probed: the
same 16,971-byte tile at zoom 5, row 10, column 17), so this example draws, but a service that is strict
about its identifiers would not. Source Health says so; the brief reports it.

## The overlay contract, as used

`wms` and `wmts` publish through the raster overlay contract (ADR-008 amendment, landed at `69466be`):
`RasterOverlay` in the world model, and `WorldProvider.overlays()`. The provider host asks `overlays()` once,
right after `start()` and before the first poll, validates each descriptor (`rasterOverlaySchema`, the
provider id forced, the host among the manifest's `allowedHosts`) and hands it to both renderers. So:

- `overlays()` reads the capabilities itself each time it is asked, with the settings as they are then, so a
  restart publishes a changed `time` or `opacity`. A read already under way (a poll's) is joined rather than
  repeated; when the read fails, the answer is the last good descriptor, and with none it fails. The poll
  keeps reading them at the definition's interval, for Source Health.
- The shared read is not tied to one caller's abort signal: an aborted poll stops waiting (CANCELLED) and
  the read finishes for whoever joined it, within the definition's request timeout.
- Each provider checks its descriptor against `rasterOverlaySchema` before it leaves; one that would not
  pass is MALFORMED with the field named. A layer title past the contract's 200 characters is cut.
- Health is LIVE with a message naming what was published and anything a view cannot draw; a failed poll
  makes it DEGRADED with the error, while the last good descriptor stays published.
- Nothing asks again after start: a changed setting, or a first capabilities read that failed at start,
  reaches the renderers only when the provider is restarted. And the host waits for that first read:
  application start waits on every enabled overlay definition's capabilities, up to its request timeout
  (20 s by default) on a slow or unreachable service. Both are reported in the brief's amendment requests.
- On the globe, `render-cesium` hands `minZoom`/`maxZoom` to Cesium's WMS imagery, which reads them as
  geographic tiling levels — one less than the Web Mercator zoom at the same scale — so a WMS layer with
  zoom limits appears there one level late (reported too; the limits this connector writes are Web
  Mercator zooms, which the 2D map expects).

## Testing

```
pnpm connector:test --all                                   # the five examples run the shared suite from their sidecars
node tools/dev/run-tests.mjs --filter connectors/ogc        # ogc.test.ts: parsers per server, axis order, bbox, paging, origins, overlays
pnpm connector:test connectors/examples/ogc/<file> --live   # one real sample, from a machine with network access
```

For an overlay, the shared suite's "Successful parse" means a poll read the capabilities and produced no
observations; `ogc.test.ts` checks the descriptors themselves, the way the host does. The empty fixture is a
second valid capabilities document (for BKG, the same one), since an overlay has no records to be empty of.

## Not done

WFS 1.0.0 and GML output; reprojection of any kind; WMTS tile matrix sets other than Web Mercator, and
512-pixel tiles; GetFeatureInfo; WCS, CSW and SOS; credentials on tile requests (the renderers fetch tiles
without one); republishing an overlay after start (the contract has no way for a provider to ask); XML
`FILTER` beside a viewport.
