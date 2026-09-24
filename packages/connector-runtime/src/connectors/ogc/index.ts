/**
 * The OGC connectors (phase `ogc`): WFS and OGC API – Features produce observations through
 * the GeoJSON path; WMS and WMTS publish a `RasterOverlay` through `overlays()` (the raster
 * overlay contract, ADR-008). See docs/connectors/ogc.md.
 *
 * The runtime re-exports this file with `export *`, so only names that say they are OGC's
 * leave it: helpers with general names (the XML scanner, CRS helpers, the overlay provider base)
 * stay inside the directory, where another phase's names cannot collide with them.
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
} from './ogc-features.js';
export { wmsConnector, WmsProvider, WMS_CONNECTOR_ID, readWmsConfig, validateWms } from './wms.js';
export { wmtsConnector, WmtsProvider, WMTS_CONNECTOR_ID, readWmtsConfig, validateWmts } from './wmts.js';
export {
  parseWmsCapabilities,
  parseWmtsCapabilities,
  parseWfsCapabilities,
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

/** The four, in the order the registry lists them (its `phase:ogc` slot spreads this). */
export const OGC_CONNECTORS = Object.freeze([wfsConnector, ogcFeaturesConnector, wmsConnector, wmtsConnector]);
