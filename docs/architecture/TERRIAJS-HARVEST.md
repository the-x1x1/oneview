# TerriaJS harvest

What WORLDVIEW takes from TerriaJS (Apache-2.0, CSIRO Data61), what it takes only as a
design, and what it does not take at all. Nothing is copied into this repository without
its licence header and a line in `THIRD_PARTY_NOTICES`; the default is to take the
knowledge, not the code, because Terria's catalog items are written against Cesium's data
sources and MobX, neither of which is our world model.

## What Terria has that we want

Terria's catalog (`lib/Models/Catalog/`) is fifteen years of learning how public
geospatial services actually behave. Each catalog item type is a connector in our terms:
WMS, WMTS, WFS, ArcGIS MapServer and FeatureServer, ArcGIS Portal, CKAN, Socrata, OpenDataSoft,
CSW, STAC (recent), GeoJSON, CSV (with its own column-type inference), KML/KMZ, CZML, GPX,
Cesium 3D Tiles, SDMX, Carto, Sensor Observation Service (SOS), GTFS.

For each, the value is in the **capabilities parsing and the edge cases**:

| Terria item                                                                              | What to harvest                                                                                                                                   | Where it lands                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebMapServiceCatalogItem`                                                               | GetCapabilities parsing (nested layers, styles, dimensions incl. time, legend URLs, CRS lists, 1.1.1 vs 1.3.0 axis order), GetFeatureInfo formats | [ogc/capabilities.ts](../../packages/connector-runtime/src/connectors/ogc/capabilities.ts), [ogc/wms.ts](../../packages/connector-runtime/src/connectors/ogc/wms.ts), [ogc/crs.ts](../../packages/connector-runtime/src/connectors/ogc/crs.ts); GetFeatureInfo not built ([ogc.md](../connectors/ogc.md))       |
| `WebMapTileServiceCatalogItem`                                                           | tile matrix sets, resource URL templates, RESTful vs KVP                                                                                          | [ogc/capabilities.ts](../../packages/connector-runtime/src/connectors/ogc/capabilities.ts), [ogc/wmts.ts](../../packages/connector-runtime/src/connectors/ogc/wmts.ts)                                                                                                                                          |
| `WebFeatureServiceCatalogItem`                                                           | GetFeature with `outputFormat=application/json`, paging via `startIndex`/`count` (2.0), `srsName` handling                                        | [ogc/wfs.ts](../../packages/connector-runtime/src/connectors/ogc/wfs.ts), [ogc/features.ts](../../packages/connector-runtime/src/connectors/ogc/features.ts)                                                                                                                                                    |
| `ArcGisFeatureServerCatalogItem`                                                         | `query?f=geojson`, `resultOffset`/`resultRecordCount`, `exceededTransferLimit`, `maxRecordCount`, renderer drawing info                           | [arcgis/feature.ts](../../packages/connector-runtime/src/connectors/arcgis/feature.ts), [arcgis/layer-info.ts](../../packages/connector-runtime/src/connectors/arcgis/layer-info.ts) (drawing info kept, not drawn), [arcgis/esri-json.ts](../../packages/connector-runtime/src/connectors/arcgis/esri-json.ts) |
| `ArcGisMapServerCatalogItem`                                                             | export/tile modes, layer ids, legend                                                                                                              | [arcgis/layer-info.ts](../../packages/connector-runtime/src/connectors/arcgis/layer-info.ts) (a MapServer layer's features by id); export and tile modes and the legend not built                                                                                                                               |
| `CsvCatalogItem` / TableMixin                                                            | column type inference (lat/lon column name lists, time columns, region mapping), "regions" concept                                                | [draft.ts](../../packages/connector-runtime/src/draft.ts) (`connector:add`), [files/formats.ts](../../packages/connector-runtime/src/connectors/files/formats.ts); region mapping not taken                                                                                                                     |
| `GeoJsonMixin`                                                                           | CRS reprojection when `crs` is not WGS84, TopoJSON, feature-id fallbacks                                                                          | [files/topojson.ts](../../packages/connector-runtime/src/connectors/files/topojson.ts), [files/formats.ts](../../packages/connector-runtime/src/connectors/files/formats.ts), [geojson.ts](../../packages/connector-runtime/src/connectors/geojson.ts) (id fallback)                                            |
| `GpxCatalogItem`, `KmlCatalogItem`                                                       | parsers via togeojson                                                                                                                             | [files/gpx.ts](../../packages/connector-runtime/src/connectors/files/gpx.ts), [files/kml.ts](../../packages/connector-runtime/src/connectors/files/kml.ts), [files/xml.ts](../../packages/connector-runtime/src/connectors/files/xml.ts) (own parsers, no togeojson)                                            |
| `StacCatalogItem` (and the STAC browser in Terria Map)                                   | collection/item traversal, asset roles                                                                                                            | [stac/static.ts](../../packages/connector-runtime/src/connectors/stac/static.ts), [stac/search.ts](../../packages/connector-runtime/src/connectors/stac/search.ts), [stac/items.ts](../../packages/connector-runtime/src/connectors/stac/items.ts)                                                              |
| `CkanCatalogGroup`, `SocrataCatalogGroup`, `OpenDataSoftCatalogGroup`, `CswCatalogGroup` | catalogue discovery: how a portal is walked and resources are typed                                                                               | later phase `discovery` (not started; [ROADMAP.md](../../ROADMAP.md))                                                                                                                                                                                                                                           |
| `SensorObservationServiceCatalogItem`                                                    | SOS 2.0 GetObservation, procedure/observed-property model                                                                                         | later, with `telemetry` (not started)                                                                                                                                                                                                                                                                           |
| `GtfsCatalogItem`                                                                        | GTFS-RT protobuf vehicle positions                                                                                                                | later phase `transit` (not started)                                                                                                                                                                                                                                                                             |

Paths are relative to this file and were checked to exist when the connectors were merged
(the refactor pass); "not built" and "not started" are said where there is no file.

## What is harvested as a design, not code

- The idea that a catalogue item is **configuration**, and that a whole national catalogue
  (`nationalmap`, `terriamap`) is a JSON file. Our definitions are that, restricted: no
  rendering instructions, no UI, no per-item code.
- Terria's **feature info templates** (Mustache) are a precedent we deliberately do not
  follow; a mapping is not a template engine.
- The **catalog-init import** shape: a Terria `catalog.json` can be translated into a set of
  definitions by a tool (`connector:import --terria <url>`), one per item type we support,
  with the rest listed as unsupported. That tool is part of phase `discovery`.

## What is not taken

- Cesium data-source classes and MobX traits: our renderers draw observations from world
  state, not catalog items.
- Region mapping (`regionMapping.json`) — a Terria-hosted service; not a source.
- Any code that reaches the network on its own; every connector goes through the provider
  host.

## How to harvest a piece

1. Read the Terria item and its tests; write down the edge cases as a list.
2. Write those as fixtures (invented in the published shape, or recorded where the service
   permits a sample) and a `*.test.ts` that runs the shared suite plus the edge cases.
3. Implement against the fixtures. If a fragment of Terria code is the clearest way (a
   capabilities parser, say), copy it with its Apache-2.0 header into the connector file, add
   the notice, and keep the fragment small enough to review.
4. Record the source (file, commit) in the connector's header comment.
