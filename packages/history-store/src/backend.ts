import type { GeoBounds, GeoRegion, IsoTimestamp, JsonValue, TimeRange } from '@worldview/world-model';
import type { HistoryRow } from './row.js';
import type { PartitionFilter, PartitionKey, PartitionMeta } from './partition.js';
import type { ThinColumns, ThinPlan } from './retention.js';

/**
 * HistoryBackend — the storage contract behind HistoryStore (ADR-005).
 *
 * Two implementations: NdjsonBackend (pure Node, always available) and
 * DuckDbParquetBackend (native module, loaded lazily). Both keep the same partition
 * layout and the same index file, so a data directory written by one can be read by
 * the other's index tooling and diagnostics show one truth.
 */
export interface AppendResult {
  rows: number;
  bytes: number;
  partition: PartitionMeta;
}

export interface ReadResult {
  rows: HistoryRow[];
  /** Lines/records that could not be parsed or failed validation — counted, never fatal. */
  malformed: number;
}

export interface RewriteMeta {
  originalRows: number;
  downsampleTier?: number;
  rawStripped?: boolean;
  /** When the partition was rewritten without repeated observations (store.ts `dedupe`). */
  dedupedAt?: IsoTimestamp;
}

export interface DedupeResult {
  rowsBefore: number;
  rowsAfter: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface ObjectsAtOptions {
  objectTypes?: string[];
  providerIds?: string[];
  bounds?: GeoBounds;
  /** Only observations with observedAt ≥ cursor − lookback are candidates. */
  lookbackSeconds: number;
  limit?: number;
}

export interface RangeQuery {
  range: TimeRange;
  objectTypes?: string[];
  providerIds?: string[];
  region?: GeoRegion;
  /** Applied after ordering by observedAt ascending. */
  limit?: number;
}

export interface TypeAvailability {
  objectType: string;
  ranges: TimeRange[];
}

export interface TypeCounts {
  objectType: string;
  /** Distinct objectIds. */
  objects: number;
  rows: number;
}

export interface BackendDiagnostics {
  kind: string;
  status: 'ok' | 'degraded' | 'error';
  partitions: number;
  sizeBytes: number;
  message?: string;
  details?: Record<string, JsonValue>;
}

export interface HistoryBackend {
  readonly kind: string;
  open(): Promise<void>;
  /** Make everything appended so far durable (index commit, Parquet roll). */
  flush(): Promise<void>;
  close(): Promise<void>;

  /** Append rows to one partition. Rows must all belong to `key`. Returns the updated partition metadata. */
  append(key: PartitionKey, rows: HistoryRow[]): Promise<AppendResult>;
  listPartitions(filter?: PartitionFilter): Promise<PartitionMeta[]>;
  readPartition(key: PartitionKey): Promise<ReadResult>;
  deletePartition(key: PartitionKey): Promise<boolean>;
  /** Replace a partition's rows (retention rewrite). `originalRows` is carried so nothing disappears without a record. */
  rewritePartition(key: PartitionKey, rows: HistoryRow[], meta: RewriteMeta): Promise<PartitionMeta>;
  /**
   * Rewrite a partition keeping the first row of each fingerprint, streaming rather than
   * loading it whole, and mark it deduped. Undefined when the partition is gone, or has
   * more than `maxDistinct` distinct rows (then it is marked and left as it is). Optional:
   * the store falls back to read + rewrite for small partitions.
   */
  /**
   * Thin (and optionally strip `rawPayloadHash` from) a partition streaming: `plan` gets
   * the rows' columns and says which to keep. Optional: the store falls back to
   * read + downsampleRows + rewrite for partitions small enough to hold.
   */
  thinPartition?(
    key: PartitionKey,
    opts: { plan: (cols: ThinColumns) => ThinPlan; stripRaw: boolean; meta: RewriteMeta },
  ): Promise<{ rowsBefore: number; rowsAfter: number; stripped: number; partition: PartitionMeta } | undefined>;
  dedupePartition?(
    key: PartitionKey,
    fingerprint: (row: HistoryRow) => number,
    opts: { maxDistinct: number; at: IsoTimestamp },
  ): Promise<DedupeResult | undefined>;

  /** Latest row per objectId with observedAt ≤ cursor and ≥ cursor − lookback. Sorted by objectId. */
  objectsAt(cursor: IsoTimestamp, opts: ObjectsAtOptions): Promise<HistoryRow[]>;
  /** All rows for one object within range, observedAt ascending. */
  track(objectId: string, range: TimeRange): Promise<HistoryRow[]>;
  /** Availability windows per type, derived from partition metadata only. */
  availability(objectTypes?: string[]): Promise<TypeAvailability[]>;
  counts(query: RangeQuery): Promise<TypeCounts[]>;
  /** Rows in range (observedAt ascending), optional type/provider/region filters and limit. */
  observationsInRange(query: RangeQuery): Promise<HistoryRow[]>;

  diagnostics(): Promise<BackendDiagnostics>;
}

/** Thrown when a backend cannot be used at all (native module missing, failed to load). Store falls back to NDJSON. */
export class HistoryBackendUnavailableError extends Error {
  readonly code = 'HISTORY_BACKEND_UNAVAILABLE' as const;
  constructor(
    readonly backend: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`history backend "${backend}" unavailable: ${reason}`, options);
    this.name = 'HistoryBackendUnavailableError';
  }
}

export function isHistoryBackendUnavailable(err: unknown): err is HistoryBackendUnavailableError {
  return (
    err instanceof HistoryBackendUnavailableError ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'HISTORY_BACKEND_UNAVAILABLE')
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
