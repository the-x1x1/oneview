# Phase `ogc` — OGC connectors: WFS, OGC API Features, WMS, WMTS

Status: complete at `86073bf`, except `--live` (needs a machine with network access; the block is under Evidence) · Branch: `phase/ogc` · Target: 0.2.0 · Owner: session 01KTkZQz (2026-09-23)

## Goal

Every OGC service a national mapping agency, a city or a research institute publishes
becomes a definition. Feature services (WFS 2.0, OGC API – Features) produce observations
through the GeoJSON path; raster services (WMS, WMTS) produce **overlay layers** the
renderers draw — a different contract, requested as an amendment (below) and built against
a shim until it lands.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; `docs/connectors/*`;
`packages/connector-runtime/src/connectors/geojson.ts` (WFS is that with a query builder);
[TERRIAJS-HARVEST.md](../../architecture/TERRIAJS-HARVEST.md) (the WMS/WMTS/WFS rows).

## Scope

In: `wfs` (2.0.0 and 1.1.0 GetFeature with `outputFormat=application/json`, paging with
`startIndex`/`count`, `bbox` from the viewport with axis order per version and CRS, `srsName`
forced to EPSG:4326 where the server supports it, `typeNames`, `cql_filter` passthrough as a
literal string only); `ogc-features` (OGC API – Features Part 1: `/collections/{id}/items`,
`bbox`, `datetime`, `limit`, `next` links — the REST JSON `next-link` strategy restricted to
the origin); `wms` (GetCapabilities parsing: nested layers, styles, CRS lists, time
dimension, legend URL; GetMap URL template for the overlay contract; 1.1.1 vs 1.3.0 axis
order); `wmts` (GetCapabilities: TileMatrixSets, ResourceURL templates, KVP fallback; the
overlay contract's tile template).

Out: WCS, CSW, SOS (later); vendor-specific (GeoServer `format_options`) beyond passthrough;
authentication other than the endpoint credential forms already supported.

## Deliverables

1. [x] `packages/connector-runtime/src/connectors/ogc/{wfs,ogc-features,wms,wmts,capabilities}.ts`
       and `index.ts` exporting `wfsConnector`, `ogcFeaturesConnector`, `wmsConnector`,
       `wmtsConnector`; registry and index slot lines filled. Beside them: `xml.ts` (the scanner),
       `crs.ts`, `features.ts` (axis order, page mapping), `common.ts` (KVP, requests, budget),
       `overlay.ts` (the shim). The registry slot is one line spreading `OGC_CONNECTORS`, plus one
       import line carrying the `phase:ogc` marker (the slot sits inside the array, so the import
       cannot).
2. [x] `capabilities.ts`: WMS/WMTS/WFS GetCapabilities on a dependency-free tolerant tag scanner
       (`xml.ts`), tested against recorded GeoServer, MapServer, QGIS Server, ArcGIS Server (WMS and
       WMTS) and BKG documents. No dependency added.
3. [x] Examples with sidecars and fixtures under `connectors/examples/ogc/` and
       `fixtures/connectors/ogc/`: WFS `vienna-wlan-wfs` (the City of Vienna's GeoServer), OGC API
       `eccc-hydrometric-stations` (MSC GeoMet's pygeoapi), WMS `eccc-radar-rain-wms` (GeoMet,
       MapServer, time dimension) and `usgs-topo-wms` (ArcGIS Server), WMTS `bkg-topplus-light-wmts`
       (BKG). Terms recorded in each definition and in `fixtures/connectors/ogc/README.md`. All 27
       fixtures are recordings (trimmed where large); nothing is invented.
4. [x] `docs/connectors/ogc.md`.
5. [x] `ogc.test.ts`: the shared suite on every example, capabilities per server, axis order,
       `next` link origin refusal, bbox substitution, paging, overlays, validation, hostile input
       and advertised-URL refusals (45 tests).
6. [x] Changelog fragment (`changelog/ogc.md`); this brief's status and evidence.

## Definition of done

- [x] `connector:test --all` green including `connectors/examples/ogc/*`
- [ ] `--live` output pasted for each example from a machine with network access — **not run**:
      the cloud container and the operator's linked machine both answer 403 from the egress
      proxy for every public host (below). The block to run is under Evidence.
- [x] no XML parser dependency added
- [x] overlay connectors validate and produce layer descriptors through the shim, with the
      shim clearly marked as replaced by the amendment (`connectors/ogc/overlay.ts`)
- [x] `phase-check` passes; all common checks green that run in the container (lint does not;
      see Evidence)

## Design notes

- WFS 1.1.0 with EPSG:4326 returns lat/lon; 2.0.0 with `urn:ogc:def:crs:EPSG::4326` likewise,
  but `EPSG:4326` as a plain string is lon/lat on many servers. Ask for
  `srsName=urn:ogc:def:crs:OGC:1.3:CRS84` when the capabilities list it; otherwise detect
  from the capabilities' default CRS and swap. Record the decision on each observation as
  `payload.crsNote` only when a swap happened. _(Revised by evidence: see Decisions, 1.)_
- Feature ids: WFS `id` (`layer.123`) is stable; OGC API `id` likewise; when absent, the
  definition names a property.
- `count`/`limit` defaults are server-side (often 1,000 or 10,000); page until
  `numberMatched`/`numberReturned` or a `next` link says stop, within `maxPages`.
- WMS GetMap is not fetched by the connector; the overlay contract hands the renderer a URL
  template with `{bbox}` `{width}` `{height}` `{crs}` and the renderer's tile cache fetches
  through the same allow-list. Attribution must reach the map corner as for basemaps.
- Time dimension: expose `time` as a setting (ISO 8601 or `current`); do not iterate it.

## Decisions

1. **Axis order comes from the data, not the CRS name.** From the services themselves on
   2026-09-24: GeoServer (Vienna) answered GeoJSON longitude first for `srsName`
   `urn:ogc:def:crs:EPSG::4326` and `EPSG:4326`, on WFS 2.0.0 and 1.1.0 (recorded: the URN on
   2.0.0 and `EPSG:4326` on 1.1.0; probed: the other two), while its `crs` member named
   `urn:ogc:def:crs:EPSG::4326` (Stephansplatz at `[16.371…, 48.208…]`,
   `fixtures/connectors/ogc/geoserver-wien-wlan-page1.json`); QGIS Server (Solothurn) answered
   longitude first with no `crs` member (recorded with the URN, probed with `EPSG:4326`);
   MapServer's demo service (demo.mapserver.org, probed, not recorded) answered longitude first
   and named CRS84. The design note's rule would have swapped every one of them into the wrong
   hemisphere. The connector asks for the CRS in (2), then decides per poll: the operator's
   `axisOrder` setting; CRS84 asked → longitude first;
   the feature type's WGS 84 bounding box (longitude first by definition) against up to 200
   sampled coordinates, 80 % one way; a second value beyond ±90; else GeoJSON order. A swap
   writes `payload.crsNote` on every observation it touched.
2. **The EPSG:4326 URN is asked for, not CRS84 first — even when the feature type lists only a
   national grid.** Vienna lists only EPSG:31256 and reprojects on request; asked for nothing,
   it answers in metres. Asked for the same feature both ways, it put Stephansplatz1
   (`WLANWIENATOGD.5726011`) 290 m apart: `[16.37138, 48.20801]` for the EPSG:4326 URN, at its
   address (Seilergasse 1), and `[16.37343, 48.21022]` for CRS84 — that path leaves out the
   datum shift from the national grid. So CRS84 is asked for only when a feature type lists it
   and not EPSG:4326, and the axis question is answered by the data (1). An answer that is still
   not WGS 84 (a `crs` member naming another CRS, or coordinates beyond ±180) is MALFORMED with
   the CRS named. (The brief's design note preferred CRS84; the recordings overrule it.)
3. **Capabilities failures that GetFeature would not share do not stop the features.** Too
   large, 4xx/5xx or not WFS: the WFS connector goes on with the defaults, says so in Source
   Health, retries after 30 minutes. Timeout, network, auth and rate limit stop the poll. This
   is also what lets the shared suite — one responder for every request — exercise WFS as it
   does every other connector.
4. **Requests stay on the definition's host.** GetMap and GetFeature go to the definition's
   endpoint, never to the URL a capabilities document advertises. Recorded: Vienna's WMS
   advertises `http://`, ArcGIS advertises `:443`, GeoServer's WFS JSON carries a `next` link to
   its backend host `stp.wien.gv.at`. WMTS has to use what the service advertises (its tile
   template, or the KVP GetTile URL of a RESTful service); that, and any legend URL, is used only
   when it is https on exactly the definition's host with no user, password or `{placeholder}` in
   the host part (a template `https://host:{TileMatrix}/…` would otherwise pass a host check made
   with placeholders filled one way and reach another host filled another), and WMTS matrix
   identifiers, which the renderer writes into URLs, must be letters, digits and `._:-`.
5. **Paging does not stop short of a known total without saying so.** A known total
   (`numberMatched`, `totalFeatures`) decides: the walk goes on past a page shorter than asked,
   since servers cap page sizes themselves, and an empty page before the total, a page of
   features already read (a WFS that ignores `startIndex`, a vendor extension on 1.1.0, or a
   looping next link) and a stop at `maxPages` with features left each end the walk with a
   message in Source Health. Without a total there is nothing to fall short of: a page shorter
   than the size asked for is the last, and a page as long as the service's `CountDefault`
   means there may be more.
6. **The request budget covers one poll.** `definitionToManifest` allows twice the cadence
   times the pages per minute; at a 300 s cadence that is 5 requests a minute against a poll of
   capabilities plus ten pages, and the host's limiter (a 60 s sliding window, refusing past a
   10 s wait) would fail the poll at page 6. The OGC providers raise their own
   `maxRequestsPerMinute` to twice one poll's requests. `RestJsonProvider` has the same
   shortfall at slow cadences (frozen; reported below, not changed).
7. **WMTS draws Web Mercator only.** A set qualifies when its CRS is 3857 or an alias, tiles are
   256 px, every matrix starts at the world corner and every scale is a zoom level; each matrix
   is matched to its zoom. Identifiers that are not zoom numbers (BKG's `00`…`18`) become a
   `{tileMatrix}` placeholder; a `zToTileMatrix` table comes with them, and also with zoom-number
   identifiers when levels are missing, so a renderer never guesses a level.
8. **Overlay definitions** keep `objectType` and `mapping` because the schema requires them:
   the convention is `"place"` and `{ "externalId": "id" }`, and anything more in the mapping
   draws a warning. Their sidecars' `empty` is a second valid capabilities document (for BKG,
   the same one): an overlay has no records to be empty of.
9. **Fixtures are recordings.** The container and the linked machine's shell cannot reach
   public hosts; the operator's desktop browser pane can. Each document was fetched there and
   saved byte for byte, then trimmed (whole elements cut) and stored LF; the Vienna originals
   were CRLF and a test parses them again with CRLF restored. Variants a test needs are derived
   in memory in `ogc.test.ts` and labelled.
10. **The scanner is linear on hostile input.** An independent review measured a start tag of
    80,000 bare name characters at 7.4 s and a document of `<!x>` declarations as quadratic; the
    attribute pattern now consumes a name run once and the DOCTYPE search stops at its own `>`.
    8 MB of either, of stray close tags or of entity references scans in well under a second
    (a test holds it under three), and the element cap is 200,000.
11. **Only OGC-named exports leave the directory.** The runtime re-exports each phase with
    `export *`; the scanner, the CRS helpers, `nextLink` and the overlay shim stay internal so
    that another phase's helper of the same name cannot collide at integration.

## Amendment requests

- **Overlay layer contract (ADR-008):** a `RasterOverlay { id, kind: 'wms' | 'wmts' | 'xyz',
urlTemplate, attribution, minZoom?, maxZoom?, opacity?, bounds? }` published by a provider
  through a new `ProviderContext` capability or a dedicated dataset, drawn by both renderers
  under the object layers, listed in Sources with the provider's health. Until it lands,
  `wms`/`wmts` produce zero observations and expose the descriptor via `provider.overlay()`
  in the phase's shim interface.

  What the shim found the contract needs beyond that minimum (all present in
  `connectors/ogc/overlay.ts`, which the amendment replaces):
  - `tileSize`; for WMS, `crs` and `bboxAxisOrder` (`yx` for WMS 1.3.0 with EPSG:4326 — the
    renderer cannot know it from the template); for WMTS, `zToTileMatrix` when a service's
    matrix identifiers are not zoom numbers.
  - `hosts`: the tile cache's allow-list and the renderer's CSP (`img-src`/`connect-src`)
    have to admit the definition's host for the overlay's tiles; today both are fixed lists.
  - Credentials on tile requests: a definition's `endpoint.credential` reaches the
    capabilities request only; the renderer's tile fetch needs the same by-reference
    attachment the provider host does (validation warns until then).
  - `time` (value, default, extent) and `legendUrl` for Sources; the operator's `time` and
    `opacity` settings already flow into the descriptor.
  - A way to publish a changed descriptor (a new time, a new capabilities read) without
    recreating the layer.

- **Import slots in `packages/connector-runtime/src/registry.ts`:** the registry's `phase:`
  slots sit inside `BUILT_IN_CONNECTORS`, so a phase cannot import its connector on its own slot
  line; this branch adds one import line after the Wave 1 imports, marked `// phase:ogc`. Every
  connector phase will add its line at the same place, so the merges will conflict there ("both
  sides added a line": keep both). The smallest change that removes it: one
  `// phase:<id>` import slot per phase above the array, as the array has.

- **Observation, not a request:** `definitionToManifest`'s `maxRequestsPerMinute` is below one
  poll's burst for multi-page definitions at slow cadences (Decisions, 6). The OGC providers
  work around it in their own manifests; `RestJsonProvider` does not. Worth an ADR-013 line
  when the integrator next touches the SDK.

## Evidence

Everything below ran in the phase's cloud container on `86073bf` (this brief's own commit follows it
and changes nothing else), 2026-09-23 HST.

**Container gate.** Prettier is the operator's `prettier-3.9.8.tgz` from `Downloads\wv-build`,
unpacked in the container; everything else is the repository's own tooling.

```
$ git rev-parse --short HEAD
86073bf

$ node <prettier-3.9.8>/bin/prettier.cjs --check .
All matched files use Prettier code style!

$ node tools/dev/typecheck.mjs
[typecheck] tsconfig.json (shims: 13, as on develop)
[typecheck] tsconfig.renderer.json (shims: 13, as on develop)
exit 0

$ node tools/dev/boundary-check.mjs
[boundary-check] files=659 violations=0 → PASS

$ node --import tsx tools/connector-validator/src/cli.ts --all
PASS connectors/examples/citibike-stations-rest.json — citibike-nyc-stations (rest-json)
    14 pass, 0 fail → PASS
PASS connectors/examples/ogc/bkg-topplus-wmts.json — bkg-topplus-light-wmts (wmts)
    14 pass, 0 fail → PASS
PASS connectors/examples/ogc/eccc-hydrometric-stations-ogcapi.json — eccc-hydrometric-stations (ogc-features)
    14 pass, 0 fail → PASS
PASS connectors/examples/ogc/eccc-radar-wms.json — eccc-radar-rain-wms (wms)
    14 pass, 0 fail → PASS
PASS connectors/examples/ogc/usgs-topo-wms.json — usgs-topo-wms (wms)
    14 pass, 0 fail → PASS
PASS connectors/examples/ogc/vienna-wlan-wfs.json — vienna-wlan-wfs (wfs)
    14 pass, 0 fail → PASS
PASS connectors/examples/sample-websocket.json — sample-vehicle-feed (websocket-json)
    10 pass, 0 fail → PASS
PASS connectors/examples/usgs-earthquakes-csv.json — usgs-earthquakes-csv (csv)
    14 pass, 0 fail → PASS
PASS connectors/examples/usgs-earthquakes-geojson.json — usgs-earthquakes-connector (geojson)
    14 pass, 0 fail → PASS

$ node --import tsx tools/license-audit/src/cli.ts
0 errors, 0 warnings → PASS

$ node --import tsx tools/dev/todo-report.mjs
[todo-report] files=584 markers=0

$ node tools/dev/stage-resources.mjs --check
[stage-resources] up to date: apps/desktop/resources/data/airports.geojson
[stage-resources] up to date: apps/desktop/resources/data/demo-earthquakes.geojson

$ node tools/dev/phase-check.mjs ogc --base origin/develop
[phase-check] phase=ogc branch=phase/ogc base=origin/develop (e7622a3533) files=57
   connectors/examples/ogc/bkg-topplus-wmts.json
   connectors/examples/ogc/bkg-topplus-wmts.test.json
   connectors/examples/ogc/eccc-hydrometric-stations-ogcapi.json
   connectors/examples/ogc/eccc-hydrometric-stations-ogcapi.test.json
   connectors/examples/ogc/eccc-radar-wms.json
   connectors/examples/ogc/eccc-radar-wms.test.json
   connectors/examples/ogc/usgs-topo-wms.json
   connectors/examples/ogc/usgs-topo-wms.test.json
   connectors/examples/ogc/vienna-wlan-wfs.json
   connectors/examples/ogc/vienna-wlan-wfs.test.json
 ~ docs/connectors/README.md  [shared]
   docs/connectors/ogc.md
   docs/roadmap/phases/changelog/ogc.md
   docs/roadmap/phases/ogc.md
 ~ fixtures/connectors/README.md  [shared]
   fixtures/connectors/ogc/README.md
   fixtures/connectors/ogc/arcgis-usgs-wms111-capabilities.xml
   fixtures/connectors/ogc/arcgis-usgs-wms130-capabilities.xml
   fixtures/connectors/ogc/arcgis-usgs-wmts-capabilities.xml
   fixtures/connectors/ogc/bkg-topplus-wms111-capabilities.xml
   fixtures/connectors/ogc/bkg-topplus-wms130-capabilities.xml
   fixtures/connectors/ogc/bkg-topplus-wmts-capabilities.xml
   fixtures/connectors/ogc/geoserver-wien-wfs110-capabilities.xml
   fixtures/connectors/ogc/geoserver-wien-wfs200-capabilities.xml
   fixtures/connectors/ogc/geoserver-wien-wlan-crs84.json
   fixtures/connectors/ogc/geoserver-wien-wlan-empty.json
   fixtures/connectors/ogc/geoserver-wien-wlan-page1.json
   fixtures/connectors/ogc/geoserver-wien-wlan-page2.json
   fixtures/connectors/ogc/geoserver-wien-wlan-page3.json
   fixtures/connectors/ogc/geoserver-wien-wlan-wfs110.json
   fixtures/connectors/ogc/mapserver-geomet-wms111-radar.xml
   fixtures/connectors/ogc/mapserver-geomet-wms130-exception.xml
   fixtures/connectors/ogc/mapserver-geomet-wms130-radar.xml
   fixtures/connectors/ogc/pygeoapi-geomet-collection.json
   fixtures/connectors/ogc/pygeoapi-geomet-hydrometric-empty.json
   fixtures/connectors/ogc/pygeoapi-geomet-hydrometric-page1.json
   fixtures/connectors/ogc/pygeoapi-geomet-hydrometric-page2.json
   fixtures/connectors/ogc/pygeoapi-geomet-hydrometric-page3.json
   fixtures/connectors/ogc/qgis-so-wfs110-capabilities.xml
   fixtures/connectors/ogc/qgis-so-wfs110-points.json
   fixtures/connectors/ogc/qgis-so-wms130-capabilities.xml
   fixtures/connectors/ogc/vienna-wms111-capabilities.xml
   fixtures/connectors/ogc/vienna-wms130-exception.xml
   packages/connector-runtime/src/connectors/ogc/capabilities.ts
   packages/connector-runtime/src/connectors/ogc/common.ts
   packages/connector-runtime/src/connectors/ogc/crs.ts
   packages/connector-runtime/src/connectors/ogc/features.ts
   packages/connector-runtime/src/connectors/ogc/index.ts
   packages/connector-runtime/src/connectors/ogc/ogc-features.ts
   packages/connector-runtime/src/connectors/ogc/ogc.test.ts
   packages/connector-runtime/src/connectors/ogc/overlay.ts
   packages/connector-runtime/src/connectors/ogc/wfs.ts
   packages/connector-runtime/src/connectors/ogc/wms.ts
   packages/connector-runtime/src/connectors/ogc/wmts.ts
   packages/connector-runtime/src/connectors/ogc/xml.ts
 ~ packages/connector-runtime/src/index.ts  [shared]
 ~ packages/connector-runtime/src/registry.ts  [shared]
[phase-check] shared slot files touched: 4 (integrator reviews the slot lines)
[phase-check] PASS
```

**Tests** (`node tools/dev/run-tests.mjs`; the 8 skips are the native renderer and DuckDB tests that
skip on `develop` too — the baseline before this phase was 950 tests, 942 pass, 8 skipped):

```
ℹ suites 0
ℹ pass 987
ℹ fail 0
ℹ cancelled 0
ℹ skipped 8
ℹ todo 0
ℹ duration_ms 75514.758549

[tests] group=all files=185 pass=987 fail=0 -> artifacts/verification/tests/all.json
```

`node --import tsx --test packages/connector-runtime/src/connectors/ogc/ogc.test.ts`:

```
ok 1 - ogc examples: every definition loads, validates as user-configured, and names an OGC connector
ok 2 - wfs suite — Vienna WLAN sites (GeoServer, recorded): lon/lat kept despite the lat-first CRS name
ok 3 - ogc-features suite — Canada hydrometric stations (pygeoapi, recorded)
ok 4 - overlay suite — eccc-radar-wms.json: zero observations, every failure path
ok 5 - overlay suite — usgs-topo-wms.json: zero observations, every failure path
ok 6 - overlay suite — bkg-topplus-wmts.json: zero observations, every failure path
ok 7 - scanner: DOCTYPE with an internal subset, comments, CDATA, entities, stray and missing close tags
ok 8 - scanner: every recording parses the same with CRLF line endings (Vienna served CRLF)
ok 9 - WFS capabilities — GeoServer 2.0.0 and 1.1.0, QGIS Server 1.1.0
ok 10 - WMS capabilities — MapServer (GeoMet): nested layers inherit CRS, bounds and attribution; time dimension; 1.1.1 too
ok 11 - WMS capabilities — ArcGIS Server (CDATA titles, comments between CRS), QGIS Server groups, BKG, Vienna 1.1.1
ok 12 - WMTS capabilities — BKG (RESTful, zero-padded matrices) and ArcGIS (two Web Mercator sets, KVP too)
ok 13 - CRS names: every spelling the recordings use
ok 14 - axis order: decided from the data, never from the CRS name alone
ok 15 - wfs: a latitude-first page (derived from the Vienna recording) is swapped and every observation says so
ok 16 - wfs: a service that ignores srsName and answers in its national grid is refused with the CRS named
ok 17 - QGIS Server GeoJSON (recorded: no crs member, no counts) maps longitude first in one request
ok 18 - wfs: EPSG:4326 (URN) asked for when CRS84 is not listed, CRS84 when it is (derived), a pinned srsName above both
ok 19 - wfs bbox: axis order follows the CRS asked for; cql_filter carries the viewport instead when it has one
ok 20 - wfs paging: startIndex over three recorded pages (count 4 of 10), never following GeoServer's next link to its backend host
ok 21 - wfs: a service that ignores startIndex (derived: the first recorded page for every request) is noticed and not re-read
ok 22 - wfs: capabilities that are missing do not stop the features; a feature type the service does not offer does
ok 23 - ogc-features paging: next links across three recorded pages, f=json added back, bbox in CRS84 order
ok 24 - ogc-features: a next link off the origin (derived) is not followed, and health says why
ok 25 - ogc-features: maxPages stops the walk and says so
ok 26 - wms overlay — GeoMet radar (MapServer 1.3.0): Web Mercator, time default and extent, legend, attribution
ok 27 - wms overlay: the operator's time goes into the template; a bad one is refused; opacity is taken
ok 28 - wms overlay: a server that answers 1.1.1 gets an SRS template; EPSG:4326 in 1.3.0 is latitude first (derived)
ok 29 - wms overlay — ArcGIS (USGS) and Vienna 1.1.1: the advertised GetMap URL (:443, plain http) is never used
ok 30 - wmts overlay — BKG TopPlusOpen: zero-padded matrices become a zoom table, the template stays on the host
ok 31 - wmts overlay — ArcGIS (USGS): plain zoom ids give {z}; without a ResourceURL (derived) the KVP GetTile is used; another host is refused
ok 32 - overlays keep the last good descriptor through a failed poll
ok 33 - validation: what each connector refuses, with the reason
ok 34 - providers are what the registry makes of each connector
ok 35 - scanner: hostile documents are linear — 8 MB of any of them in well under a second or two
ok 36 - wfs paging: a known total wins over a short page (a server-side cap), and maxPages is said when it stops the walk
ok 37 - wfs 1.1.0 pages with maxFeatures and startIndex and names the type with typeName
ok 38 - wfs CRS choice: EPSG:4326 URN unless only CRS84 is listed — the recordings put one feature 290 m apart
ok 39 - advertised URLs: https on the definition's host only — no userinfo, no placeholder in the host
ok 40 - wmts refuses a template with a placeholder in its host and matrix ids that are not URL-safe (both derived from BKG)
ok 41 - wmts: zoom-number ids with a level missing (derived from ArcGIS) still get a table, so no level is guessed
ok 42 - wmts on a KVP endpoint (ArcGIS): vendor parameters on every request; GetTile on the definition's endpoint
ok 43 - wms: a legend on another host (derived) is not offered, and health says so; layers share a CRS or fall back
ok 44 - the registry slot spreads the four connectors in order
ok 45 - second review: an empty page short of the total is said; ".." ids and percent-encoded hosts are refused
```

**Not run here, and why.**

- **ESLint**: not installed in the container. The new files were checked with `tsc` and
  `noUnusedLocals`/`noUnusedParameters` (clean) and read for `prefer-const`,
  `no-useless-escape`, `eqeqeq` and `no-case-declarations`; two independent review passes read them
  too. The Windows gate (`check.bat`) is where lint is enforced.
- **`connector:test --live`**: the container's proxy and the operator's linked machine's shell both
  answer 403 for every public host (`CONNECT tunnel failed, response 403` for `ahocevar.com`,
  `demo.pygeoapi.io`, `sgx.geodatenzentrum.de` from both). The operator's desktop browser pane can reach
  them, which is how the fixtures were recorded, but it cannot run node. Run from PowerShell once the
  branch is pushed (a worktree keeps the integrator's checkout untouched):

  ```powershell
  cd C:\Users\jconn\worldview
  git fetch origin phase/ogc
  git worktree add ..\worldview-ogc origin/phase/ogc
  cd ..\worldview-ogc
  pnpm install --frozen-lockfile
  Get-ChildItem connectors\examples\ogc -Filter *.json | Where-Object { $_.Name -notlike '*.test.json' } |
    ForEach-Object { pnpm connector:test $_.FullName --live }
  cd ..\worldview; git worktree remove ..\worldview-ogc
  ```

  What to expect: `vienna-wlan-wfs` LIVE with about 233 observations and no `crsNote`;
  `eccc-hydrometric-stations` LIVE with up to 2,000 (the live runner's viewport is the whole world:
  4 pages of 500, and Source Health says it stopped at maxPages); the three overlays LIVE with 0
  observations and a message naming the layer. Anything else is a finding.

- **The Windows gate, Electron and WebGL**: the integrator's.

**Independent review.** A separate agent that had not seen the work reviewed `bdb2110` and then
the fixes. It found the scanner quadratic on hostile input (a start tag of 80,000 name characters
took 7.4 s), the WMTS host check bypassable through a placeholder in the host part, WFS paging that
could stop short of a known total without a word, and wording that called probed answers
recorded; it also pointed out that the recorded CRS84 and EPSG:4326 answers put one feature 290 m
apart. All of it is fixed in `86073bf` and covered by tests (Decisions 2, 4, 5, 10, 11); its second
pass confirmed each fix, and its remaining points (an empty page before the total, `..` as a matrix
identifier, a percent-encoded host, two sentences) are fixed in the same commit.

**Fixtures.** All 27 were recorded on 2026-09-24 02:29–02:44 UTC through the operator's desktop
browser pane (one site approval each), saved byte for byte to `Downloads\wv-build\ogc-recordings`,
staged into the container and trimmed there; requests and terms are in
`fixtures/connectors/ogc/README.md`.
