# Phase `arcgis` — ArcGIS REST: FeatureServer and MapServer

Status: merged at `50c7f2f` (complete at `ecd96f4`; the operator's second `--live` run at `ecd96f4` passed all three examples — incidents 758, perimeters 296, NWS 0 observations over the world viewport, all LIVE — and `pnpm lint` was clean; integration landed the poll budget (request 1, `pollBudgetMs`), mapped the NWS example's id to `properties.cap_id` (request 3, after A2), and kept both import lines in the registry (request 4)) · Branch: `phase/arcgis` · Target: 0.2.0 · Owner: session bf4ce529 (2026-09-23)

## Goal

The single most common way a US or Canadian city, county, state, utility or agency
publishes live data is an ArcGIS FeatureServer layer. One definition per layer, with the
query built correctly, paged correctly and attributed correctly.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; `docs/connectors/REST-JSON.md`;
`packages/connector-runtime/src/connectors/geojson.ts`; the ArcGIS REST API reference for
`query` (Feature Service, Map Service layers); [TERRIAJS-HARVEST.md](../../architecture/TERRIAJS-HARVEST.md).

## Scope

In: `arcgis-feature` — `…/FeatureServer/{layer}/query` and `…/MapServer/{layer}/query` with
`f=geojson` (falling back to `f=json` + esriJSON → GeoJSON conversion when the server is
older than 10.4 or `supportedQueryFormats` lacks geoJSON), `where` (default `1=1`),
`outFields=*` or a list, `outSR=4326`, `geometry` + `geometryType=esriGeometryEnvelope` +
`inSR=4326` from the viewport when `boundsQuery`, paging with `resultOffset` /
`resultRecordCount` honouring `maxRecordCount` and `exceededTransferLimit`, `returnGeometry`,
`orderByFields` passthrough, token credential as `token` query parameter (existing
`credential.as: "query"`). Layer metadata (`…/{layer}?f=json`): `objectIdField`, `fields`
with types and dates (epoch millis), `extent`, `drawingInfo` (recorded, not used),
`copyrightText` (surfaced as an attribution hint in validation warnings).

Out: editing, attachments, MapServer `export` images (an overlay; see phase `ogc`'s
amendment), ArcGIS Online item search (a `discovery` phase later), Portal auth flows.

## Deliverables

1. [x] `packages/connector-runtime/src/connectors/arcgis/{feature,esri-json,layer-info}.ts`,
       `index.ts`; slot lines filled (`registry.ts`, `src/index.ts`, `docs/connectors/README.md`,
       `fixtures/connectors/README.md`).
2. [x] esriJSON → GeoJSON: points, multipoints, polylines (paths), polygons (rings, with hole
       orientation), `spatialReference` 4326/4269 only (others rejected with a reason), date
       fields to ISO from epoch millis by field type.
3. [x] Examples with sidecars and fixtures under `connectors/examples/arcgis/` and
       `fixtures/connectors/arcgis/`: NIFC WFIGS current incidents (FeatureServer points), NIFC
       WFIGS current perimeters (FeatureServer polygons — burn areas, with `boundsQuery`), NOAA
       NWS watches/warnings (MapServer layer 1); fixtures for `exceededTransferLimit` paging
       (`paging-*.geojson`) and for an `f=json` fallback (`legacy-layer.json`,
       `legacy-query.json`).
4. [x] `docs/connectors/arcgis.md`.
5. [x] `arcgis.test.ts` (32 tests): suite on every example; esriJSON conversion cases;
       paging; the fallback; `outSR` handling; bounds envelope substitution and the
       antimeridian split; the error envelope; the token; POST; the layer check.
6. [x] Changelog fragment (`docs/roadmap/phases/changelog/arcgis.md`); status and evidence.

## Definition of done

- [ ] `connector:test --all` green including the arcgis examples; `--live` pasted —
      `--all` is green (below). `--live` cannot run from this session (proxy 403 in the
      container and on the linked computer's shell); the operator's first run failed for the
      NWS example (TOO_LARGE, fixed in `ecd96f4`) and the other two results were not captured.
      The command for the next run is under Evidence.
- [x] no new dependency (`package.json`, `pnpm-lock.yaml` untouched)
- [ ] `phase-check` passes; all common checks green — `phase-check`, format (Prettier 3.9.8,
      the operator's tarball), typecheck, boundary-check, test, `connector:test --all`,
      license-audit, todo-report and stage-resources are green here; `pnpm lint` cannot run in
      the container (no eslint) and waits for the Windows gate. The new code was checked by eye
      for the rules that have bitten before, and the compiler run with unused locals and
      parameters switched on reports nothing in it.

## Design notes

- `exceededTransferLimit: true` means more pages even when the page is full; a missing
  `exceededTransferLimit` with a page shorter than `maxRecordCount` means done. Never rely on
  `resultRecordCount` alone.
- `objectIdField` is the stable id; `GlobalID` when present is better; the definition
  names it, and the layer-info check warns when the named field is not in `fields`.
- Some servers return HTTP 200 with `{ "error": { "code": 400, … } }`: treat as MALFORMED
  with the message, and as AUTH when code is 498/499.
- Envelope queries against 4326 layers with wrapped extents: split at the antimeridian
  into two requests only if `boundsQuery` is on and the viewport crosses it.
- Date fields in esriJSON are epoch millis, in GeoJSON output usually strings; read the
  layer info's field types and set `unixMillis` transforms in the example accordingly.

## Decisions

- **Connector options live in the fields the v1 schema already has.** `definitionSchema`
  drops keys it does not know (`s.object` without `strict`), and the schema is frozen, so
  there is no `arcgis` block: the layer is `endpoint.url` (`…/FeatureServer/<n>` or
  `…/MapServer/<n>`, `/query` optional), ArcGIS parameters are `endpoint.query` (compared
  case-insensitively, as ArcGIS does), and the page size is `pagination` `offset-limit` on
  `resultOffset`/`resultRecordCount` (other strategies are refused; `none` asks once;
  absent means paging with `maxPages` 10).
- **The layer description is read before the first query, then every six hours, and again
  after a query the server refuses.** A body that is JSON but not a layer description is
  logged and the poll goes on with defaults — which is also what keeps the shared suite
  meaningful, since it answers every URL with the same body.
- **Format: `supportedQueryFormats` decides**; the 10.4 threshold applies only when the layer
  gives no list. The response is read by its shape either way (a FeatureCollection, or a
  body with a `features` array), so a server that answers the other format still works.
  `query.f` can fix the format.
- **Dates are ISO 8601 in both paths, and the examples map them with `isoTimestamp`, not
  `unixMillis`** — a departure from the design note. The note says GeoJSON output usually
  carries strings; a live ArcGIS Online answer on 2026-09-23 carried epoch milliseconds
  (`"FireDiscoveryDateTime": 1767625225000` from the WFIGS incidents layer). Normalising
  by field type in both paths means one definition maps the same record whichever format
  the server chose; `unixMillis` would refuse the ISO string (and anything before 1970),
  while `isoTimestamp` accepts both ISO and milliseconds for the case where the layer
  description is unavailable. The layer check warns about `unixMillis`/`unixSeconds` on a
  date field.
- **`exceededTransferLimit` is read at the top level and under the FeatureCollection's
  `properties`**, where ArcGIS Online puts it (seen live, same answer). Paging rule: the flag
  decides when present; without it only a full page has a successor; a page bringing no new
  object ids ends paging (a server ignoring `resultOffset`); `maxPages` reached, pagination
  off, or a layer that cannot page is served and reported as truncated in Source Health.
- **Order while paging.** When a poll can take more than one page and the layer supports
  `orderBy`, the object id field is sent as `orderByFields`, or appended to the definition's
  own order as a tie-breaker.
- **Error envelope.** 498/499 → AUTH as the note says; 401 and 403 inside the envelope are
  AUTH too (ArcGIS's "You do not have permissions" is 403); 429 → RATE_LIMITED; 5xx → a
  retryable server error rather than MALFORMED (a server failing is not a mapping mismatch);
  everything else MALFORMED with the server's message and details. The cached body is
  invalidated in every case.
- **"Every record rejected → MALFORMED" is per poll, not per page**, so a page of features
  without geometry does not throw away the pages before it.
- **The manifest is sized for a whole poll.** The request limit is never less than one poll
  plus a retry (the host's limiter refuses a burst beyond its sliding minute), and
  `refreshPolicy.timeoutMs` — which the host also uses as the poll's budget — is the request
  timeout × the requests a poll can make (≤ 600 s), with each request carrying the
  definition's own timeout. See the amendment requests: `rest-json` has both problems.
- **Object types.** Incidents are `fire-detection` (they draw with fire detections, and so
  take part in the wildfire-cluster rule's 5 km / 24 h linkage — a reviewer may prefer
  `place`); perimeters are `place` with `kind: burn-area` and the polygon as geometry, so they
  do not join detection clusters; NWS polygons are `weather-alert` with the property names
  the weather-alert rule reads (`effective`, `onset`, `expires`, `ends`, `labels.title`).
- **Exports are named, with an ArcGIS prefix where a name is generic** (`arcgisEnvelopes`,
  `readArcGisFeatureSet`, …), so this slot's `export *` line cannot collide with another
  phase's.
- **A page too large for `maxBytes` is asked for again in smaller pages** (added after the
  first live run). A page's size in bytes depends on geometry nobody states in advance; the
  NWS MapServer layer's 1000-polygon page over a world viewport passed 8 MiB. The connector
  halves the page size and retries the same offset — at most four times a poll, never below
  25 features, not counted against `maxPages` — and keeps the size that worked for later
  polls. Too large even then, or on a poll that does not page: TOO_LARGE naming the offset,
  the page size and what to change. The manifest's request limit and poll budget include
  the four retries. The NWS example now asks for 250 a page (up to 20), generalises to about
  100 m (`maxAllowableOffset` 0.001), allows 16 MiB and polls every three minutes.
- **Not built:** paging a layer that cannot page by object-id batches (such a layer is read
  one page at a time and reported truncated), PBF, true curves, reprojection. Listed in the
  guide's "Not covered".

## Amendment requests

None blocks this phase; each is worked around inside `connectors/arcgis/`.

1. **`connector-sdk` `definitionToManifest`: a paginating definition at a cadence over two
   minutes gets a request limit below one poll's burst.** The limit is
   `max(4, ceil((120 / intervalSeconds) × (1 + maxPages)))`; the host's client limiter is a
   sliding 60 s window that refuses a request whose wait would exceed 10 s
   (`packages/core/src/http.ts:244`). Reproduced with the real `HttpClient` for a
   `rest-json` definition paging 10 pages at `intervalSeconds: 300`:
   `maxRequestsPerMinute 5`, pages 1–5 ok, `page 6 refused: RATE_LIMITED client rate limit
for api.example.org`. Smallest change: `max(<today's value>, pages + 1)`. The suite's
   "Rate policy" check (`maxRequestsPerMinute × intervalMs ≥ 60 000`) does not catch it.
2. **`provider-sdk`/`provider-runtime`: `refreshPolicy.timeoutMs` is both the per-request
   default and the whole poll's budget** (`timeoutMs × (maxRetries + 1) + 5 s`,
   `packages/provider-runtime/src/index.ts:393`). A `rest-json` definition paging up to 200
   pages at the default 20 s has 45 s for all of them. From reading the code; not
   reproduced in a test. Smallest change: a separate poll budget in the refresh policy, or
   the host deriving it from the pages the manifest declares.
3. **`connector-sdk` mapping: an external id may not contain `:`** (`ID_VALUE` in
   `mapping.ts`), so URN ids — CAP alert ids such as `urn:oid:2.49.0.1.840.0.…` — cannot be
   used. The NWS MapServer example therefore uses the layer's object id, which the
   connector's validation itself warns may not survive the service's reloads. This is the
   same defect phase `provider-migration` reported as **A2**, which the integrator has
   queued with that phase's integration (board item #5); once it lands, the NWS example
   should map `properties.cap_id`. If A2 is settled another way, the smallest change here
   is a named transform (`idSafe`, replacing `:` and whitespace with `-`), with a test.
4. **Process: `registry.ts` has its phase slots inside the array literal, so the import a
   phase needs cannot sit on its slot line.** This branch adds one import line beside the
   Wave 1 imports, marked `// phase:arcgis`; other phases will add theirs at the same place,
   and the merge conflict there is "keep both". A per-phase import slot would avoid it.
5. **Note, not a request:** `providers/registry`'s manifest test loads only the top level of
   `connectors/examples/`, so phase examples in subdirectories are not in it;
   `arcgis.test.ts` checks its examples' manifests against `manifestSchema` itself.

## Evidence

Commits on `phase/arcgis` (base `develop @ 0b46b15`, rebased from `e7622a3` once amendments #1–#3 landed; the operator pushed `20b1604`), all `the-x1x1 <connersalt123@outlook.com>`,
no trailers:

```
ecd96f4 arcgis: a page too large for maxBytes is asked for again in smaller pages
20b1604 roadmap: phase arcgis brief — deliverables, decisions, amendment requests, evidence
a654dcb arcgis: holes touching their exterior, a poll budget for many pages, stable ordering
c3ead5c connector-runtime: arcgis-feature, the ArcGIS REST connector (phase arcgis)
```

Run in the cloud container at `ecd96f4` on `0b46b15` (Node 22.22.2; `pnpm install` refused with 403, so
`tools/dev/link-local-toolchain.sh`; typecheck with the container shims, as always there):

```
$ node tools/dev/phase-check.mjs arcgis --base origin/develop
[phase-check] phase=arcgis branch=phase/arcgis base=origin/develop (0b46b15a4e) files=31
   connectors/examples/arcgis/… (6 files)
 ~ docs/connectors/README.md  [shared]
   docs/connectors/arcgis.md
   docs/roadmap/phases/arcgis.md
   docs/roadmap/phases/changelog/arcgis.md
 ~ fixtures/connectors/README.md  [shared]
   fixtures/connectors/arcgis/… (13 files)
   packages/connector-runtime/src/connectors/arcgis/… (5 files)
 ~ packages/connector-runtime/src/index.ts  [shared]
 ~ packages/connector-runtime/src/registry.ts  [shared]
[phase-check] shared slot files touched: 4 (integrator reviews the slot lines)
[phase-check] PASS

$ node <prettier-3.9.8>/bin/prettier.cjs --check .
All matched files use Prettier code style!
$ node tools/dev/typecheck.mjs; echo $?
0
$ node tools/dev/boundary-check.mjs
[boundary-check] files=657 violations=0 → PASS
$ node tools/dev/run-tests.mjs
[tests] group=all files=187 pass=983 fail=0 -> artifacts/verification/tests/all.json
$ node --import tsx tools/license-audit/src/cli.ts
0 errors, 0 warnings → PASS
$ node --import tsx tools/dev/todo-report.mjs
[todo-report] files=580 markers=0
$ node tools/dev/stage-resources.mjs --check
[stage-resources] up to date: apps/desktop/resources/data/demo-earthquakes.geojson
```

The phase's own tests (`node tools/dev/run-tests.mjs --filter arcgis`):

```
✔ arcgis: every example passes the shared connector suite from its sidecar
✔ arcgis: the connector is registered and its manifests cover a whole poll
✔ esriJSON: points, multipoints and polylines, with Z kept only when the geometry has Z
✔ esriJSON: rings become RFC 7946 polygons — exteriors counter-clockwise, holes clockwise and in the right exterior
✔ esriJSON: a feature set — spatial reference 4326/4269 only, dates to ISO by field type, ids from the object id field
✔ GeoJSON as ArcGIS writes it: exceededTransferLimit at the top or under properties; crs other than WGS 84 refused
✔ the ArcGIS error envelope is recognised in a 200 body
✔ layer description: parsed for what the query needs; drawingInfo recorded; a feature set is not one
✔ layer check: fields the definition names but the layer lacks, date transforms, the GlobalID, copyrightText
✔ layer URLs: FeatureServer or MapServer, one layer, /query optional, no query string
✔ validation: what the connector owns, what it does not read, and where a token goes
✔ paging: exceededTransferLimit carries on even after a short page; a short page without it ends
✔ paging: the page size is the smaller of the definition limit and maxRecordCount; a full silent page asks again
✔ paging: maxPages, a server that ignores resultOffset, pagination off, and a layer that cannot page are all reported
✔ fallback: a 10.3 layer without geoJSON is asked for f=json, and the esriJSON maps to the same observations
✔ outSR: always 4326; a server answering in another system is MALFORMED, not reprojected
✔ bounds: the viewport as an envelope in 4326, two envelopes across the antimeridian, nothing before a viewport
✔ polygons through the connector: holes and multipolygons survive to the observation geometry
✔ errors in a 200 body: 498/499 are AUTH, 5xx a server error, anything else MALFORMED with the message
✔ the token: a credential the host attaches to both requests as ?token=, never a value in the definition
✔ POST: the query goes as a form body, and the body is part of the cache key
✔ the layer check runs when the description is read, and its warnings reach the log
✔ cancellation before and during a poll: CANCELLED, no partial batch
✔ a page whose features all lack a position does not throw away the pages before it
✔ a hole that touches its exterior at a vertex stays a hole, wherever its ring starts
✔ the poll budget covers every request of a poll; each request keeps its own timeout
✔ while paging, the object id breaks ties in orderByFields the definition sets
✔ GeoJSON dates become ISO 8601 by the field types of the layer, as in the esriJSON path
✔ a query answer that is not a feature set is MALFORMED even when the layer description is fine
✔ validation: harmless false flags pass; a path credential is refused; a POST body is ignored with a warning
✔ a page larger than maxBytes is asked for again at half the size, and the smaller size is kept
✔ a page too large even at the smallest size fails with what to change; a layer that cannot page fails at once
ℹ tests 32
ℹ pass 32
ℹ fail 0
```

The tests were checked against deliberately broken code: reversing no exterior rings,
ignoring `properties.exceededTransferLimit`, ignoring `exceededTransferLimit` altogether,
not splitting at the antimeridian, dropping the repeated-page guard, mapping 498 to
MALFORMED, ignoring `supportedQueryFormats`, testing holes by their first vertex, skipping
GeoJSON date conversion, reading invalid query JSON as an empty collection, dropping the
`orderByFields` tie-breaker and dropping the poll budget each make at least one test fail.
An independent review of the first commit found the touching-hole defect, the poll-budget
risk, the tie-breaker risk and two test gaps; the second commit fixes each with a test.

`connector:test --all` (exit 0; every example PASS, the three arcgis ones 14/14):

```
PASS connectors/examples/arcgis/nifc-wildfire-incidents.json — nifc-wfigs-incidents (arcgis-feature)
    14 pass, 0 fail → PASS
PASS connectors/examples/arcgis/nifc-wildfire-perimeters.json — nifc-wfigs-perimeters (arcgis-feature)
    14 pass, 0 fail → PASS
PASS connectors/examples/arcgis/nws-watches-warnings-mapserver.json — nws-wwa-mapserver (arcgis-feature)
  ! mapping.externalId reads the object id, which can change when a layer is republished; prefer GlobalID or a source identifier field when the layer has one
    14 pass, 0 fail → PASS
PASS connectors/examples/citibike-stations-rest.json — citibike-nyc-stations (rest-json)
PASS connectors/examples/sample-websocket.json — sample-vehicle-feed (websocket-json)
PASS connectors/examples/usgs-earthquakes-csv.json — usgs-earthquakes-csv (csv)
PASS connectors/examples/usgs-earthquakes-geojson.json — usgs-earthquakes-connector (geojson)
```

Authorship: every commit's author is `the-x1x1 <connersalt123@outlook.com>`; the two checks
in the phase-agent handbook (a case-insensitive search of the branch's commit messages for
the assistant's name and for co-author trailers, and the same name searched across the
tree with `git grep -il`) print 0 and nothing.

**What the sources are, as far as this session could check.** The container and the linked
computer's shell both reach the sources only through a proxy that refused them:

```
container:        curl https://services3.arcgis.com/…/WFIGS_Incident_Locations_Current/FeatureServer/0?f=json
                  curl: (56) CONNECT tunnel failed, response 403
linked computer:  curl: (56) Received HTTP code 403 from proxy after CONNECT
                  (mapservices.weather.noaa.gov, github.com and registry.npmjs.org: no answer either)
```

A web-fetch tool (which summarises what it reads, so none of this is a byte-exact
recording) did reach all three layers on 2026-09-23:

- WFIGS incidents `…/FeatureServer/0?f=pjson`: `currentVersion` 12, `Feature Layer`,
  `esriGeometryPoint`, `objectIdField` OBJECTID, `globalIdField` GlobalID, `maxRecordCount`
  2000, `supportedQueryFormats` "JSON, geoJSON, PBF", `supportsPagination` and
  `supportsOrderBy` true, extent in 4269, `copyrightText` empty, `drawingInfo` present, and
  every field the example reads with the type its fixture gives. A `query?…&f=geojson`
  answer had `"properties": { "exceededTransferLimit": true }` and dates as epoch
  milliseconds.
- WFIGS perimeters `query?…&returnGeometry=false&f=json`: `objectIdFieldName` OBJECTID,
  `globalIdFieldName` GlobalID, `esriGeometryPolygon`, spatial reference 4326,
  `exceededTransferLimit` true, and the `poly_*`/`attr_*` fields the example reads, dates
  typed `esriFieldTypeDate`.
- NWS watch/warn/adv `MapServer/1`: `currentVersion` 11.3, `WatchesWarnings`, polygons,
  native 102100/3857, renderer `field1` `prod_type`; a `query?…&f=json` answer listed
  `objectid` (OID), `prod_type`, `msg_type`, `phenom`, `url`, `expiration`, `onset`, `ends`,
  `issuance` (strings with offsets), `event`, `sig`, `wfo`, `idp_filedate`,
  `idp_ingestdate` (dates) and `cap_id` — the names the example maps.

So the layers exist and have the fields the definitions read.

**Live runs.** The operator ran `--live` from a worktree at `20b1604` on 2026-09-23 (world
viewport). Only the end of the output was pasted back — the NWS MapServer example:

```
PASS …nws-watches-warnings-mapserver.json — nws-wwa-mapserver (arcgis-feature)
  ! mapping.externalId reads the object id, which can change when a layer is republished; prefer GlobalID or a source identifier field when the layer has one
  nws-wwa-mapserver (arcgis-feature)
    … 14 pass, 0 fail → PASS
  live: ERROR — response exceeded 8388608 bytes; 0 observation(s), 0 rejected
  ! poll failed {"providerId":"nws-wwa-mapserver","code":"TOO_LARGE","message":"response exceeded 8388608 bytes","consecutiveFailures":1}

 ELIFECYCLE  Command failed with exit code 1.
```

The host's message did not say which request was too large; with a 1000-feature page of
alert polygons over the whole world, the query page is by far the likelier. `ecd96f4` both
handles an oversized page (above) and names the request in the error if it happens again.
The incidents and perimeters results, and the `pnpm lint` output, scrolled out of what was
pasted and the worktree (with its `artifacts/verification/connectors/*.json` reports) was
removed, so they are unknown. **Until a live run passes for each example, "works live" is
unverified.**

**For the operator** (PowerShell, once the new commits are in the Windows repo's
`phase/arcgis`; a worktree, so the integrator's checkout is untouched; the output goes to
two logs in `Downloads\wv-build` as well as the screen):

```
cd C:\Users\jconn\worldview
git push origin phase/arcgis
git worktree remove --force ..\worldview-arcgis
git worktree prune
git worktree add --detach ..\worldview-arcgis-live phase/arcgis
cd ..\worldview-arcgis-live
pnpm install --frozen-lockfile
pnpm lint *>&1 | Tee-Object -FilePath $HOME\Downloads\wv-build\arcgis-lint.log
pnpm connector:test connectors/examples/arcgis/nifc-wildfire-incidents.json connectors/examples/arcgis/nifc-wildfire-perimeters.json connectors/examples/arcgis/nws-watches-warnings-mapserver.json --live *>&1 | Tee-Object -FilePath $HOME\Downloads\wv-build\arcgis-live.log
cd ..\worldview
git worktree remove --force ..\worldview-arcgis-live
```

The first `worktree remove` clears the worktree of the first run, which git still lists; it
may say there is nothing to remove. `--live` polls once with a world viewport and prints the layer check
(`! arcgis layer check …`), the health status, the counts and one sample.

## At integration (2026-09-23)

Merged into `develop` at `50c7f2f`, after the order-2 amendments (`c755aff`): the request
budget covers one poll's burst and a paged definition carries `pollBudgetMs` (requests 1 and
2 — `arcgisManifest` now sets `pollBudgetMs` and leaves `timeoutMs` as one request's);
external ids may contain `:` (request 3) — the NWS example was keyed by `properties.cap_id`
for one build, and the operator's run of it showed why not: the layer has one feature per
zone, the zones of an alert share its CAP id, and every zone after the first was dropped as
a duplicate; it is back on the object id, with the CAP id in the payload. The registry keeps
every phase's import line beside the Wave 1 imports (request 4). The operator's second `--live` run (`wv-build\arcgis-live.log`, at `ecd96f4`):
incidents LIVE with 758 observations, perimeters LIVE with 296, the NWS MapServer LIVE with 0
over the world viewport and no error; `pnpm lint` (`arcgis-lint.log`) clean.
