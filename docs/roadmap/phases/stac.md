# Phase `stac` — STAC catalogues and item search

Status: merged at `428c14a` (complete at `493eedd`; requests 2–5 landed at integration, see the end) — one item open: `connector:test --live`
for Earth Search, which needs a machine that can reach the source (see Evidence) ·
Branch: `phase/stac` · Target: 0.2.0 · Owner: session 01PuX4 (phase agent)

## Goal

Satellite and aerial imagery footprints — what was captured where and when — from any
STAC API (Earth Search, Planetary Computer, USGS Landsat, national catalogues) as objects
in the world: a footprint, a time, a collection, a thumbnail link, the asset list. Not the
imagery itself (that is an overlay, later).

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; `docs/connectors/REST-JSON.md`;
STAC API spec 1.0 (core, item-search, `POST /search` with `bbox`, `datetime`,
`collections`, `limit`, pagination via `links[rel=next]` incl. POST bodies);
[TERRIAJS-HARVEST.md](../../architecture/TERRIAJS-HARVEST.md).

## Scope

In: `stac` — item search (`POST /search`, falling back to `GET /search`), `bbox` from the
viewport when `boundsQuery`, `datetime` as a rolling window setting (`last 7 days` by
default), `collections` from the definition, `next` link paging (GET links on the origin;
POST `next` with `body`/`merge` per the spec), items → observations: `id`, `datetime` (or
`start_datetime`), `geometry` (footprint kept as `mapping.geometry`, position = centroid of
the bbox), `collection`, `properties.platform`, `eo:cloud_cover`, `gsd`, the `thumbnail`
asset href and the asset keys as payload; static catalogues (`catalog.json` → `child` /
`item` links) walked to a depth cap.

Out: downloading assets; rendering imagery; COG/tiling; authenticated catalogues beyond a
bearer or query token.

## Deliverables

1. [x] `packages/connector-runtime/src/connectors/stac/{search,static,items}.ts`, `index.ts`;
       slot lines (`registry.ts`: the import and `stacConnector` in `BUILT_IN_CONNECTORS`;
       `src/index.ts`: the export).
2. [x] Examples with sidecars and fixtures under `connectors/examples/stac/`,
       `fixtures/connectors/stac/`: Earth Search (Sentinel-2 L2A,
       `earth-search-sentinel-2-l2a.json`) and one static catalogue (Capella Space open
       data, `capella-open-data-static.json`); fixtures for POST-next paging
       (`search-page1.json` → `search-page2.json`) and a 4-corner bbox crossing the
       antimeridian (`search-antimeridian.json`), plus a static catalogue tree (`static/`).
       All invented in the published shapes and said so in the fixtures README slot.
3. [x] `docs/connectors/stac.md`; its line in the `docs/connectors/README.md` slot.
4. [x] `stac.test.ts` (23 tests): the suite on both examples; POST and GET paging; the
       maxPages cap; the POST → GET fallback; the antimeridian (both halves searched, both
       centroids); centroids; the datetime window (default, definition, setting, fixed, cut
       to the freshness); the static walk (children, items, depth cap, budget, other hosts,
       a missing branch, one item reached twice, cached origin, items links); the
       5,000-vertex cap; validation; the manifest; the scene payload defaults.
5. [x] Changelog fragment `docs/roadmap/phases/changelog/stac.md`; status and evidence.

## Definition of done

- [ ] `connector:test --all` green; `--live` pasted for Earth Search — `--all` is green
      (below). `--live` is **not run**: from the cloud container and from the desktop VM
      the egress proxy answers 403 for `earth-search.aws.element84.com`. The operator's
      command is under Evidence; its output goes here.
- [x] object type decision recorded (below) and applied consistently
- [x] `phase-check` passes; common checks green — format (Prettier 3.9.8, the locked
      version, from `wv-build`), typecheck, boundary-check, test, `connector:test --all`,
      `phase-check`, todo-report, license-audit and `stage-resources --check` ran green
      here. **Lint was not run**: eslint is not installed in the container. The
      integrator's Windows gate runs it.

## Design notes

- Object type: `imagery-scene` (landed with the amendment below) — the footprint goes in
  `mapping.geometry`, the centre in `mapping.position`; map `properties.datetime` to
  `capturedAt` as well as `observedAt`, `eo:cloud_cover` to `cloudCoverPct`, `gsd` to `gsdM`,
  the item's `links[rel=self]` to `sourceUrl` and the `thumbnail` asset href to `thumbnailUrl`.
- Footprints are often huge multipolygons (Landsat WRS scenes); keep `geometry` but cap
  vertices (simplify or reject over 5,000 with a reason) so the renderer's line layer is
  not flooded.
- `datetime` may be `null` with `start_datetime`/`end_datetime`; use the start.
- Rate: catalogues are heavy; default `intervalSeconds` 900 and `limit` 100, `maxPages` 5.

## Decisions

1. **Object type `imagery-scene`**, and nothing else: validation refuses any other type.
   The phase was first built against `place` + `kind` while the amendment was pending and
   rebased onto `b13df65` when it landed; nothing of the fallback remains.
2. **The scene payload is the connector's default.** Every key the amendment names
   (`sceneId`, `collection`, `platform`, `instrument`, `capturedAt`, `cloudCoverPct`, `gsdM`,
   `processingLevel`, `sourceUrl`, `thumbnailUrl`, `assetKeys`) is filled in from the STAC
   item when a definition does not map it itself (`SCENE_PAYLOAD` in `index.ts`), as the
   `geojson` connector fills in its id and position. `sourceUrl` is the item's `self` link,
   else — in a static catalogue — the item's own file; never a search page.
3. **Mode by endpoint.** A path ending in `/search` is an item search; anything else is a
   static catalogue (validation warns so the choice is visible). No new definition field —
   the schema is frozen and this needs none.
4. **The search is written once, in `endpoint.body`, in its JSON form**, and sent as the
   POST body or converted to GET parameters (`sortby`/`fields` in their GET syntax, objects
   as JSON). `endpoint.query` keeps its `rest-json` meaning — extra URL parameters — and
   refuses STAC search parameters, so a definition cannot say `collections` twice.
5. **Time.** `body.datetime` absent → rolling seven days; an ISO 8601 duration (`P30D`,
   `PT12H`) → a rolling window of that length (the server only ever sees the interval);
   a STAC datetime/interval → sent unchanged, with a warning. A rolling window is offered
   in Sources as `windowDays`; the operator's value wins, clamped. **The window never
   reaches past how long scenes are kept**: the amendment gives `imagery-scene` a month
   before expiry, and the state engine refuses an observation already past it, so the
   setting runs 1–30, a longer definition window is cut to 30 days with a warning, and a
   definition whose `freshness` has no `expireSeconds` may search up to 366 days.
6. **The view.** `boundsQuery` sets `bbox` from the view (five decimals); no search before
   there is one. A view across 180° is searched as its two halves, each paged, merged by
   id — the spec allows west > east but not every server does.
7. **Paging.** `pagination` must be `next-link` with `nextLinkPath: "links"` (or `none`);
   `maxPages` defaults to 5. GET and POST next links per STAC API 1.0 (`body`, `merge`,
   `headers` — with `Authorization`, `Cookie`, `Host`, `Content-*` and hop-by-hop headers
   never taken from a link); the endpoint's origin only; a repeated request stops paging;
   Source Health says when `maxPages` cut a search short.
8. **POST → GET.** A 405 or 501 to the first POST switches the provider to GET for good
   (logged once); nothing else does.
9. **Static walk.** `child`, `item` and `items` links (the last reads an API collection's
   ItemCollection, paged by `rel=next`); a Feature or FeatureCollection root is accepted.
   Depth first, items before sub-catalogues, document order, each URL once, the endpoint's
   origin only. Depth cap: `maxDepth` setting, default 5, 1–8 (root = 0). Document budget:
   `pagination.maxPages` (default 100 in this mode). The root failing is the poll failing;
   below it, 4xx/5xx/not JSON/not STAC/too large skip a branch (counted, logged), while
   AUTH, RATE_LIMITED, TIMEOUT, NETWORK, OFFLINE and CANCELLED end the walk. `boundsQuery`,
   POST and a body are refused for a static catalogue. Catalogue scenes are often years
   old, so validation warns when the type's month-long expiry would refuse them; the
   Capella example sets a `freshness` without `expireSeconds`.
10. **What the mapping cannot compute** is attached to each item as `_stac` (centroid, bbox,
    `<collection>/<id>` key, absolute https thumbnail, asset keys, item page, footprint
    vertex count, simplified/dropped). The item's own `geometry` is replaced by the capped
    footprint, so no mapping can bypass the cap. Defaults when a definition leaves them
    out: `observedAt` = `properties.datetime` falling back to `start_datetime`, position =
    `_stac.centroid`, geometry = `geometry`, and the payload of decision 2.
11. **Vertex cap 5,000**: uniform thinning (every n-th vertex, rings closed, at least three
    corners), since scene outlines are smooth; a footprint that cannot get under the cap
    (over 1,250 rings), is not a valid geometry, or lies outside WGS 84 by more than 1e-6 is
    left out and the scene keeps its centre. Heights are dropped.
12. **Request budget.** The connector's manifest raises `maxRequestsPerMinute` to cover two
    polls' burst (search: 2 × (2 × maxPages + 1) + 1; walk: 2 × (maxPages + 1) + 1). The SDK
    derives 4 a minute for a 15-minute cadence, fewer than one five-page poll sends — see
    amendment request 2.
13. **Cache keys.** GET search pages are cached under `stac GET <endpoint> box<b> page<p>`,
    not their URL, because the rolling window changes the URL every poll and the HTTP
    client's cache is unbounded (observation 4). POST pages get a per-page key too (they are
    not cached, but requests are coalesced by key).
14. **Origin.** Observations from a page or document served from the cache (a 304 or a
    stale fallback) are `cached`, as `rest-json` marks them; a walk marks each document's
    items separately.
15. **Credentials**: bearer, header or query by reference; `path` is refused (a token in the
    path does not survive relative links and next links).
16. **Fixtures are invented** in the published shapes. Neither this container nor the
    desktop VM can reach the sources (proxy 403). The Earth Search fixtures follow the
    field names and layout of a real Earth Search v1 answer read on 2026-09-23; every id,
    time, bbox and href in them is made up. The static tree is generic
    (`EXAMPLE_SAR_…`), not Capella's layout.

### Presentation (the note the design asked for)

With the amendment, a scene is drawn with the `imagery-scene` rule (imagery glyph; points,
then markers, then icons), in the Overview and Space lenses, with a Scene context section,
and "imagery"/"scenes" find it. **The footprint is not drawn**: `presentation.ts` still
draws an object's geometry only when the object has no position (the `if (!pos)` branch),
and a scene has both. The ADR-002 amendment line says "renderers draw the polygon, the
point marks the centre at every zoom"; that part is not in the code yet — observation 5.

## Amendment requests

1. **ADR-002 — `ObjectTypes.ImageryScene = 'imagery-scene'`** with presentation (icon,
   footprint drawing, context section showing collection, time, cloud cover, thumbnail).
   **Landed** (ADR-002, 2026-09-23 amendment, `b13df65`): this branch is rebased onto it,
   uses `objectType: "imagery-scene"` and the payload keys the amendment names; the
   `place` + `kind` fallback is gone. Footprint drawing is not yet in the code (5).
2. **ADR-013 — `definitionToManifest`'s request budget must cover a poll's burst.** It is
   `max(4, ceil(120 / intervalSeconds × (1 + maxPages)))`: an average over the interval.
   A poll sends all its pages within seconds, and the HTTP client's limiter is a 60-second
   window, so any paged definition with an interval over two minutes cannot finish a poll.
   Probed through the real `ProviderHost` (HTTP client, limiter) with a fetch that answers
   every page with a next link, for a `rest-json` definition with `next-link`,
   `maxPages: 5` (fields trimmed):

   ```
   interval 900 → {"maxRequestsPerMinute":4,"sent":4,"observations":0,"health":"RATE_LIMITED","message":"client rate limit for api.example.org"}
   interval 60  → {"maxRequestsPerMinute":12,"sent":5,"observations":5,"health":"LIVE"}
   ```

   Smallest change: `max(<today's value>, 2 × (pages + 1) + 1)`, and the suite's "Rate
   policy" check asserting the budget covers `pages + 1` rather than one request per
   interval (it passes the broken case today). The `stac` connector overrides the value
   in its own manifest meanwhile and can drop that when this lands.

3. **ADR-013 — per-URL fixtures in the suite and the sidecar.** `runConnectorSuite` answers
   every request with one body, so a source that reads several documents (a static
   catalogue; OGC and ArcGIS paging may want it too) cannot be proved from a sidecar; the
   static example's sidecar can only prove the root. Smallest change: a list of
   `{ urlEndsWith, body }` routes in `SuiteFixtures` and the sidecar, consulted before
   `normal` in "Successful parse".
4. **Observation for ADR-003 (not blocking this phase).** The HTTP client's response cache
   (`packages/core/src/http.ts`) is a `Map` with no eviction: every cacheable GET stores an
   entry under its cache key (default: the URL). A GET source whose URL changes each poll —
   a rolling time window in the query, a bounds-driven `rest-json` definition as the view
   moves — adds an entry per distinct URL for the life of the process. Read from the code,
   not measured. `stac` keys its GET pages by slot to stay out of it (decision 13).
5. **Observation for ADR-002 (the landed amendment).** Its ADR line promises footprint
   drawing; `presentation.ts` has the `imagery-scene` rule but still skips `geometry` for
   any object with a position, so scenes show as points. Smallest change: for rules that
   opt in (a `drawGeometry: true` on the imagery-scene rule), emit the geometry feature as
   well as the point. Nothing in this phase changes when it lands.

## Evidence

Commit `493eedd` on `phase/stac`, base `develop @ b13df65` (the imagery-scene amendment).
All in the cloud container.

`node tools/dev/phase-check.mjs stac --base origin/develop`:

```
[phase-check] phase=stac branch=phase/stac base=origin/develop (b13df655c1) files=28
   connectors/examples/stac/capella-open-data-static.json
   connectors/examples/stac/capella-open-data-static.test.json
   connectors/examples/stac/earth-search-sentinel-2-l2a.json
   connectors/examples/stac/earth-search-sentinel-2-l2a.test.json
 ~ docs/connectors/README.md  [shared]
   docs/connectors/stac.md
   docs/roadmap/phases/changelog/stac.md
   docs/roadmap/phases/stac.md
 ~ fixtures/connectors/README.md  [shared]
   fixtures/connectors/stac/search-antimeridian.json
   fixtures/connectors/stac/search-empty.json
   fixtures/connectors/stac/search-page1.json
   fixtures/connectors/stac/search-page2.json
   fixtures/connectors/stac/static/by-date/2026/collection.json
   fixtures/connectors/stac/static/by-date/2026/items/EXAMPLE_SAR_SM_20260314T081200.json
   fixtures/connectors/stac/static/by-date/catalog.json
   fixtures/connectors/stac/static/by-mode/catalog.json
   fixtures/connectors/stac/static/by-mode/spotlight/collection.json
   fixtures/connectors/stac/static/by-mode/spotlight/items/EXAMPLE_SAR_SP_20260105T103000.json
   fixtures/connectors/stac/static/by-mode/spotlight/items/EXAMPLE_SAR_SP_20260214T061522.json
   fixtures/connectors/stac/static/catalog.json
   packages/connector-runtime/src/connectors/stac/index.ts
   packages/connector-runtime/src/connectors/stac/items.ts
   packages/connector-runtime/src/connectors/stac/search.ts
   packages/connector-runtime/src/connectors/stac/stac.test.ts
   packages/connector-runtime/src/connectors/stac/static.ts
 ~ packages/connector-runtime/src/index.ts  [shared]
 ~ packages/connector-runtime/src/registry.ts  [shared]
[phase-check] shared slot files touched: 4 (integrator reviews the slot lines)
[phase-check] PASS
```

`node --import tsx tools/connector-validator/src/cli.ts --all` (exit 0), the two STAC
reports in full:

```
PASS connectors/examples/citibike-stations-rest.json — citibike-nyc-stations (rest-json)
PASS connectors/examples/sample-websocket.json — sample-vehicle-feed (websocket-json)
PASS connectors/examples/stac/capella-open-data-static.json — capella-open-data-scenes (stac)
PASS connectors/examples/stac/earth-search-sentinel-2-l2a.json — earth-search-sentinel-2-l2a (stac)
PASS connectors/examples/usgs-earthquakes-csv.json — usgs-earthquakes-csv (csv)
PASS connectors/examples/usgs-earthquakes-geojson.json — usgs-earthquakes-connector (geojson)

PASS connectors/examples/stac/earth-search-sentinel-2-l2a.json — earth-search-sentinel-2-l2a (stac)
  earth-search-sentinel-2-l2a (stac)
    Config validation    PASS  ok
    Successful parse     PASS  ok
    Empty response       PASS  ok
    Malformed response   PASS  ok
    Timeout              PASS  ok
    Auth failure         PASS  ok
    Rate limit           PASS  ok
    Oversized payload    PASS  ok
    Cancellation         PASS  ok
    Mapping error        PASS  ok
    Missing fields       PASS  ok
    Attribution          PASS  ok
    Data policy          PASS  ok
    Rate policy          PASS  ok
    14 pass, 0 fail → PASS
PASS connectors/examples/stac/capella-open-data-static.json — capella-open-data-scenes (stac)
  ! the endpoint is not an item search (…/search): it is read as a static catalogue and walked link by link
  capella-open-data-scenes (stac)
    Config validation    PASS  ok
    Successful parse     PASS  ok
    Empty response       PASS  ok
    Malformed response   PASS  ok
    Timeout              PASS  ok
    Auth failure         PASS  ok
    Rate limit           PASS  ok
    Oversized payload    PASS  ok
    Cancellation         PASS  ok
    Mapping error        PASS  ok
    Missing fields       PASS  ok
    Attribution          PASS  ok
    Data policy          PASS  ok
    Rate policy          PASS  ok
    14 pass, 0 fail → PASS
```

The Earth Search sidecar's field expectations are live checks: changing an expected value
(cloud cover 12.5 → 12.6) fails "Successful parse" with the field, the value and the
expectation named.

`node tools/dev/run-tests.mjs --filter stac`:

```
✔ Earth Search example: the shared suite, with scenes at their bbox centres and the payload the brief names
✔ static example: the shared suite on the root catalogue (the walk itself is proved below)
✔ both examples load from connectors/examples/stac: user-configured, disabled, nothing opened
✔ POST paging: the next link body is merged into the search, page 2 carries it all, the last page ends it
✔ next links: merge false sends the link body alone; credentials and framing headers are never taken from a link
✔ GET search: parameters in the query, next hrefs followed on the origin, a link off it refused and reported
✔ maxPages caps a search that keeps paging, and Source Health says more scenes match
✔ a server that answers 405 to POST /search is searched with GET, then and on every later poll
✔ boundsQuery: no request until there is a view; the view across the antimeridian is searched as two halves
✔ centroids: a 4-corner bbox, one across the antimeridian, a 6-number bbox, and bboxes that are not
✔ footprints over 5,000 vertices are thinned (rings stay closed); ones that cannot be are left out with a reason
✔ through the provider: a dense footprint arrives thinned, an impossible one leaves the scene at its centre
✔ item records: thumbnail absolute and https only, asset keys, the collection-qualified key, the source page, anything not an object untouched
✔ datetime: seven days by default, the definition's window, the operator's setting, and a fixed interval as written
✔ static catalogue: children and items to the leaves, one item reached twice read once, other hosts and a missing branch
✔ static catalogue: the depth cap (the operator's setting) and the document budget (maxPages) stop the walk
✔ static catalogue: the root failing is the source failing; a refusal below it ends the walk; cancellation mid-walk
✔ static catalogue: items served from the cache are marked cached; a mapping that fits no item is MALFORMED
✔ static catalogue: an API collection's items link (an ItemCollection paged by rel=next) is read too
✔ validation: what a STAC definition may not say, each refused with the reason
✔ manifest: a request budget that covers a whole poll, the 15-minute default cadence, the settings
✔ defaults: a definition that names only the id gets the time, centre, footprint and the amendment's payload
✔ GET form of a search: arrays joined, sortby and fields in their GET syntax, objects as JSON
[tests] group=all files=1 pass=23 fail=0 -> artifacts/verification/tests/all.json
```

`node tools/dev/run-tests.mjs` (the whole workspace; natives skip with a reason):

```
ℹ pass 965
ℹ fail 0
ℹ skipped 8
[tests] group=all files=185 pass=965 fail=0 -> artifacts/verification/tests/all.json
```

End to end without the network: the Earth Search example through the real `ProviderHost`
(HTTP client, allow-list, limiter) with a fetch answering each POST with a fresh `next`
token and scenes from the last few days, view over Hawaii, then the batch into the real
`WorldState` with the manifest's freshness:

```
POST https://earth-search.aws.element84.com/v1/search next=- datetime=2026-09-17T03:18:21Z/2026-09-24T03:18:21Z
POST https://earth-search.aws.element84.com/v1/search next=t1 datetime=2026-09-17T03:18:21Z/2026-09-24T03:18:21Z
POST https://earth-search.aws.element84.com/v1/search next=t2 datetime=2026-09-17T03:18:21Z/2026-09-24T03:18:21Z
POST https://earth-search.aws.element84.com/v1/search next=t3 datetime=2026-09-17T03:18:21Z/2026-09-24T03:18:21Z
POST https://earth-search.aws.element84.com/v1/search next=t4 datetime=2026-09-17T03:18:21Z/2026-09-24T03:18:21Z
{"maxRequestsPerMinute":23,"requests":5,"observations":15,"health":"LIVE","message":"Last fetch: stopped at 5 page(s); more scenes match"}
{"world":{"accepted":15,"added":15,"rejected":0},"object":{"type":"imagery-scene","freshness":"RECENT","hasGeometry":true,"payloadKeys":["assetKeys","capturedAt","cloudCoverPct","collection","gsdM","instrument","name","platform","processingLevel","sceneId","sourceUrl","thumbnailUrl"]}}
```

The other checks:

```
prettier 3.9.8 --check .          All matched files use Prettier code style!   (exit 0)
node tools/dev/typecheck.mjs      tsconfig.json, tsconfig.renderer.json — no errors (exit 0; shims in use, as always here)
node tools/dev/boundary-check.mjs [boundary-check] files=652 violations=0 → PASS
todo-report                       [todo-report] files=577 markers=0
license-audit                     Providers  16/16 manifests and definitions matched against 73 registry records
                                  0 errors, 0 warnings → PASS
stage-resources --check           up to date (exit 0)
authorship                        both commits the-x1x1 <connersalt123@outlook.com>, no trailers; the tree-wide name check prints nothing
```

Not run here: `pnpm lint` (no eslint in the container) and `--live` (no route to the
source). For the operator, from a checkout of the branch on Windows:

```
pnpm connector:test connectors/examples/stac/earth-search-sentinel-2-l2a.json --live
```

It polls once with the whole world as the view (seven days of Sentinel-2 L2A, at most five
pages of 100) and must end LIVE with observations; paste its output here.

## At integration (2026-09-23)

Merged into `develop` at `428c14a`, after the order-2 amendments (`c755aff`): **2** the
request budget covers one poll's burst and a paged definition carries `pollBudgetMs`
(`stacManifest` now sets it too; the static walk of 150 documents gets the ten-minute
ceiling); **4** the HTTP client's response cache is bounded (256 entries, oldest first);
**5** presentation draws an imagery scene's footprint beside its centre mark from the
regional band and whenever it is selected (`RenderingRule.drawGeometry`). **3** (per-URL
fixtures in the suite) is deferred to the refactor pass: the static example proves its walk
in `stac.test.ts`.
