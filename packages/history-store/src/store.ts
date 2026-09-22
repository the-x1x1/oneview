import {
  DEFAULT_FRESHNESS_POLICIES,
  regionBounds,
  regionContains,
  systemClock,
  type Clock,
  type GeoBounds,
  type IsoTimestamp,
  type JsonValue,
  type Observation,
  type TimeRange,
  type WorldObject,
  type WorldQuery,
  type WorldQueryResult,
} from '@worldview/world-model';
import type { ProviderDataPolicy } from '@worldview/provider-sdk';
import { IdentityResolver, defaultIdentityResolver } from '@worldview/identity';
import { silentLogger, type Logger } from '@worldview/core';
import type { TrackPoint } from '@worldview/state-engine';
import type { ObservationBatch } from '@worldview/provider-runtime';
import { observationToRow, type HistoryRow } from './row.js';
import { partitionId, partitionKeyFor, type PartitionKey, type PartitionMeta } from './partition.js';
import {
  errorMessage,
  type BackendDiagnostics,
  type HistoryBackend,
  type ObjectsAtOptions,
  type RangeQuery,
  type TypeAvailability,
  type TypeCounts,
} from './backend.js';
import {
  INDEFINITE,
  USER_DATA_PROVIDER_IDS,
  downsampleRows,
  effectiveRetentionSeconds,
  retentionPolicyFor,
  stripRawHash,
  tierForAge,
  type RetentionOverrides,
  type RetentionPolicy,
  type RetentionSeconds,
} from './retention.js';
import { rowToWorldObject, type ProviderInfoResolver } from './reconstruct.js';

/**
 * HistoryStore — the facade every other package talks to (ADR-005).
 *
 *   write path: ObservationBatch → policy gate → rows → bounded queue → backend.append
 *   read path:  objectsAt / track / availability / counts / observationsInRange / queryObjects
 *   janitor:    sweepRetention(now) → delete expired partitions, tiered downsampling rewrite
 *
 * Writes never block the caller: `writeBatch` returns synchronously after queueing;
 * a single drain loop appends in the background; failures are logged and counted.
 */
export interface HistoryStoreOptions {
  dataDir: string;
  backend: HistoryBackend;
  clock?: Clock;
  logger?: Logger;
  /** Data policy per provider (from the manifest). Providers without one are not persisted. */
  policies: (providerId: string) => ProviderDataPolicy | undefined;
  /** Per-object-type overrides merged over DEFAULT_RETENTION_POLICIES. */
  retention?: RetentionOverrides;
  identity?: IdentityResolver;
  /** Partition slot width in minutes (default 60 → one file per provider/type/hour). */
  slotMinutes?: number;
  /** Rows the write queue may hold before new rows are dropped (counted, logged). */
  maxQueuedRows?: number;
  /** Per-type lookback (seconds) used when reconstructing a snapshot at a cursor. */
  snapshotLookbackSeconds?: Readonly<Record<string, number>>;
  /** Source names/attribution for provenance of reconstructed objects. */
  providerInfo?: ProviderInfoResolver;
  /** Set by createHistoryBackend when the requested backend was replaced by a fallback. */
  requestedBackend?: string;
  fallbackReason?: string;
}

export interface WriteReceipt {
  providerId: string;
  /** Rows accepted into the queue. */
  queued: number;
  skippedByPolicy: number;
  skippedByRetention: number;
  invalid: number;
  /** Rows dropped because the queue was full. */
  dropped: number;
}

export interface HistoryStoreStats {
  queuedRows: number;
  writtenRows: number;
  droppedRows: number;
  failedAppends: number;
  failedRows: number;
  skippedByPolicy: number;
  skippedByRetention: number;
  invalidObservations: number;
  lastError?: string;
  lastErrorAt?: IsoTimestamp;
}

export interface SweepReport {
  at: IsoTimestamp;
  deleted: PartitionMeta[];
  rewritten: Array<{
    partition: PartitionMeta;
    tier: number;
    rowsBefore: number;
    rowsAfter: number;
    rawStripped: number;
  }>;
  /** Partitions left untouched because their provider has no data policy right now (never destroyed on missing information). */
  skipped: Array<{ partition: string; reason: string }>;
  errors: Array<{ partition: string; error: string }>;
}

export interface HistoryDiagnostics extends BackendDiagnostics {
  requestedBackend: string;
  fallbackReason?: string;
  stats: HistoryStoreStats;
}

export interface SnapshotOptions {
  objectTypes?: string[];
  providerIds?: string[];
  bounds?: GeoBounds;
  /** Overrides the per-type default lookback. */
  lookbackSeconds?: number;
  limit?: number;
}

interface QueueItem {
  key: PartitionKey;
  rows: HistoryRow[];
}

const DEFAULT_SNAPSHOT_LOOKBACK = 30 * 86_400;

export class HistoryStore {
  readonly dataDir: string;
  readonly backend: HistoryBackend;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly policies: (providerId: string) => ProviderDataPolicy | undefined;
  private readonly retention: RetentionOverrides | undefined;
  private readonly identity: IdentityResolver;
  private readonly slotMinutes: number;
  private readonly maxQueuedRows: number;
  private readonly lookbacks: Readonly<Record<string, number>>;
  private readonly providerInfo: ProviderInfoResolver | undefined;
  private readonly requestedBackend: string;
  private readonly fallbackReason: string | undefined;

  private readonly queue = new Map<string, QueueItem>();
  private draining: Promise<void> | undefined;
  private closed = false;
  private lastOverflowLogAt = 0;
  private readonly warnedProviders = new Set<string>();
  private readonly stats: HistoryStoreStats = {
    queuedRows: 0,
    writtenRows: 0,
    droppedRows: 0,
    failedAppends: 0,
    failedRows: 0,
    skippedByPolicy: 0,
    skippedByRetention: 0,
    invalidObservations: 0,
  };

  constructor(opts: HistoryStoreOptions) {
    this.dataDir = opts.dataDir;
    this.backend = opts.backend;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.logger ?? silentLogger;
    this.policies = opts.policies;
    this.retention = opts.retention;
    this.identity = opts.identity ?? defaultIdentityResolver;
    this.slotMinutes = opts.slotMinutes ?? 60;
    this.maxQueuedRows = opts.maxQueuedRows ?? 50_000;
    this.lookbacks = opts.snapshotLookbackSeconds ?? {};
    this.providerInfo = opts.providerInfo;
    this.requestedBackend = opts.requestedBackend ?? opts.backend.kind;
    this.fallbackReason = opts.fallbackReason;
  }

  async open(): Promise<void> {
    await this.backend.open();
  }

  /** Drain the queue, then close the backend. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.backend.close();
  }

  // ---- write path -----------------------------------------------------------

  /** Queue a provider batch for persistence. Synchronous; never throws for data problems. */
  writeBatch(batch: ObservationBatch): WriteReceipt {
    const receipt: WriteReceipt = {
      providerId: batch.providerId,
      queued: 0,
      skippedByPolicy: 0,
      skippedByRetention: 0,
      invalid: 0,
      dropped: 0,
    };
    if (this.closed) {
      receipt.dropped = batch.observations.length;
      this.stats.droppedRows += receipt.dropped;
      return receipt;
    }
    const policy = this.policies(batch.providerId);
    if (!policy || !policy.normalizedRetentionAllowed) {
      receipt.skippedByPolicy = batch.observations.length;
      this.stats.skippedByPolicy += receipt.skippedByPolicy;
      if (!this.warnedProviders.has(batch.providerId)) {
        this.warnedProviders.add(batch.providerId);
        this.log.info('history: provider not persisted by policy', {
          providerId: batch.providerId,
          reason: policy ? 'normalizedRetentionAllowed=false' : 'no data policy',
        });
      }
      return receipt;
    }
    const includeRawHash = policy.rawPayloadRetentionAllowed;
    const grouped = new Map<string, QueueItem>();
    for (const obs of batch.observations) {
      if (obs.providerId !== batch.providerId) {
        receipt.invalid++;
        continue;
      }
      const retain = this.effectiveRetention(obs.objectType, batch.providerId, policy);
      if (retain === 0) {
        receipt.skippedByRetention++;
        continue;
      }
      let row: HistoryRow;
      let key: PartitionKey;
      try {
        row = observationToRow(obs, this.identity.resolve(obs).objectId, { includeRawHash });
        key = partitionKeyFor(obs.objectType, obs.providerId, row.observedAt, this.slotMinutes);
      } catch (err) {
        receipt.invalid++;
        this.log.debug('history: observation not persisted', { observationId: obs.id, error: errorMessage(err) });
        continue;
      }
      const id = partitionId(key);
      let item = grouped.get(id);
      if (!item) {
        item = { key, rows: [] };
        grouped.set(id, item);
      }
      item.rows.push(row);
    }
    this.stats.skippedByRetention += receipt.skippedByRetention;
    this.stats.invalidObservations += receipt.invalid;
    for (const [id, item] of grouped) {
      const room = this.maxQueuedRows - this.stats.queuedRows;
      if (room <= 0) {
        receipt.dropped += item.rows.length;
        continue;
      }
      const accepted = item.rows.length > room ? item.rows.slice(0, room) : item.rows;
      receipt.dropped += item.rows.length - accepted.length;
      const existing = this.queue.get(id);
      if (existing) existing.rows.push(...accepted);
      else this.queue.set(id, { key: item.key, rows: accepted });
      this.stats.queuedRows += accepted.length;
      receipt.queued += accepted.length;
    }
    if (receipt.dropped > 0) {
      this.stats.droppedRows += receipt.dropped;
      const now = this.clock.now();
      if (now - this.lastOverflowLogAt >= 10_000) {
        this.lastOverflowLogAt = now;
        this.log.warn('history: write queue full, rows dropped', {
          providerId: batch.providerId,
          dropped: receipt.dropped,
          queuedRows: this.stats.queuedRows,
          maxQueuedRows: this.maxQueuedRows,
        });
      }
    }
    if (receipt.queued > 0) this.kick();
    return receipt;
  }

  /** Wait until every queued row has been handed to the backend (written or failed) and the backend made it durable. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
    try {
      await this.backend.flush();
    } catch (err) {
      this.stats.lastError = errorMessage(err);
      this.stats.lastErrorAt = this.nowIso();
      this.log.error('history: backend flush failed', { error: this.stats.lastError });
    }
  }

  getStats(): HistoryStoreStats {
    return { ...this.stats };
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.size > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.size > 0) {
      const first = this.queue.entries().next();
      if (first.done) return;
      const [id, item] = first.value;
      this.queue.delete(id);
      this.stats.queuedRows -= item.rows.length;
      try {
        const result = await this.backend.append(item.key, item.rows);
        this.stats.writtenRows += result.rows;
      } catch (err) {
        this.stats.failedAppends++;
        this.stats.failedRows += item.rows.length;
        this.stats.lastError = errorMessage(err);
        this.stats.lastErrorAt = this.nowIso();
        this.log.error('history: append failed', {
          partition: id,
          rows: item.rows.length,
          error: this.stats.lastError,
        });
      }
    }
  }

  // ---- retention ------------------------------------------------------------

  retentionPolicyFor(objectType: string): RetentionPolicy {
    return retentionPolicyFor(objectType, this.retention);
  }

  effectiveRetention(
    objectType: string,
    providerId: string,
    policy: ProviderDataPolicy | undefined = this.policies(providerId),
  ): RetentionSeconds {
    return effectiveRetentionSeconds(this.retentionPolicyFor(objectType), policy, providerId);
  }

  /**
   * Delete partitions older than their effective retention and downsample/strip
   * partitions that crossed a tier boundary. Errors are per partition; the sweep
   * continues and reports them.
   */
  async sweepRetention(now: number = this.clock.now()): Promise<SweepReport> {
    const report: SweepReport = {
      at: new Date(now).toISOString(),
      deleted: [],
      rewritten: [],
      skipped: [],
      errors: [],
    };
    const partitions = await this.backend.listPartitions();
    for (const meta of partitions) {
      const policy = this.retentionPolicyFor(meta.objectType);
      const dataPolicy = this.policies(meta.providerId);
      if (!dataPolicy && !USER_DATA_PROVIDER_IDS.includes(meta.providerId)) {
        // A provider that is not registered right now must not have its history destroyed on missing information.
        report.skipped.push({ partition: meta.id, reason: 'no data policy for provider' });
        continue;
      }
      const retain = this.effectiveRetention(meta.objectType, meta.providerId, dataPolicy);
      const ageSeconds = (now - Date.parse(meta.maxObservedAt)) / 1000;
      try {
        if (retain !== INDEFINITE && ageSeconds > retain) {
          await this.backend.deletePartition(meta);
          report.deleted.push(meta);
          continue;
        }
        const targetTier = tierForAge(policy, ageSeconds);
        const currentTier = meta.downsampleTier ?? 0;
        const wantStrip =
          policy.rawSeconds !== undefined && ageSeconds > policy.rawSeconds && meta.rawStripped !== true;
        if (targetTier <= currentTier && !wantStrip) continue;
        const { rows } = await this.backend.readPartition(meta);
        const before = rows.length;
        const tiers = policy.downsample ?? [];
        const thinned = targetTier > currentTier ? downsampleRows(rows, tiers, targetTier) : { rows, removed: 0 };
        const stripped = wantStrip ? stripRawHash(thinned.rows) : 0;
        const tier = Math.max(targetTier, currentTier);
        const next = await this.backend.rewritePartition(meta, thinned.rows, {
          originalRows: meta.originalRows,
          ...(tier > 0 ? { downsampleTier: tier } : {}),
          ...(wantStrip || meta.rawStripped ? { rawStripped: true } : {}),
        });
        report.rewritten.push({
          partition: next,
          tier,
          rowsBefore: before,
          rowsAfter: thinned.rows.length,
          rawStripped: stripped,
        });
      } catch (err) {
        report.errors.push({ partition: meta.id, error: errorMessage(err) });
        this.log.error('history: retention step failed', { partition: meta.id, error: errorMessage(err) });
      }
    }
    if (report.deleted.length || report.rewritten.length) {
      this.log.info('history: retention sweep', {
        deleted: report.deleted.length,
        rewritten: report.rewritten.length,
        errors: report.errors.length,
      });
    }
    return report;
  }

  // ---- queries --------------------------------------------------------------

  /** Latest row per object with observedAt ≤ cursor within the lookback window. */
  objectsAt(cursor: IsoTimestamp, opts: ObjectsAtOptions): Promise<HistoryRow[]> {
    return this.backend.objectsAt(cursor, opts);
  }

  async track(objectId: string, range: TimeRange): Promise<TrackPoint[]> {
    const rows = await this.backend.track(objectId, range);
    const out: TrackPoint[] = [];
    for (const r of rows) {
      if (r.lat === undefined || r.lon === undefined) continue;
      out.push({
        observedAt: r.observedAt,
        latitude: r.lat,
        longitude: r.lon,
        ...(r.altitudeM !== undefined ? { altitudeM: r.altitudeM } : {}),
      });
    }
    return out;
  }

  availability(objectTypes?: string[]): Promise<TypeAvailability[]> {
    return this.backend.availability(objectTypes);
  }

  counts(query: RangeQuery): Promise<TypeCounts[]> {
    return this.backend.counts(query);
  }

  /** Rows for a WorldQuery with a time range (query.time required). */
  observationsInRange(query: WorldQuery): Promise<HistoryRow[]> {
    if (!query.time) throw new Error('observationsInRange requires query.time');
    return this.backend.observationsInRange(this.toRangeQuery(query, query.time));
  }

  /** WorldObjects as they were known at `cursor` (freshness HISTORICAL, origin 'historical'). */
  async snapshotAt(cursor: IsoTimestamp, opts: SnapshotOptions = {}): Promise<WorldObject[]> {
    const types = opts.objectTypes;
    const groups = new Map<number, string[] | undefined>();
    if (opts.lookbackSeconds !== undefined || !types)
      groups.set(opts.lookbackSeconds ?? this.lookbackFor(undefined), types);
    else
      for (const t of types) {
        const lb = this.lookbackFor(t);
        const list = groups.get(lb);
        if (list) list.push(t);
        else groups.set(lb, [t]);
      }
    const rows: HistoryRow[] = [];
    for (const [lookbackSeconds, objectTypes] of groups) {
      const q: ObjectsAtOptions = {
        lookbackSeconds,
        ...(objectTypes ? { objectTypes } : {}),
        ...(opts.providerIds ? { providerIds: opts.providerIds } : {}),
        ...(opts.bounds ? { bounds: opts.bounds } : {}),
      };
      rows.push(...(await this.backend.objectsAt(cursor, q)));
    }
    rows.sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
    const limited = opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
    return limited.map((r) => rowToWorldObject(r, this.identity, this.providerInfo));
  }

  /** Serves `history.query`: objects known at query.time.end (or now), region/type/provider filtered. */
  async queryObjects(query: WorldQuery): Promise<WorldQueryResult<WorldObject>> {
    const cursor = query.time?.end ?? this.nowIso();
    const bounds = query.region ? regionBounds(query.region) : undefined;
    const lookback = query.time
      ? Math.max(0, (Date.parse(query.time.end) - Date.parse(query.time.start)) / 1000)
      : undefined;
    const objects = await this.snapshotAt(cursor, {
      ...(query.objectTypes ? { objectTypes: query.objectTypes } : {}),
      ...(query.providerIds ? { providerIds: query.providerIds } : {}),
      ...(bounds ? { bounds } : {}),
      ...(lookback !== undefined ? { lookbackSeconds: lookback } : {}),
    });
    const region = query.region;
    const filtered = region
      ? objects.filter((o) => o.position !== undefined && regionContains(region, o.position))
      : objects;
    const limit = query.limit;
    const items = limit !== undefined ? filtered.slice(0, limit) : filtered;
    return {
      items,
      total: filtered.length,
      truncated: items.length < filtered.length,
      basis: 'historical',
      evaluatedAt: this.nowIso(),
    };
  }

  async diagnostics(): Promise<HistoryDiagnostics> {
    let base: BackendDiagnostics;
    try {
      base = await this.backend.diagnostics();
    } catch (err) {
      base = { kind: this.backend.kind, status: 'error', partitions: 0, sizeBytes: 0, message: errorMessage(err) };
    }
    const d: HistoryDiagnostics = { ...base, requestedBackend: this.requestedBackend, stats: this.getStats() };
    if (this.fallbackReason !== undefined) {
      d.fallbackReason = this.fallbackReason;
      if (d.status === 'ok') d.status = 'degraded';
      if (!d.message) d.message = `fallback from ${this.requestedBackend}: ${this.fallbackReason}`;
    }
    if (this.stats.failedAppends > 0 && d.status === 'ok') {
      d.status = 'degraded';
      d.message = `append failures: ${this.stats.failedAppends}`;
    }
    return d;
  }

  /** Convenience for tests and tools: build a batch from observations. */
  static batchOf(providerId: string, observations: Observation[], receivedAt: IsoTimestamp): ObservationBatch {
    return { providerId, observations, snapshot: false, receivedAt, rejected: 0 };
  }

  private lookbackFor(objectType: string | undefined): number {
    if (objectType === undefined) return DEFAULT_SNAPSHOT_LOOKBACK;
    return (
      this.lookbacks[objectType] ?? DEFAULT_FRESHNESS_POLICIES[objectType]?.expireSeconds ?? DEFAULT_SNAPSHOT_LOOKBACK
    );
  }

  private toRangeQuery(query: WorldQuery, range: TimeRange): RangeQuery {
    return {
      range,
      ...(query.objectTypes ? { objectTypes: query.objectTypes } : {}),
      ...(query.providerIds ? { providerIds: query.providerIds } : {}),
      ...(query.region ? { region: query.region } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    };
  }

  private nowIso(): IsoTimestamp {
    return new Date(this.clock.now()).toISOString();
  }
}

export function statsToJson(stats: HistoryStoreStats): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(stats)) as Record<string, JsonValue>;
}
