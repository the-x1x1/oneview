/**
 * @worldview/connector-runtime — the connectors that ship with WORLDVIEW and the registry
 * that turns a definition into a provider (ADR-013). Depends on the connector SDK, the
 * provider SDK and the world model; nothing here reaches the network except through the
 * `ProviderContext` the provider host supplies.
 */
export * from './registry.js';
export * from './load.js';
export * from './pagination.js';
export * from './csv.js';
export * from './connectors/rest-json.js';
export * from './connectors/websocket-json.js';
export * from './connectors/geojson.js';
export * from './connectors/csv.js';
export * from './testing/suite.js';
export * from './draft.js';

// Phase slots (docs/roadmap/phases): each phase exports its connector from its own line.
export * from './connectors/ogc/index.js'; // phase:ogc

export * from './connectors/arcgis/index.js'; // phase:arcgis

// phase:stac
export * from './connectors/stac/index.js';

// phase:files
export * from './connectors/files/index.js';

// phase:mqtt

// phase:home-assistant

// phase:traccar
export * from './connectors/traccar/index.js';

// phase:ingest
