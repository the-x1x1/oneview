# Phase `arcgis` — ArcGIS REST: FeatureServer and MapServer

Status: open · Branch: `phase/arcgis` · Target: 0.2.0 · Owner: (unassigned)

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

1. `packages/connector-runtime/src/connectors/arcgis/{feature,esri-json,layer-info}.ts`,
   `index.ts`; slot lines filled.
2. esriJSON → GeoJSON: points, multipoints, polylines (paths), polygons (rings, with hole
   orientation), `spatialReference` 4326/4269 only (others rejected with a reason), date
   fields to ISO from epoch millis by field type.
3. Examples with sidecars and fixtures under `connectors/examples/arcgis/` and
   `fixtures/connectors/arcgis/`: one FeatureServer point layer (e.g. a city's traffic
   incidents or a state's DOT cameras), one polygon layer (e.g. burn areas), one MapServer
   layer; fixtures for `exceededTransferLimit` paging and for an `f=json` fallback.
4. `docs/connectors/arcgis.md`.
5. `arcgis.test.ts`: suite on every example; esriJSON conversion cases; paging; the
   fallback; `outSR` handling; bounds envelope substitution.
6. Changelog fragment; status and evidence.

## Definition of done

- [ ] `connector:test --all` green including the arcgis examples; `--live` pasted
- [ ] no new dependency
- [ ] `phase-check` passes; all common checks green

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

## Amendment requests

(none expected)

## Evidence

(filled in at the end)
