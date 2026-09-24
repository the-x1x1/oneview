/**
 * The OGC connectors (phase `ogc`): WFS and OGC API – Features produce observations through
 * the GeoJSON path; WMS and WMTS publish raster overlays through the shim in overlay.ts
 * until the raster overlay contract lands. See docs/connectors/ogc.md.
 */
import { wfsConnector } from './wfs.js';
import { ogcFeaturesConnector } from './ogc-features.js';
import { wmsConnector } from './wms.js';
import { wmtsConnector } from './wmts.js';

export { wfsConnector, WfsProvider, WFS_CONNECTOR_ID, readWfsConfig, validateWfs, wfsBbox } from './wfs.js';
export {
  ogcFeaturesConnector,
  OgcFeaturesProvider,
  OGC_FEATURES_CONNECTOR_ID,
  readOgcFeaturesConfig,
  validateOgcFeatures,
  nextLink,
} from './ogc-features.js';
export { wmsConnector, WmsProvider, WMS_CONNECTOR_ID, readWmsConfig, validateWms, zoomRange } from './wms.js';
export {
  wmtsConnector,
  WmtsProvider,
  WMTS_CONNECTOR_ID,
  readWmtsConfig,
  validateWmts,
  webMercatorLevels,
} from './wmts.js';
export {
  parseWmsCapabilities,
  parseWmtsCapabilities,
  parseWfsCapabilities,
  findFeatureType,
  isParsed,
  parseProblem,
  type ParseResult,
  type WmsCapabilities,
  type WmsLayer,
  type WmsStyle,
  type WmsDimension,
  type WmtsCapabilities,
  type WmtsLayer,
  type WmtsTileMatrixSet,
  type WmtsTileMatrix,
  type WfsCapabilities,
  type WfsFeatureType,
} from './capabilities.js';
export {
  classifyCrs,
  epsgCode,
  isCrs84,
  isWgs84,
  isWebMercator,
  CRS84_URN,
  EPSG4326_URN,
  type CrsInfo,
  type CrsKind,
} from './crs.js';
export {
  decideAxisOrder,
  swapFeatureAxes,
  sampleCoordinates,
  type AxisDecision,
  type AxisSetting,
} from './features.js';
export { scanXml, type XmlElement } from './xml.js';

/** The four, in the order the registry lists them (its `phase:ogc` slot spreads this). */
export const OGC_CONNECTORS = Object.freeze([wfsConnector, ogcFeaturesConnector, wmsConnector, wmtsConnector]);
export { isOverlayProvider, type OverlayProvider, type RasterOverlay } from './overlay.js';
