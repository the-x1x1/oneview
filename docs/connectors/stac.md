# STAC connector (`stac`)

Satellite and aerial imagery footprints — what was captured where and when — from a STAC
API's item search or a static STAC catalogue, as objects in the world: one object per
scene, at the centre of its bbox, with its footprint as geometry and its time, collection,
platform, cloud cover, ground sample distance, thumbnail link and asset keys as payload.
Not the imagery: nothing is downloaded but the item metadata, and drawing the pictures is
an overlay for a later release.

```json
{
  "schema": "oneview.connector.v1",
  "id": "earth-search-sentinel-2-l2a",
  "name": "Sentinel-2 L2A scenes (Earth Search)",
  "connector": "stac",
  "objectType": "place",
  "endpoint": {
    "url": "https://earth-search.aws.element84.com/v1/search",
    "body": { "collections": ["sentinel-2-l2a"], "limit": 100, "datetime": "P7D" },
    "intervalSeconds": 900
  },
  "boundsQuery": true,
  "pagination": { "strategy": "next-link", "nextLinkPath": "links", "maxPages": 5 },
  "mapping": { "externalId": "id" },
  "attribution": {
    "text": "Earth Search by Element 84 (STAC metadata); contains modified Copernicus Sentinel data (ESA)"
  },
  "review": "user-configured",
  "enabled": false
}
```

That is a working definition: the connector fills in the time, the centre, the footprint and
`kind` (below). The full example, with every payload field spelled out, is
`connectors/examples/stac/earth-search-sentinel-2-l2a.json`; a static catalogue is
`connectors/examples/stac/capella-open-data-static.json`.

## Search or catalogue

The endpoint decides. A URL whose path ends in `/search` is a **STAC API item search**.
Anything else — a `catalog.json`, a `collection.json`, an API collection, a single item —
is read as a **static catalogue** and walked link by link (validation says so, as a
warning, so the choice is never silent).

## Item search

| Key                        | Meaning                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `endpoint.url`             | The API's `/search`, https to a public host.                                                                                                                                         |
| `endpoint.method`          | `POST` (default) or `GET`. A server that answers POST with 405 (or 501) is searched with GET from then on, and the log says so once.                                                 |
| `endpoint.body`            | The search in its JSON form: `collections`, `ids`, `limit`, `query`, `filter`, `sortby`, `fields`, a fixed `bbox` or `intersects` … Sent as the POST body, or as GET parameters.     |
| `endpoint.query`           | Extra URL parameters that are not search parameters. `collections`, `bbox`, `datetime`, `limit` and the rest are refused here: say them once, in `body`.                             |
| `endpoint.credential`      | A bearer token, a header or a query parameter, by reference, attached by the host as for `rest-json`. `path` is refused.                                                             |
| `endpoint.intervalSeconds` | Default 900. Catalogues are heavy and scenes arrive a few times a day.                                                                                                               |
| `boundsQuery`              | `bbox` comes from the view; no search until there is one. Without it the search is the body's `bbox`/`intersects`, or worldwide (a warning) — capped at `limit` × `maxPages` scenes. |
| `pagination`               | `next-link` with `nextLinkPath: "links"` (the link whose `rel` is `next`), `maxPages` default 5; or `none` for one page. Other strategies are refused.                               |

What the connector adds to every search: `bbox` from the view (five decimals), `datetime`
(below) and `limit` 100 when the body has none. A body that already has `bbox` or
`intersects` with `boundsQuery` set is refused, as is a paging `token` or `next`.

**Time.** STAC `datetime` in the body is one of:

- absent — a rolling window of the last seven days, ending at the poll;
- an ISO 8601 duration, `P30D`, `PT12H`, `P1DT6H` (one hour to 366 days) — a rolling window
  of that length; the server never sees the duration, only the interval it becomes
  (`2026-09-16T20:00:00Z/2026-09-23T20:00:00Z`);
- a STAC datetime or interval (`2026-01-01T00:00:00Z/..`) — sent unchanged on every poll,
  with a validation warning.

A rolling window appears in Sources as **Time window (days)** (`windowDays`, 1–366): the
operator's number wins over the definition's. Unreadable values fall back to the
definition's window; out-of-range ones are clamped.

**The antimeridian.** A view across 180° (west > east) is searched as its two halves,
`[west, s, 180, n]` and `[-180, s, east, n]`, each paged on its own, and the scenes merged by
id. The spec allows a single box with west > east, but not every server accepts one.

**Paging.** The connector follows `links[rel=next]` as STAC API 1.0 describes it: a GET of
the `href`, or a POST to it with the link's `body` — merged into the current body when
`merge` is true, replacing it otherwise — and the link's `headers`, except anything that
carries credentials or framing (`Authorization`, `Cookie`, `Host`, `Content-*`, …). A next
link to another origin, with credentials in it, or with a body over 64 KiB is not
followed, and Source Health says so. A server that answers every page with the same next
request is stopped at the repeat. Paging stops at `maxPages`; when the source still had a
next page, Source Health says "stopped at 5 page(s); more scenes match".

## Static catalogues

Most open imagery on object storage is published as a static catalogue: a `catalog.json`
whose `child` links lead to more catalogues and collections and whose `item` links lead to
items, one JSON file each. The walk:

- follows `child`, `item` and `items` links (the last is an API collection's item list, an
  ItemCollection paged by `rel=next`); a Feature or a FeatureCollection is also accepted as
  the root;
- resolves relative links against the document they are in, and follows only the
  endpoint's own origin — a link anywhere else is counted, not fetched;
- goes depth first, in each document's link order, items before sub-catalogues, so a budget
  spent part-way still yields scenes; reads each URL once, so an item listed under two
  hierarchies is one request and one object;
- stops at the depth cap — the root is depth 0, a document linked from depth d is d + 1;
  **Catalogue depth** in Sources (`maxDepth`, 1–8, default 5) — and at the document budget,
  `pagination.maxPages` (default 100, at most 200; `none` reads the root alone);
- treats the root failing as the source failing (the error is the poll's), and a branch
  that is missing, not JSON, not STAC, too large or answers 5xx as one branch: skipped,
  counted and logged with its reason. Being refused (401/403, 429), timing out, going
  offline or being cancelled ends the walk.

Documents are fetched with GET through the HTTP cache, so an unchanged catalogue costs a
round of conditional requests. `boundsQuery` is refused for a static catalogue (it is read
whole), and so are POST and a body; an interval under ten minutes draws a warning. A large
catalogue is truncated by the budget in the same place on every walk: point the endpoint at
the sub-catalogue you want.

## From an item to an observation

The mapping cannot compute, so what it needs computed is attached to each item before it
is mapped, under `_stac`:

| Path                        | Value                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `_stac.centroid`            | `[lon, lat]`, the middle of the item's bbox — across 180° when the bbox is (west > east)                              |
| `_stac.bbox`                | The item's bbox (heights dropped), or one computed from its footprint, the short way round the globe                  |
| `_stac.key`                 | `<collection>/<id>` — an id unique across collections, for a search over several                                      |
| `_stac.thumbnail`           | The `thumbnail` asset's href (else an asset with the `thumbnail` role, else a `thumbnail` link), absolute, https only |
| `_stac.assets`              | The asset keys, at most 64                                                                                            |
| `_stac.href`                | The item's `self` link, else where it was read                                                                        |
| `_stac.footprintVertices`   | How many vertices the source footprint had                                                                            |
| `_stac.footprintSimplified` | `true` when the footprint was thinned to the cap                                                                      |
| `_stac.footprintDropped`    | Why the footprint was left out, when it was                                                                           |

The record's own `geometry` is replaced by the capped footprint (or `null`), so no mapping
can hand the renderer more than the cap. Where the definition leaves them out, the
connector fills in:

```json
"observedAt": { "path": "properties.datetime", "fallback": "properties.start_datetime" },
"position": { "lonLat": "_stac.centroid", "altitude": false },
"geometry": "geometry",
"properties": { "kind": { "literal": "imagery-scene" } }
```

`datetime` may be `null` with `start_datetime`/`end_datetime` (a composite, a long take);
the start is the observation's time. The examples name their payload fields:

| Payload               | From                                               |
| --------------------- | -------------------------------------------------- |
| `kind`                | `imagery-scene` (a literal)                        |
| `name`                | `properties.title`, else the item `id`             |
| `collection`          | `collection`                                       |
| `platform`            | `properties.platform`                              |
| `cloudCoverPercent`   | `properties.eo:cloud_cover`                        |
| `gsdM`                | `properties.gsd`, ground sample distance in metres |
| `endAt`               | `properties.end_datetime`                          |
| `instrumentMode`      | `properties.sar:instrument_mode` (SAR catalogues)  |
| `thumbnail`, `assets` | `_stac.thumbnail`, `_stac.assets`                  |
| `footprintSimplified` | `_stac.footprintSimplified`                        |
| `itemUrl`             | `_stac.href`                                       |

## Footprints

Landsat WRS scenes and mosaicked products carry footprints with thousands of vertices. Over
**5,000** vertices a footprint is thinned uniformly — every n-th vertex, each ring kept
closed with at least three corners — which keeps the outline of a scene (they are smooth, if
dense). One that cannot be thinned under the cap (more than 1,250 rings) is left out: the
scene keeps its centre, `_stac.footprintDropped` says why, and Source Health counts it. A
footprint that is not a GeoJSON geometry, or has coordinates outside WGS 84 by more than
rounding, is left out the same way. Heights are dropped.

## Object type

The world model has no `imagery-scene` yet; an ADR-002 amendment is requested in
[the phase brief](../roadmap/phases/stac.md). Until it lands, a scene is a `place` with
`payload.kind = "imagery-scene"` — validation refuses any other object type — and that has
consequences on screen:

- the presentation registry draws a `place` as a point, then a marker, then an icon with the
  infrastructure style, at the scene's centre;
- it draws an object's geometry only when the object has no position, so the footprint rides
  on every observation but is not on the map until the amendment draws it;
- a search for "places" finds scenes too.

## Rate, health, policy

A poll is a burst — every page of both halves, or every document of a walk, within the same
minute — so the manifest's request budget covers two polls of it (2 × (2 × `maxPages` + 1)

- 1 for a search, 2 × (`maxPages` + 1) + 1 for a walk), not the SDK's average over the
  interval. Source Health reports, after the last fetch: records the mapping rejected or
  filtered, a search stopped at `maxPages`, footprints thinned or left out, a next link not
  followed, and for a walk the budget, links past the depth cap, links to other hosts and
  unreadable documents. The data policy is the fail-closed default of every definition
  ([OVERVIEW.md](OVERVIEW.md)); scene metadata is usually openly licensed, but only a
  reviewed definition may say so.

## Testing

`pnpm connector:test connectors/examples/stac/<name>.json` runs the shared suite from the
sidecar. The suite answers every request with one body, which suits a search (the Earth
Search sidecar pages once, stops at the repeated next request and expects three scenes)
but not a walk: the static example's sidecar proves the root is read and classified and
the walk ends within its caps, with no items. The walk itself — children, items, the depth
cap, the budget, other hosts, a missing branch, one item reached twice — is in
`packages/connector-runtime/src/connectors/stac/stac.test.ts`, with a responder that
answers by URL from `fixtures/connectors/stac/static/`. The fixtures are invented in the
published shapes (see `fixtures/connectors/README.md`).

## Not in scope

Downloading assets, rendering imagery, COG tiling, and catalogues that need more than a
token (signed asset URLs, OAuth flows).
