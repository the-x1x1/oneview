# Phase `ogc` — OGC connectors: WFS, OGC API Features, WMS, WMTS

Status: open · Branch: `phase/ogc` · Target: 0.2.0 · Owner: (unassigned)

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

1. `packages/connector-runtime/src/connectors/ogc/{wfs,ogc-features,wms,wmts,capabilities}.ts`
   and `index.ts` exporting `wfsConnector`, `ogcFeaturesConnector`, `wmsConnector`,
   `wmtsConnector`; registry and index slot lines filled.
2. `capabilities.ts`: a WMS/WMTS/WFS GetCapabilities parser (XML via the platform's DOM is
   not available in the main process — use a small, dependency-free tolerant tag scanner
   scoped to the elements needed, with fixtures from GeoServer, MapServer, QGIS Server and
   ArcGIS-as-WMS; no new dependency without an amendment request).
3. Example definitions with sidecars and fixtures under `connectors/examples/ogc/` and
   `fixtures/connectors/ogc/`: at least one WFS (a public GeoServer, e.g. a city's open-data
   WFS), one OGC API – Features (e.g. a pygeoapi or ldproxy demo), one WMS and one WMTS
   (a national basemap service whose terms allow it), each with the terms recorded.
4. `docs/connectors/ogc.md`: the four connectors, their definition keys, axis-order and CRS
   rules, paging, the overlay contract as used.
5. `ogc.test.ts`: the shared suite on every example, plus capabilities parsing against
   each server fixture, axis-order cases, `next` link origin refusal, bbox substitution.
6. Changelog fragment; brief status and evidence.

## Definition of done

- [ ] `connector:test --all` green including `connectors/examples/ogc/*`
- [ ] `--live` output pasted for each example from a machine with network access
- [ ] no XML parser dependency added, or an amendment request explaining why one is needed
- [ ] overlay connectors validate and produce layer descriptors through the shim, with the
      shim clearly marked as replaced by the amendment
- [ ] `phase-check` passes; all common checks green

## Design notes

- WFS 1.1.0 with EPSG:4326 returns lat/lon; 2.0.0 with `urn:ogc:def:crs:EPSG::4326` likewise,
  but `EPSG:4326` as a plain string is lon/lat on many servers. Ask for
  `srsName=urn:ogc:def:crs:OGC:1.3:CRS84` when the capabilities list it; otherwise detect
  from the capabilities' default CRS and swap. Record the decision on each observation as
  `payload.crsNote` only when a swap happened.
- Feature ids: WFS `id` (`layer.123`) is stable; OGC API `id` likewise; when absent, the
  definition names a property.
- `count`/`limit` defaults are server-side (often 1,000 or 10,000); page until
  `numberMatched`/`numberReturned` or a `next` link says stop, within `maxPages`.
- WMS GetMap is not fetched by the connector; the overlay contract hands the renderer a URL
  template with `{bbox}` `{width}` `{height}` `{crs}` and the renderer's tile cache fetches
  through the same allow-list. Attribution must reach the map corner as for basemaps.
- Time dimension: expose `time` as a setting (ISO 8601 or `current`); do not iterate it.

## Amendment requests

- **Overlay layer contract (ADR-008):** a `RasterOverlay { id, kind: 'wms' | 'wmts' | 'xyz',
urlTemplate, attribution, minZoom?, maxZoom?, opacity?, bounds? }` published by a provider
  through a new `ProviderContext` capability or a dedicated dataset, drawn by both renderers
  under the object layers, listed in Sources with the provider's health. Until it lands,
  `wms`/`wmts` produce zero observations and expose the descriptor via `provider.overlay()`
  in the phase's shim interface.

## Evidence

(filled in at the end: phase-check output, test summary, live results)
