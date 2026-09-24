/**
 * HTTP ingest (phase `ingest`): `http-ingest`, a source that anything able to POST — a
 * Node-RED flow, a script, a gateway — pushes records to over a token-protected listener on
 * 127.0.0.1. The guide is docs/connectors/ingest.md.
 */
export * from './envelope.js';
export * from './http-ingest.js';
