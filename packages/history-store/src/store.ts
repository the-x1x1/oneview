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
  planThinning,
  retentionPolicyFor,
  stripRawHash,
  tierForAge,
  type RetentionOverrides,
  type RetentionPolicy,
  type RetentionSeconds,
} from './retention.js';
import { rowToWorldObject, type ProviderInfoResolver } from './reconstruct.js';
import { observationFingerprint, rowFingerprint } from './dedupe.js';

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
  /** The same observation, unchanged, as the one last written for its object (dedupe.ts). */
  skippedUnchanged: number;
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
  /** Observations not written because they repeated the one last written for their object. */
  skippedUnchanged: number;
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
  /** Partitions rewritten without their repeated rows (the one-time cleanup of pre-dedupe history). */
  deduped: Array<{ partition: string; rowsBefore: number; rowsAfter: number; bytesBefore: number; bytesAfter: number }>;
  /** Partitions deleted, oldest first, to bring history under the operator's size cap. */
  capped: PartitionMeta[];
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
/** Objects whose last-written fingerprint is remembered; past this the memory starts over (one repeat each). */
const MAX_REMEMBERED_OBJECTS = 500_000;
/** Past this many distinct observations the streaming dedupe gives up on a partition (memory). */
const DEDUPE_MAX_DISTINCT = 2_000_000;
const DEDUPE_IN_MEMORY_MAX_BYTES = 64 * 1024 * 1024;
/** A backend without streaming rewrites holds a partition whole; past this it is left for the size cap. */
const REWRITE_IN_MEMORY_MAX_BYTES = 256 * 1024 * 1024;

export interface HistoryUsage {
  bytes: number;
  partitions: number;
  maxBytes?: number;
  byType: Array<{ objectType: string; bytes: number; rows: number; partitions: number }>;
  /** Observations not written since start because they repeated their object's last one. */
  skippedUnchanged: number;
}

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
    skippedUnchanged: 0,
  };
  /** The fingerprint of the observation last written per object (dedupe.ts); bounded. */
  private readonly lastWritten = new Map<string, number>();
  private maxBytes: number | undefined;
  /** Held while a partition is read and rewritten or deleted, so no append lands in between. */
  private exclusive: Promise<void> | undefined;
  private appending: Promise<unknown> | undefined;
  private sweeping = 0;

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
      skippedUnchanged: 0,
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
      const fingerprint = observationFingerprint(row, obs.rawPayloadHash);
      if (this.lastWritten.get(row.objectId) === fingerprint) {
        receipt.skippedUnchanged++;
        continue;
      }
      if (this.lastWritten.size >= MAX_REMEMBERED_OBJECTS) this.lastWritten.clear();
      this.lastWritten.set(row.objectId, fingerprint);
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
    this.stats.skippedUnchanged += receipt.skippedUnchanged;
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
      while (this.exclusive) await this.exclusive;
      const first = this.queue.entries().next();
      if (first.done) return;
      const [id, item] = first.value;
      this.queue.delete(id);
      this.stats.queuedRows -= item.rows.length;
      try {
        // Checked and started in one synchronous step, so withExclusive either sees this
        // append in flight or runs entirely before it.
        const pending = this.backend.append(item.key, item.rows);
        this.appending = pending;
        const result = await pending;
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
      } finally {
        this.appending = undefined;
      }
    }
  }

  /** Run `fn` with no append in flight and none starting until it finishes. */
  private async withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusive) await this.exclusive;
    let release!: () => void;
    this.exclusive = new Promise<void>((r) => (release = r));
    try {
      if (this.appending) await this.appending.catch(() => undefined);
      return await fn();
    } finally {
      this.exclusive = undefined;
      release();
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
    this.sweeping++;
    try {
      return await this.sweepOnce(now);
    } finally {
      this.sweeping--;
    }
  }

  private async sweepOnce(now: number): Promise<SweepReport> {
    const report: SweepReport = {
      at: new Date(now).toISOString(),
      deleted: [],
      rewritten: [],
      skipped: [],
      errors: [],
      deduped: [],
      capped: [],
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
          await this.withExclusive(() => this.backend.deletePartition(meta));
          report.deleted.push(meta);
          continue;
        }
        const targetTier = tierForAge(policy, ageSeconds);
        const currentTier = meta.downsampleTier ?? 0;
        const wantStrip =
          policy.rawSeconds !== undefined && ageSeconds > policy.rawSeconds && meta.rawStripped !== true;
        if (targetTier > currentTier || wantStrip) {
          await this.withExclusive(async () => {
            const current = (await this.backend.listPartitions()).find((m) => m.id === meta.id) ?? meta;
            const tiers = policy.downsample ?? [];
            const tier = Math.max(targetTier, currentTier);
            const rewriteMeta = {
              originalRows: current.originalRows,
              ...(tier > 0 ? { downsampleTier: tier } : {}),
              ...(wantStrip || current.rawStripped ? { rawStripped: true } : {}),
              ...(current.dedupedAt ? { dedupedAt: current.dedupedAt } : {}),
            };
            if (this.backend.thinPartition) {
              const r = await this.backend.thinPartition(current, {
                plan: (cols) => planThinning(cols, tiers, targetTier > currentTier ? targetTier : 0),
                stripRaw: wantStrip,
                meta: rewriteMeta,
              });
              if (r)
                report.rewritten.push({
                  partition: r.partition,
                  tier,
                  rowsBefore: r.rowsBefore,
                  rowsAfter: r.rowsAfter,
                  rawStripped: r.stripped,
                });
              return;
            }
            if (current.bytes > REWRITE_IN_MEMORY_MAX_BYTES) {
              report.skipped.push({ partition: current.id, reason: 'too large to rewrite in memory' });
              return;
            }
            const { rows } = await this.backend.readPartition(current);
            const before = rows.length;
            const thinned = targetTier > currentTier ? downsampleRows(rows, tiers, targetTier) : { rows, removed: 0 };
            const stripped = wantStrip ? stripRawHash(thinned.rows) : 0;
            const next = await this.backend.rewritePartition(current, thinned.rows, rewriteMeta);
            report.rewritten.push({
              partition: next,
              tier,
              rowsBefore: before,
              rowsAfter: thinned.rows.length,
              rawStripped: stripped,
            });
          });
          continue;
        }
        if (this.needsDedupe(meta, policy)) {
          const done = await this.withExclusive(() => this.dedupe(meta, now));
          if (done) report.deduped.push(done);
        }
      } catch (err) {
        report.errors.push({ partition: meta.id, error: errorMessage(err) });
        this.log.error('history: retention step failed', { partition: meta.id, error: errorMessage(err) });
      }
    }
    report.capped = await this.capToSize(now, report.errors);
    if (report.deleted.length || report.rewritten.length || report.deduped.length || report.capped.length) {
      const saved = report.deduped.reduce((n, d) => n + d.bytesBefore - d.bytesAfter, 0);
      this.log.info('history: retention sweep', {
        deleted: report.deleted.length,
        rewritten: report.rewritten.length,
        deduped: report.deduped.length,
        dedupedMb: Math.round(saved / 1048576),
        capped: report.capped.length,
        errors: report.errors.length,
      });
    }
    return report;
  }

  /**
   * The operator's cap on history's size on disk (Settings → History); undefined is none.
   * Checked by every sweep and by `enforceSizeCap`, which the runtime also runs on its own
   * shorter timer.
   */
  setMaxBytes(bytes: number | undefined): void {
    this.maxBytes = bytes !== undefined && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  }

  /**
   * Over the cap, delete whole partitions, oldest first, until history is at 90 % of it.
   * Never the operator's own data and never a type kept indefinitely (earthquakes,
   * infrastructure, airports): the cap trades away old tracks and satellite passes, not
   * records. Returns what it deleted.
   */
  async enforceSizeCap(now: number = this.clock.now()): Promise<PartitionMeta[]> {
    // A sweep in progress may be about to dedupe what is over the cap; it enforces the cap
    // itself when it finishes, after the dedupe rather than instead of it.
    if (this.sweeping > 0) return [];
    return this.capToSize(now, []);
  }

  private async capToSize(now: number, errors: SweepReport['errors']): Promise<PartitionMeta[]> {
    const cap = this.maxBytes;
    if (cap === undefined) return [];
    const partitions = await this.backend.listPartitions();
    let total = partitions.reduce((n, m) => n + m.bytes, 0);
    if (total <= cap) return [];
    const target = cap * 0.9;
    const candidates = partitions
      .filter((m) => {
        if (USER_DATA_PROVIDER_IDS.includes(m.providerId)) return false;
        const policy = this.policies(m.providerId);
        if (!policy) return false;
        return this.effectiveRetention(m.objectType, m.providerId, policy) !== INDEFINITE;
      })
      .sort((a, b) => (a.maxObservedAt < b.maxObservedAt ? -1 : a.maxObservedAt > b.maxObservedAt ? 1 : 0));
    const deleted: PartitionMeta[] = [];
    for (const meta of candidates) {
      if (total <= target) break;
      try {
        await this.withExclusive(() => this.backend.deletePartition(meta));
        total -= meta.bytes;
        deleted.push(meta);
      } catch (err) {
        errors.push({ partition: meta.id, error: errorMessage(err) });
      }
    }
    if (deleted.length)
      this.log.info('history: size cap reached, oldest partitions deleted', {
        deleted: deleted.length,
        freedMb: Math.round(deleted.reduce((n, m) => n + m.bytes, 0) / 1048576),
        capMb: Math.round(cap / 1048576),
        nowMb: Math.round(total / 1048576),
        oldest: deleted[0]!.minObservedAt,
        at: new Date(now).toISOString(),
      });
    return deleted;
  }

  /**
   * History written before write-time dedupe holds the same observation many times over
   * (satellites: every 15 s). Each such partition is rewritten once without the repeats.
   * Movement types are left to their downsampling tiers — their rows are nearly all
   * distinct.
   *
   * Recently written partitions are not made to wait: the rewrite runs with no append in
   * flight (withExclusive), and dedupe runs before the size cap in the same sweep. An
   * earlier version waited ten minutes after a partition's last write — which, two minutes
   * after an upgrade, was every satellite partition the previous build had been appending
   * to, so the cap deleted 8 GB of them that the dedupe would have compacted.
   */
  private needsDedupe(meta: PartitionMeta, policy: RetentionPolicy): boolean {
    return !meta.dedupedAt && (policy.downsample?.length ?? 0) === 0;
  }

  private async dedupe(meta: PartitionMeta, now: number): Promise<SweepReport['deduped'][number] | undefined> {
    const at = new Date(now).toISOString();
    if (this.backend.dedupePartition) {
      const r = await this.backend.dedupePartition(meta, rowFingerprint, { maxDistinct: DEDUPE_MAX_DISTINCT, at });
      return r && { partition: meta.id, ...r };
    }
    // A backend without a streaming rewrite (DuckDB) gets the in-memory one, for partitions small enough.
    if (meta.bytes > DEDUPE_IN_MEMORY_MAX_BYTES) return undefined;
    const { rows } = await this.backend.readPartition(meta);
    const seen = new Set<number>();
    const kept = rows.filter((r) => {
      const f = rowFingerprint(r);
      if (seen.has(f)) return false;
      seen.add(f);
      return true;
    });
    const next = await this.backend.rewritePartition(meta, kept, {
      originalRows: meta.originalRows,
      ...(meta.downsampleTier !== undefined ? { downsampleTier: meta.downsampleTier } : {}),
      ...(meta.rawStripped ? { rawStripped: true } : {}),
      dedupedAt: at,
    });
    return {
      partition: meta.id,
      rowsBefore: rows.length,
      rowsAfter: kept.length,
      bytesBefore: meta.bytes,
      bytesAfter: next.bytes,
    };
  }

  /** Bytes, rows and partitions per object type, for Settings and Diagnostics. */
  async usage(): Promise<HistoryUsage> {
    const byType = new Map<string, { objectType: string; bytes: number; rows: number; partitions: number }>();
    let bytes = 0;
    let partitions = 0;
    for (const m of await this.backend.listPartitions()) {
      const t = byType.get(m.objectType) ?? { objectType: m.objectType, bytes: 0, rows: 0, partitions: 0 };
      t.bytes += m.bytes;
      t.rows += m.rows;
      t.partitions++;
      byType.set(m.objectType, t);
      bytes += m.bytes;
      partitions++;
    }
    return {
      bytes,
      partitions,
      ...(this.maxBytes !== undefined ? { maxBytes: this.maxBytes } : {}),
      byType: [...byType.values()].sort((a, b) => b.bytes - a.bytes),
      skippedUnchanged: this.stats.skippedUnchanged,
    };
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
