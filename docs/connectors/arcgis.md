# ArcGIS REST connector (`arcgis-feature`)

Most US and Canadian cities, counties, states, utilities and agencies publish their live
data as ArcGIS layers: a `FeatureServer` or `MapServer` layer answering a `query`. The
`arcgis-feature` connector reads one such layer. The definition says which layer and which
features; the connector builds the query the way ArcGIS expects it, pages through the
answer, reads whichever format the server speaks, and maps each feature with the ordinary
[mapping](MAPPING.md). A connector's provider is a provider: the host's allow-list, cache,
rate limit, credential scoping, admission and Source Health apply as for every other source
([ADR-013](../adr/ADR-013-connector-architecture.md)).

```json
{
  "schema": "oneview.connector.v1",
  "id": "nifc-wfigs-incidents",
  "name": "Wildfire incidents (NIFC WFIGS, current)",
  "connector": "arcgis-feature",
  "objectType": "fire-detection",
  "endpoint": {
    "url": "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0",
    "query": {
      "where": "IncidentTypeCategory = 'WF'",
      "outFields": "OBJECTID,GlobalID,IncidentName,ModifiedOnDateTime_dt"
    },
    "intervalSeconds": 300
  },
  "pagination": {
    "strategy": "offset-limit",
    "offsetParam": "resultOffset",
    "limitParam": "resultRecordCount",
    "limit": 2000,
    "maxPages": 5
  },
  "mapping": {
    "externalId": "properties.GlobalID",
    "observedAt": "properties.ModifiedOnDateTime_dt",
    "position": { "geometry": "geometry" },
    "labels": { "name": "properties.IncidentName" }
  },
  "attribution": { "text": "National Interagency Fire Center, Wildland Fire Interagency Geospatial Services (WFIGS)" },
  "review": "user-configured",
  "enabled": false
}
```

The mapping always sees **GeoJSON features**: `properties` holds the layer's attributes,
`geometry` the feature's geometry in longitude/latitude, `id` the object id. That is true
whether the server answered GeoJSON or esriJSON, so one definition works against any
server version.

## `endpoint`

| Key                                             | Meaning                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                                           | One layer: `…/FeatureServer/<n>` or `…/MapServer/<n>`, optionally ending in `/query`. https to a public host; no query string (parameters go in `query`).     |
| `query`                                         | ArcGIS query parameters, passed as given (names compared case-insensitively, as ArcGIS does). See below.                                                      |
| `method`                                        | `GET` (default), or `POST` to send the query as a form — for a long `where` or `outFields`.                                                                   |
| `credential`                                    | A token: `{ "name": "token", "as": "query", "param": "token" }` with a `credentials.token` entry. The host adds it to every request; the file never holds it. |
| `intervalSeconds`, `timeoutSeconds`, `maxBytes` | As for every polling connector (default 60 s, 20 s, 8 MiB per response). Polygon layers can need more than 8 MiB a page.                                      |

### Query parameters

What the connector fills in unless the definition says otherwise:

| Parameter        | Default | Notes                                                                    |
| ---------------- | ------- | ------------------------------------------------------------------------ |
| `where`          | `1=1`   | Any SQL the layer accepts, such as `STATUS = 'Open'`                     |
| `outFields`      | `*`     | A list keeps responses small; include the object id field                |
| `returnGeometry` | `true`  | `false` only when the position comes from attribute fields (`lat`/`lon`) |

Passed through as given: `orderByFields`, `time`, `geometryPrecision`,
`maxAllowableOffset`, `returnZ`, `sqlFormat`, and anything else the layer's `query` takes —
plus, without `boundsQuery`, a fixed `geometry` filter of your own.

What the connector owns, always: `outSR=4326`, `f`, and while paging `resultOffset`,
`resultRecordCount` and (when the layer supports ordering and the definition gave none)
`orderByFields=<object id field>`, which keeps pages stable. A definition that sets
`resultOffset`/`resultRecordCount`, a literal `token`, a statistics or ids-only query
(`returnIdsOnly`, `returnCountOnly`, `returnExtentOnly`, `outStatistics`,
`groupByFieldsForStatistics`, `returnDistinctValues`), `returnM`, `returnTrueCurves`, an
`f` other than `json`/`geojson` or an `outSR` other than 4326 fails validation with the
reason.

## The layer description

Before its first query, and then every six hours (or after the server refuses a query), the
connector reads the layer itself (`…/<n>?f=json`) and takes from it:

- `maxRecordCount` — the page size, never more than the server allows;
- `advancedQueryCapabilities.supportsPagination` / `supportsOrderBy` — whether to page and
  order (a layer before 10.3 cannot page);
- `supportedQueryFormats` and `currentVersion` — which format to ask for;
- `objectIdField`, `globalIdField` and `fields` with their types — ids, and which fields
  are dates;
- `extent`, `copyrightText`, and `drawingInfo` (kept, not used: symbology is a renderer
  matter).

It also checks the definition against the layer and logs what does not fit
(`arcgis layer check` in the log; `pnpm connector:test <file> --live` prints it):

- a field the mapping or `outFields` names that the layer does not have, or has spelled
  differently (paths are case-sensitive);
- a date field read with `unixMillis`/`unixSeconds` (the connector delivers dates as ISO
  8601 — see below — so use `isoTimestamp` or no transform);
- an id read from the object id when the layer has a GlobalID;
- `copyrightText` the attribution does not carry — consider it for `attribution.text`;
- a table (no geometry) mapped by geometry, a layer without the Query capability, a group
  or raster layer, a layer that cannot page.

A layer description the server refuses is a failed poll like any failed request. A body
that is JSON but not a layer description is logged and the poll goes on with defaults.

## Formats: GeoJSON, or esriJSON read as GeoJSON

The connector asks for `f=geojson` when the layer lists geoJSON among its
`supportedQueryFormats`, and for `f=json` (esriJSON) when it lists formats without it — or,
with no list, when it is older than 10.4. `query.f` fixes the choice. Whatever comes back
is read by its shape:

- **esriJSON** is converted: points (`x`, `y`, `z`), multipoints, polylines (one path →
  `LineString`, several → `MultiLineString`) and polygons. esriJSON writes exterior rings
  clockwise and holes counter-clockwise; each hole goes to the smallest exterior that
  contains it, one exterior is a `Polygon`, several a `MultiPolygon`, and the rings are
  written back in RFC 7946 order (exterior counter-clockwise, holes clockwise). A hole no
  exterior contains is taken as an exterior. Z is kept only when the response says the
  geometry has Z; M values are dropped. True curves are not read (the connector never asks
  for them).
- **Spatial reference.** The connector asks for `outSR=4326`. A response in WGS 84 (4326)
  or NAD83 (4269) is read as longitude/latitude; any other system (a server that ignored
  `outSR`, a GeoJSON `crs` member naming something else) makes the poll MALFORMED with the
  system named — nothing is reprojected.
- **Dates.** Fields of type `esriFieldTypeDate` are epoch milliseconds in both formats
  (ArcGIS Online's GeoJSON included). The connector turns them into ISO 8601 strings by the
  field's type — from the response's `fields` for esriJSON, from the layer description for
  GeoJSON — so a date property reads the same in either path. Map them with `isoTimestamp`
  (which also accepts milliseconds, should the layer description be unavailable), or as
  `observedAt` directly. `unixMillis` would refuse the ISO string and drop the field.
  String date types (`esriFieldTypeDateOnly`, `…TimestampOffset`) are left as the server
  wrote them.

## Ids

A layer's object id (`OBJECTID`, the feature's `id`) is unique within the layer but can
change when the layer is republished or reloaded. Prefer `properties.GlobalID` when the
layer has one, or a source identifier the publisher maintains (an incident number, a
station code). Validation warns about an id read from the object id. External ids may not
contain `:`, so a URN (a CAP alert id) cannot be one yet — see the phase brief's amendment
request.

## Paging

With `pagination` left out, or `offset-limit` on `resultOffset`/`resultRecordCount`, the
connector pages; `limit` is the page size wanted (the layer's `maxRecordCount` caps it) and
`maxPages` the most requests per poll (default 10, at most 200). `{ "strategy": "none" }`
asks once. Other strategies do not apply to ArcGIS and fail validation.

- Another page when the server says `exceededTransferLimit: true` — even after a page
  shorter than asked for (servers cap pages at their own limit). ArcGIS Online puts the flag
  under the FeatureCollection's `properties`; it is read in either place.
- When the server does not say, another page only after a full one; a short page ends it.
  The page size alone never decides.
- A page with nothing new (a server that ignores `resultOffset`) ends it.
- A layer that cannot page, `strategy: "none"`, or `maxPages` reached with more on the
  server: the features read are served and Source Health says the layer was truncated and
  why. Raise `maxPages` or narrow `where`.

Pages are merged into one snapshot; a feature on two pages (or in two envelopes) is one
observation. A poll in which every feature was rejected by the mapping is MALFORMED; a page
of features without geometry does not cost the pages before it.

## Viewport (`boundsQuery: true`)

The viewport becomes the query's geometry: `geometry=<west>,<south>,<east>,<north>`,
`geometryType=esriGeometryEnvelope`, `inSR=4326`, `spatialRel=esriSpatialRelIntersects`.
A viewport across the antimeridian (west greater than east) is sent as two envelopes, each
paged. Until there is a viewport the poll is skipped and Source Health says so. With
`boundsQuery` on, the definition may not set those four parameters, and `{south}`-style
placeholders are not used.

## Errors

ArcGIS answers many failures with HTTP 200 and `{ "error": { "code", "message" } }`:

| `error.code`       | Reported as                                     |
| ------------------ | ----------------------------------------------- |
| 498, 499, 401, 403 | AUTH (invalid or missing token, no permission)  |
| 429                | RATE_LIMITED                                    |
| 500–599            | a server error (retryable)                      |
| anything else      | MALFORMED, with the server's message and detail |

The cached body is dropped in every case, so an error is never served as stale data.
HTTP-level failures (timeouts, 401/403, 429, oversized bodies) are the host's, as for every
provider.

## Rate limit

One poll can send the layer description and every page of every envelope. The manifest's
request limit covers twice the cadence of that, and never less than one whole poll plus a
retry: the host counts requests in a sliding minute and refuses a burst that does not fit.

## Examples

| Example                                                                                                       | Layer                                         | Shows                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`nifc-wildfire-incidents.json`](../../connectors/examples/arcgis/nifc-wildfire-incidents.json)               | NIFC WFIGS current incidents (FeatureServer)  | points, a `where` clause, `outFields`, GlobalID ids, dates                              |
| [`nifc-wildfire-perimeters.json`](../../connectors/examples/arcgis/nifc-wildfire-perimeters.json)             | NIFC WFIGS current perimeters (FeatureServer) | polygons with holes and parts, `boundsQuery`, `geometryPrecision`, `…/query` in the URL |
| [`nws-watches-warnings-mapserver.json`](../../connectors/examples/arcgis/nws-watches-warnings-mapserver.json) | NOAA NWS watches/warnings (MapServer)         | a MapServer layer, string times with offsets, `boundsQuery`                             |

All three are `user-configured` and disabled, with no data policy opened. Their fixtures
(`fixtures/connectors/arcgis/`) are invented in the published shape; the field names and
types were checked against the live layers.

```
pnpm connector:test connectors/examples/arcgis/nifc-wildfire-incidents.json
pnpm connector:test --all
pnpm connector:test connectors/examples/arcgis/nifc-wildfire-incidents.json --live   # needs network access
```

## Not covered

Editing, attachments, related records, `MapServer/export` images (an overlay — phase
`ogc`'s amendment), ArcGIS Online item search (a later discovery phase), Portal and OAuth
sign-in flows (a token is attached as a credential; getting one is the operator's), PBF
responses, true curves, reprojection from other systems, and reading a layer that cannot
page by object id batches (such a layer is read one page at a time and reported
truncated).
