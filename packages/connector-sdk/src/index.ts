/**
 * @worldview/connector-sdk — declarative sources.
 *
 * A connector is a reusable protocol or format; a definition (JSON, `oneview.connector.v1`)
 * configures one source on it. This package holds the contract (connector.ts), the
 * definition document and its schema (definition.ts), the safe mapping language (path.ts,
 * transforms.ts, mapping.ts) and the record-to-observation step (records.ts). Connectors
 * themselves live in @worldview/connector-runtime; everything here depends on the provider
 * SDK and the world model only (ADR-013).
 */
export * from './connector.js';
export * from './definition.js';
export * from './mapping.js';
export * from './path.js';
export * from './records.js';
export * from './transforms.js';
