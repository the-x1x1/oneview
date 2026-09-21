/**
 * @worldview/history-store — observation history, retention and timeline (ADR-005).
 *
 *   HistoryRow            flat persisted record (row.ts)
 *   PartitionKey/Index    history/<type>/<YYYY>/<MM>/<DD>/<provider>-<HHMM>.* + index.json (partition.ts)
 *   HistoryBackend        storage contract (backend.ts): NdjsonBackend | DuckDbParquetBackend
 *   HistoryStore          facade: policy-gated async writes, retention sweep, queries, snapshots
 *   TimelineController    LIVE | PAUSED | REPLAY | HISTORICAL cursor over the store
 *
 * Never used for hot-state lookups; the live world lives in @worldview/state-engine.
 */
export * from './row.js';
export * from './partition.js';
export * from './backend.js';
export * from './retention.js';
export * from './reconstruct.js';
export { NdjsonBackend, readNdjsonFile, NDJSON_EXT, type NdjsonBackendOptions } from './ndjson-backend.js';
export { DuckDbParquetBackend, DUCKDB_BACKEND_KIND, PARQUET_EXT, STAGING_EXT, type DuckDbParquetBackendOptions, type DuckDbModule } from './duckdb-backend.js';
export * from './create-backend.js';
export * from './store.js';
export * from './timeline.js';
export {
  lookbackRange, reduceLatestPerObject, isNewer, availabilityFromMetas, type PartitionScanner,
} from './scan-queries.js';

export const HISTORY_STORE_CONTRACT_VERSION = 'architecture-contract-v1';
