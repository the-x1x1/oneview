# ADR-005 — History: DuckDB + Parquet partitions, NDJSON fallback

Status: Accepted · 2026-09-21 · Package: `@worldview/history-store`

## Decision
- Observations are appended to date-partitioned files `history/<objectType>/<YYYY>/<MM>/<DD>/*.parquet` (GeoParquet-compatible columns: lon/lat/altitude, observedAt, objectId, providerId, payload JSON). DuckDB (with the spatial extension when available) queries the partitions for timeline/replay/aggregation. DuckDB is never used for hot-state lookups.
- A dependency-free NDJSON backend implements the same `HistoryBackend` interface for tests, CI without native modules, and as a runtime fallback when the DuckDB native module fails to load (the failure is surfaced in diagnostics, never hidden).
- Retention is provider/object aware and capped by `ProviderDataPolicy` (`retentionCapSeconds`); raw payload hashes are stored only when `rawPayloadRetentionAllowed`. Track data is downsampled in tiers (0–5 min full, 5–30 min moderate, 30 min–24 h coarse, older per archive policy).
- Timeline availability is derived from partition metadata, so the UI shows real boundaries instead of pretending data exists.

## Consequences
History writes are asynchronous and never block ingest; a failed write is logged and counted, not retried forever.
