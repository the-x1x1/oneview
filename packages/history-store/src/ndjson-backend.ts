import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { IsoTimestamp, TimeRange } from '@worldview/world-model';
import { writeFileAtomic } from '@worldview/core/node';
import type { Logger } from '@worldview/core';
import { silentLogger } from '@worldview/core';
import { lineToRow, rowToLine, type HistoryRow } from './row.js';
import {
  PartitionIndex,
  assertValidPartitionKey,
  parsePartitionRelativePath,
  partitionFilePath,
  partitionId,
  partitionRelativePath,
  reconcileIndex,
  type IndexFileEntry,
  type PartitionFilter,
  type PartitionKey,
  type PartitionMeta,
  type ReconcileReport,
} from './partition.js';
import type {
  AppendResult,
  BackendDiagnostics,
  DedupeResult,
  HistoryBackend,
  ObjectsAtOptions,
  RangeQuery,
  ReadResult,
  RewriteMeta,
  TypeAvailability,
  TypeCounts,
} from './backend.js';
import type { ThinColumns, ThinPlan } from './retention.js';
import {
  availabilityFromMetas,
  scanCounts,
  scanObjectsAt,
  scanObservationsInRange,
  scanTrack,
} from './scan-queries.js';

export interface NdjsonBackendOptions {
  dataDir: string;
  logger?: Logger;
  /** Partitions of one type closer than this are reported as one contiguous availability range. */
  availabilityGapSeconds?: number;
  clock?: { now(): number };
}

export const NDJSON_EXT = 'ndjson';

/**
 * NdjsonBackend — dependency-free history storage.
 *
 *   history/<objectType>/<YYYY>/<MM>/<DD>/<providerId>-<HHMM>.ndjson   one JSON row per line, append-only
 *   history/index.json                                                partition metadata, atomic
 *
 * Appends are a single appendFile per partition; the index is committed atomically
 * only after the append succeeded (a crash between the two leaves rows the next
 * `rebuildIndex()` picks up, never a corrupt index). Reads stream line by line and
 * count malformed lines instead of failing.
 */
export class NdjsonBackend implements HistoryBackend {
  readonly kind = 'ndjson';
  readonly historyRoot: string;
  private readonly index: PartitionIndex;
  private readonly log: Logger;
  private readonly gapMs: number;
  private readonly clock: { now(): number };
  private opened = false;
  private malformedTotal = 0;
  private indexIssues: string[] = [];

  constructor(opts: NdjsonBackendOptions) {
    this.historyRoot = path.join(opts.dataDir, 'history');
    this.log = opts.logger ?? silentLogger;
    this.index = new PartitionIndex(this.historyRoot, this.kind, {
      onWriteError: (err) => this.log.error('history index write failed', { error: (err as Error).message }),
    });
    this.gapMs = (opts.availabilityGapSeconds ?? 3600) * 1000;
    this.clock = opts.clock ?? { now: () => Date.now() };
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await fs.mkdir(this.historyRoot, { recursive: true });
    const { loaded, issues } = await this.index.load();
    this.indexIssues = issues;
    for (const issue of issues) this.log.warn('history index issue', { issue });
    const report = await this.reconcile();
    if (report.added || report.updated || report.removed) {
      this.log.warn(
        loaded ? 'history index reconciled with partition files' : 'history index rebuilt from partition files',
        { added: report.added, updated: report.updated, removed: report.removed },
      );
      await this.index.flush();
    }
    this.opened = true;
  }

  async flush(): Promise<void> {
    await this.index.flush();
  }

  async close(): Promise<void> {
    await this.index.flush();
    this.opened = false;
  }

  private async ensureOpen(): Promise<void> {
    if (!this.opened) await this.open();
  }

  async append(key: PartitionKey, rows: HistoryRow[]): Promise<AppendResult> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    const id = partitionId(key);
    const existing = this.index.get(id);
    if (rows.length === 0) {
      return { rows: 0, bytes: 0, partition: existing ?? this.emptyMeta(key) };
    }
    let min = rows[0]!.observedAt,
      max = rows[0]!.observedAt;
    const lines: string[] = [];
    for (const r of rows) {
      if (r.objectType !== key.objectType || r.providerId !== key.providerId)
        throw new Error(`row ${r.observationId} does not belong to partition ${id}`);
      if (r.observedAt < min) min = r.observedAt;
      if (r.observedAt > max) max = r.observedAt;
      lines.push(rowToLine(r));
    }
    const data = lines.join('\n') + '\n';
    const file = partitionFilePath(this.historyRoot, key, NDJSON_EXT);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, data, 'utf8');
    const bytes = Buffer.byteLength(data, 'utf8');
    const meta: PartitionMeta = existing
      ? {
          ...existing,
          minObservedAt: min < existing.minObservedAt ? min : existing.minObservedAt,
          maxObservedAt: max > existing.maxObservedAt ? max : existing.maxObservedAt,
          rows: existing.rows + rows.length,
          originalRows: existing.originalRows + rows.length,
          bytes: existing.bytes + bytes,
          updatedAt: this.nowIso(),
        }
      : {
          ...this.emptyMeta(key),
          minObservedAt: min,
          maxObservedAt: max,
          rows: rows.length,
          originalRows: rows.length,
          bytes,
        };
    this.index.upsert(meta);
    return { rows: rows.length, bytes, partition: meta };
  }

  async listPartitions(filter?: PartitionFilter): Promise<PartitionMeta[]> {
    await this.ensureOpen();
    return this.index.list(filter);
  }

  async readPartition(key: PartitionKey): Promise<ReadResult> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    const result = await readNdjsonFile(partitionFilePath(this.historyRoot, key, NDJSON_EXT));
    if (result.malformed > 0) {
      this.malformedTotal += result.malformed;
      this.log.warn('malformed history rows skipped', { partition: partitionId(key), malformed: result.malformed });
    }
    return result;
  }

  async deletePartition(key: PartitionKey): Promise<boolean> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    const id = partitionId(key);
    const file = partitionFilePath(this.historyRoot, key, NDJSON_EXT);
    await fs.rm(file, { force: true });
    const removed = this.index.remove(id);
    await pruneEmptyDirs(path.dirname(file), this.historyRoot);
    return removed;
  }

  async rewritePartition(key: PartitionKey, rows: HistoryRow[], meta: RewriteMeta): Promise<PartitionMeta> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    const id = partitionId(key);
    const existing = this.index.get(id);
    if (rows.length === 0) {
      // An empty partition is no partition: drop the file and the entry instead of keeping a hollow shell.
      await this.deletePartition(key);
      return {
        ...(existing ?? this.emptyMeta(key)),
        rows: 0,
        bytes: 0,
        originalRows: meta.originalRows,
        updatedAt: this.nowIso(),
      };
    }
    const file = partitionFilePath(this.historyRoot, key, NDJSON_EXT);
    const data = rows.map(rowToLine).join('\n') + '\n';
    await writeFileAtomic(file, data);
    let min = rows[0]!.observedAt,
      max = rows[0]!.observedAt;
    for (const r of rows) {
      if (r.observedAt < min) min = r.observedAt;
      if (r.observedAt > max) max = r.observedAt;
    }
    const next: PartitionMeta = {
      ...(existing ?? this.emptyMeta(key)),
      minObservedAt: min,
      maxObservedAt: max,
      rows: rows.length,
      originalRows: Math.max(meta.originalRows, rows.length),
      bytes: Buffer.byteLength(data, 'utf8'),
      updatedAt: this.nowIso(),
      ...(meta.downsampleTier !== undefined ? { downsampleTier: meta.downsampleTier } : {}),
      ...(meta.rawStripped !== undefined ? { rawStripped: meta.rawStripped } : {}),
      ...(meta.dedupedAt !== undefined ? { dedupedAt: meta.dedupedAt } : {}),
    };
    this.index.upsert(next);
    return next;
  }

  /**
   * Two streaming passes: the first reads each row's object, time, ordinal and origin into
   * columns (tens of bytes a row, where holding the rows would be the whole payload); the
   * second writes the kept lines, numbered, to a sibling file renamed over the original.
   * An hour of 6,000 aircraft every ten seconds is two million rows — held whole, several
   * gigabytes in the main process.
   */
  async thinPartition(
    key: PartitionKey,
    opts: { plan: (cols: ThinColumns) => ThinPlan; stripRaw: boolean; meta: RewriteMeta },
  ): Promise<{ rowsBefore: number; rowsAfter: number; stripped: number; partition: PartitionMeta } | undefined> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    const id = partitionId(key);
    const existing = this.index.get(id);
    if (!existing) return undefined;
    const file = partitionFilePath(this.historyRoot, key, NDJSON_EXT);

    let cap = Math.max(1024, existing.rows + 1024);
    let cols: ThinColumns = {
      length: 0,
      objectKey: new Int32Array(cap),
      time: new Float64Array(cap),
      seq: new Int32Array(cap),
      user: new Uint8Array(cap),
    };
    const grow = () => {
      cap *= 2;
      const next: ThinColumns = {
        length: cols.length,
        objectKey: new Int32Array(cap),
        time: new Float64Array(cap),
        seq: new Int32Array(cap),
        user: new Uint8Array(cap),
      };
      next.objectKey.set(cols.objectKey);
      next.time.set(cols.time);
      next.seq.set(cols.seq);
      next.user.set(cols.user);
      cols = next;
    };
    const keys = new Map<string, number>();
    const valid: number[] = [];
    let lineNo = 0;
    let malformed = 0;
    try {
      for await (const line of createInterface({
        input: createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })) {
        if (!line.trim()) continue;
        const n = lineNo++;
        const row = lineToRow(line);
        if (!row) {
          malformed++;
          continue;
        }
        if (cols.length === cap) grow();
        const i = cols.length++;
        let k = keys.get(row.objectId);
        if (k === undefined) keys.set(row.objectId, (k = keys.size));
        cols.objectKey[i] = k;
        cols.time[i] = Date.parse(row.observedAt);
        cols.seq[i] = row.seq ?? -1;
        cols.user[i] = row.origin === 'user' ? 1 : 0;
        valid.push(n);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const plan = opts.plan(cols);
    const rowsBefore = cols.length;
    keys.clear();

    const tmp = `${file}.thin-${process.pid}.tmp`;
    const out = createWriteStream(tmp, { encoding: 'utf8' });
    let rowsAfter = 0;
    let stripped = 0;
    let bytes = 0;
    let min: string | undefined;
    let max: string | undefined;
    try {
      let n = 0;
      let v = 0;
      for await (const line of createInterface({
        input: createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })) {
        if (!line.trim()) continue;
        const lineIndex = n++;
        if (valid[v] !== lineIndex) continue;
        const i = v++;
        if (!plan.keep[i]) continue;
        const row = lineToRow(line)!;
        if (plan.seq[i]! >= 0) row.seq = plan.seq[i]!;
        if (opts.stripRaw && row.rawPayloadHash !== undefined) {
          delete row.rawPayloadHash;
          stripped++;
        }
        const text = rowToLine(row) + '\n';
        rowsAfter++;
        bytes += Buffer.byteLength(text, 'utf8');
        if (min === undefined || row.observedAt < min) min = row.observedAt;
        if (max === undefined || row.observedAt > max) max = row.observedAt;
        if (!out.write(text)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    } catch (err) {
      out.destroy();
      await fs.rm(tmp, { force: true });
      throw err;
    }
    if (malformed) this.malformedTotal += malformed;
    if (rowsAfter === 0) {
      await fs.rm(tmp, { force: true });
      await this.deletePartition(key);
      return {
        rowsBefore,
        rowsAfter: 0,
        stripped,
        partition: { ...existing, rows: 0, bytes: 0, updatedAt: this.nowIso() },
      };
    }
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    const next: PartitionMeta = {
      ...existing,
      minObservedAt: min!,
      maxObservedAt: max!,
      rows: rowsAfter,
      originalRows: Math.max(opts.meta.originalRows, rowsAfter),
      bytes,
      updatedAt: this.nowIso(),
      ...(opts.meta.downsampleTier !== undefined ? { downsampleTier: opts.meta.downsampleTier } : {}),
      ...(opts.meta.rawStripped !== undefined ? { rawStripped: opts.meta.rawStripped } : {}),
      ...(opts.meta.dedupedAt !== undefined ? { dedupedAt: opts.meta.dedupedAt } : {}),
    };
    this.index.upsert(next);
    return { rowsBefore, rowsAfter, stripped, partition: next };
  }

  /**
   * Streams the partition to a sibling file keeping the first line of each fingerprint,
   * then renames it over the original. A satellite partition written before write-time
   * dedupe can be hundreds of megabytes of the same few thousand observations; this never
   * holds more than one line and a set of numbers in memory. Malformed lines are dropped
   * and counted, as a read would skip them.
   */
  async dedupePartition(
    key: PartitionKey,
    fingerprint: (row: HistoryRow) => number,
    opts: { maxDistinct: number; at: IsoTimestamp },
  ): Promise<DedupeResult | undefined> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    const id = partitionId(key);
    const existing = this.index.get(id);
    if (!existing) return undefined;
    const file = partitionFilePath(this.historyRoot, key, NDJSON_EXT);
    const tmp = `${file}.dedupe-${process.pid}.tmp`;
    const seen = new Set<number>();
    let rowsBefore = 0;
    let rowsAfter = 0;
    let bytesAfter = 0;
    let malformed = 0;
    let min: string | undefined;
    let max: string | undefined;
    let gaveUp = false;
    const out = createWriteStream(tmp, { encoding: 'utf8' });
    try {
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        rowsBefore++;
        const row = lineToRow(line);
        if (!row) {
          malformed++;
          continue;
        }
        const f = fingerprint(row);
        if (seen.has(f)) continue;
        if (seen.size >= opts.maxDistinct) {
          gaveUp = true;
          lines.close();
          input.destroy();
          break;
        }
        seen.add(f);
        rowsAfter++;
        if (min === undefined || row.observedAt < min) min = row.observedAt;
        if (max === undefined || row.observedAt > max) max = row.observedAt;
        const text = line + '\n';
        bytesAfter += Buffer.byteLength(text, 'utf8');
        if (!out.write(text)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    } catch (err) {
      out.destroy();
      await fs.rm(tmp, { force: true });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    if (malformed) this.malformedTotal += malformed;
    if (gaveUp || rowsAfter === 0) {
      // Too many distinct rows to be worth it, or nothing readable: leave the file, and do not ask again.
      await fs.rm(tmp, { force: true });
      this.index.upsert({ ...existing, dedupedAt: opts.at });
      return undefined;
    }
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    const next: PartitionMeta = {
      ...existing,
      minObservedAt: min!,
      maxObservedAt: max!,
      rows: rowsAfter,
      bytes: bytesAfter,
      updatedAt: this.nowIso(),
      dedupedAt: opts.at,
    };
    this.index.upsert(next);
    return { rowsBefore, rowsAfter, bytesBefore: existing.bytes, bytesAfter };
  }

  objectsAt(cursor: IsoTimestamp, opts: ObjectsAtOptions): Promise<HistoryRow[]> {
    return scanObjectsAt(this, cursor, opts);
  }
  track(objectId: string, range: TimeRange): Promise<HistoryRow[]> {
    return scanTrack(this, objectId, range);
  }
  async availability(objectTypes?: string[]): Promise<TypeAvailability[]> {
    return availabilityFromMetas(
      await this.listPartitions(objectTypes ? { objectTypes } : undefined),
      objectTypes,
      this.gapMs,
    );
  }
  counts(query: RangeQuery): Promise<TypeCounts[]> {
    return scanCounts(this, query);
  }
  observationsInRange(query: RangeQuery): Promise<HistoryRow[]> {
    return scanObservationsInRange(this, query);
  }

  async diagnostics(): Promise<BackendDiagnostics> {
    await this.ensureOpen();
    const d: BackendDiagnostics = {
      kind: this.kind,
      status: this.indexIssues.length ? 'degraded' : 'ok',
      partitions: this.index.size(),
      sizeBytes: this.index.totalBytes(),
      details: {
        historyRoot: this.historyRoot,
        indexFile: this.index.path,
        malformedRowsSkipped: this.malformedTotal,
        indexIssues: this.indexIssues,
      },
    };
    if (this.indexIssues.length) d.message = this.indexIssues[0]!;
    return d;
  }

  /** Bring index.json in line with the row files (lost/corrupt index, crash inside the index write window). */
  async reconcile(): Promise<ReconcileReport> {
    const files: IndexFileEntry[] = [];
    for (const rel of await walkFiles(this.historyRoot)) {
      const key = parsePartitionRelativePath(rel, NDJSON_EXT);
      if (!key) continue;
      const stat = await fs.stat(path.join(this.historyRoot, ...rel.split('/')));
      files.push({ key, rel, bytes: stat.size });
    }
    return reconcileIndex(
      this.index,
      files,
      async (key) => (await readNdjsonFile(partitionFilePath(this.historyRoot, key, NDJSON_EXT))).rows,
      this.nowIso(),
    );
  }

  private emptyMeta(key: PartitionKey): PartitionMeta {
    return {
      ...key,
      id: partitionId(key),
      minObservedAt: '',
      maxObservedAt: '',
      rows: 0,
      originalRows: 0,
      bytes: 0,
      updatedAt: this.nowIso(),
    };
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  filePathFor(key: PartitionKey): string {
    return partitionFilePath(this.historyRoot, key, NDJSON_EXT);
  }
  relativePathFor(key: PartitionKey): string {
    return partitionRelativePath(key, NDJSON_EXT);
  }
}

/** Stream an NDJSON file; malformed lines are counted and skipped. Missing file → empty. */
export async function readNdjsonFile(file: string): Promise<ReadResult> {
  const rows: HistoryRow[] = [];
  let malformed = 0;
  let stream;
  try {
    await fs.access(file);
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch {
    return { rows, malformed };
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const row = lineToRow(line);
      if (row) rows.push(row);
      else malformed++;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { rows, malformed };
}

export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  }
  await walk(root, '');
  return out.sort();
}

/** Remove now-empty day/month/year directories after a partition delete (stops at the history root). */
export async function pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let current = dir;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length) return;
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
