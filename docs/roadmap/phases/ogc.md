# Phase `ogc` — OGC connectors: WFS, OGC API Features, WMS, WMTS

Status: building · Branch: `phase/ogc` · Target: 0.2.0 · Owner: session 01KTkZQz (2026-09-23)

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
       and advertised-URL refusals (44 tests).
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

(filled in at the end: phase-check output, test summary, live results)
