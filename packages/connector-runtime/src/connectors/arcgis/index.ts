/**
 * ArcGIS REST (phase `arcgis`): the `arcgis-feature` connector — one FeatureServer or
 * MapServer layer, queried as GeoJSON or esriJSON, paged and optionally bounded by the
 * viewport — with the esriJSON reader and the layer-description check it is built on.
 *
 * Exported by name, with an ArcGIS prefix where the module's own name is generic, so this
 * slot cannot collide with another phase's exports from the package index.
 */
export {
  ARCGIS_FEATURE_CONNECTOR_ID,
  ARCGIS_DEFAULT_MAX_PAGES,
  LAYER_INFO_TTL_MS as ARCGIS_LAYER_INFO_TTL_MS,
  ArcGisFeatureProvider,
  arcgisFeatureConnector,
  arcgisManifest,
  requestsPerPoll as arcgisRequestsPerPoll,
  validateArcGisFeature,
  withArcGisDefaults,
  envelopesFor as arcgisEnvelopes,
  wantsNextPage as arcgisWantsNextPage,
} from './feature.js';
export {
  arcgisError,
  describeArcGisError,
  esriFeatureSetToGeoJson,
  esriGeometryToGeoJson,
  readFeatureSet as readArcGisFeatureSet,
  type ArcGisErrorBody,
  type EsriField,
  type FeatureSet as ArcGisFeatureSet,
  type GeoJsonFeature as ArcGisGeoJsonFeature,
} from './esri-json.js';
export {
  checkLayerInfo as checkArcGisLayerInfo,
  layerEndpoint as arcgisLayerEndpoint,
  parseLayerInfo as parseArcGisLayerInfo,
  preferredFormat as arcgisPreferredFormat,
  type ArcGisLayerInfo,
  type LayerEndpoint as ArcGisLayerEndpoint,
} from './layer-info.js';
