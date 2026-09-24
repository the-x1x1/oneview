/**
 * Local files as sources (phase `files`): `local-file` (GeoJSON, CSV, GPX, KML, TopoJSON)
 * and `gdal-import` (anything else GDAL reads, through the operator's own ogr2ogr). The
 * guide is docs/connectors/files.md.
 */
export * from './contract.js';
export * from './path-policy.js';
export * from './features.js';
export * from './xml.js';
export * from './gpx.js';
export * from './kml.js';
export * from './topojson.js';
export * from './formats.js';
export * from './provider.js';
export * from './local-file.js';
export * from './gdal-import.js';
