import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GeoBounds, IsoTimestamp, JsonValue, TimeRange } from '@worldview/world-model';
import { regionBounds } from '@worldview/world-model';
import { writeFileAtomic } from '@worldview/core/node';
import { silentLogger, type Logger } from '@worldview/core';
import { HISTORY_ROW_COLUMNS, compactRow, rowToLine, type HistoryRow, type HistoryRowColumn } from './row.js';
import {
  PartitionIndex, assertValidPartitionKey, parsePartitionRelativePath, partitionFilePath, partitionId, partitionRelativePath, reconcileIndex,
  type IndexFileEntry, type PartitionFilter, type PartitionKey, type PartitionMeta, type ReconcileReport,
} from './partition.js';
import {
  HistoryBackendUnavailableError, errorMessage,
  type AppendResult, type BackendDiagnostics, type HistoryBackend, type ObjectsAtOptions, type RangeQuery, type ReadResult, type RewriteMeta, type TypeAvailability, type TypeCounts,
} from './backend.js';
import { readNdjsonFile, walkFiles, pruneEmptyDirs } from './ndjson-backend.js';
import {
  availabilityFromMetas, countsToList, inRange, lookbackRange, rangeFilter, reduceCounts, reduceLatestPerObject, rowInBounds, rowMatchesRange, sortByObjectId, sortByObservedAt,
} from './scan-queries.js';

/** The slice of `@duckdb/node-api` this backend uses (see tools/dev/type-shims/@duckdb__node-api). */
export type DuckDbModule = typeof import('@duckdb/node-api');
type DuckDbConnection = Awaited<ReturnType<DuckDbModule['DuckDBInstance']['prototype']['connect']>>;
type DuckDbInstance = Awaited<ReturnType<DuckDbModule['DuckDBInstance']['create']>>;

export const DUCKDB_BACKEND_KIND = 'duckdb-parquet';
export const PARQUET_EXT = 'parquet';
export const STAGING_EXT = 'staging.ndjson';

export interface DuckDbParquetBackendOptions {
  dataDir: string;
  logger?: Logger;
  clock?: { now(): number };
  /** Roll a partition's staging NDJSON into Parquet after this many rows … */
  rollRows?: number;
  /** … or this many seconds since the first unrolled append. */
  rollSeconds?: number;
  availabilityGapSeconds?: number;
  /** DuckDB database path; ':memory:' (default) is enough because all data lives in Parquet files. */
  databasePath?: string;
  /** Test hook: alternative module loader. */
  loadModule?: () => Promise<DuckDbModule>;
}

const COLUMN_TYPES: Readonly<Record<HistoryRowColumn, string>> = Object.freeze({
  observationId: 'VARCHAR', objectId: 'VARCHAR', providerId: 'VARCHAR', objectType: 'VARCHAR', observedAt: 'VARCHAR', receivedAt: 'VARCHAR',
  lat: 'DOUBLE', lon: 'DOUBLE', altitudeM: 'DOUBLE', payloadJson: 'VARCHAR', rawPayloadHash: 'VARCHAR', origin: 'VARCHAR',
  externalId: 'VARCHAR', geometryJson: 'VARCHAR', sourceQuality: 'VARCHAR', seq: 'BIGINT',
});

const ident = (c: string): string => `"${c.replace(/"/g, '""')}"`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const COLS = HISTORY_ROW_COLUMNS.map(ident).join(', ');
const NDJSON_COLUMNS = `{${HISTORY_ROW_COLUMNS.map((c) => `${lit(c)}: ${lit(COLUMN_TYPES[c])}`).join(', ')}}`;
const toDuckPath = (p: string): string => p.split(path.sep).join('/');

/**
 * DuckDbParquetBackend — history in Parquet, queried by DuckDB (ADR-005).
 *
 *   history/<objectType>/<YYYY>/<MM>/<DD>/<providerId>-<HHMM>.parquet          rolled rows (GeoParquet-friendly)
 *   history/<objectType>/<YYYY>/<MM>/<DD>/<providerId>-<HHMM>.staging.ndjson   rows appended since the last roll
 *   history/index.json                                                          shared partition index
 *
 * Appends go to the staging file (cheap, append-only); every `rollRows` rows or
 * `rollSeconds` seconds the staging file is folded into the partition's Parquet file
 * with `COPY (…) TO … (FORMAT PARQUET)` and an atomic rename. Reads run SQL over the
 * Parquet files selected by the index and merge rows still in staging, so nothing is
 * invisible between rolls. The native module is imported lazily; when it cannot be
 * loaded, `open()` throws HistoryBackendUnavailableError and the caller falls back to
 * NdjsonBackend (recorded in diagnostics).
 */
export class DuckDbParquetBackend implements HistoryBackend {
  readonly kind = DUCKDB_BACKEND_KIND;
  readonly historyRoot: string;
  private readonly index: PartitionIndex;
  private readonly log: Logger;
  private readonly clock: { now(): number };
  private readonly rollRows: number;
  private readonly rollMs: number;
  private readonly gapMs: number;
  private readonly databasePath: string;
  private readonly loadModule: () => Promise<DuckDbModule>;
  private instance: DuckDbInstance | undefined;
  private connection: DuckDbConnection | undefined;
  private spatial: { loaded: boolean; reason?: string } = { loaded: false };
  private opened = false;
  private malformedTotal = 0;
  private readonly staging = new Map<string, { rows: number; since: number }>();
  private rolling: Promise<void> = Promise.resolve();

  constructor(opts: DuckDbParquetBackendOptions) {
    this.historyRoot = path.join(opts.dataDir, 'history');
    this.log = opts.logger ?? silentLogger;
    this.index = new PartitionIndex(this.historyRoot, this.kind, { onWriteError: (err) => this.log.error('history index write failed', { error: errorMessage(err) }) });
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.rollRows = opts.rollRows ?? 5000;
    this.rollMs = (opts.rollSeconds ?? 60) * 1000;
    this.gapMs = (opts.availabilityGapSeconds ?? 3600) * 1000;
    this.databasePath = opts.databasePath ?? ':memory:';
    this.loadModule = opts.loadModule ?? defaultLoader;
  }

  spatialExtension(): { loaded: boolean; reason?: string } { return this.spatial; }

  async open(): Promise<void> {
    if (this.opened) return;
    const mod = await this.loadModule();
    try {
      this.instance = await mod.DuckDBInstance.create(this.databasePath);
      this.connection = await this.instance.connect();
    } catch (err) {
      throw new HistoryBackendUnavailableError(this.kind, `cannot open DuckDB: ${errorMessage(err)}`, { cause: err });
    }
    const json = await this.tryLoadExtension('json');
    if (!json.loaded) throw new HistoryBackendUnavailableError(this.kind, `DuckDB json extension unavailable: ${json.reason ?? 'unknown'}`);
    this.spatial = await this.tryLoadExtension('spatial');
    if (!this.spatial.loaded) this.log.info('history: DuckDB spatial extension not loaded; Parquet written without WKB geometry', { reason: this.spatial.reason ?? 'unknown' });
    await fs.mkdir(this.historyRoot, { recursive: true });
    const { loaded, issues } = await this.index.load();
    for (const issue of issues) this.log.warn('history index issue', { issue });
    const report = await this.reconcile();
    if (report.added || report.updated || report.removed) {
      this.log.warn(loaded ? 'history index reconciled with partition files' : 'history index rebuilt from partition files', { added: report.added, updated: report.updated, removed: report.removed });
    }
    this.opened = true;
    await this.rollAll('startup');
    await this.index.flush();
  }

  async flush(): Promise<void> {
    await this.rollAll('flush');
    await this.rolling;
    await this.index.flush();
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    await this.flush();
    try { this.connection?.closeSync(); } catch { /* best effort */ }
    try { this.instance?.closeSync(); } catch { /* best effort */ }
    this.connection = undefined;
    this.instance = undefined;
    this.opened = false;
  }

  private async ensureOpen(): Promise<void> { if (!this.opened) await this.open(); }

  // ---- writes ---------------------------------------------------------------

  async append(key: PartitionKey, rows: HistoryRow[]): Promise<AppendResult> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    const id = partitionId(key);
    const existing = this.index.get(id);
    if (rows.length === 0) return { rows: 0, bytes: 0, partition: existing ?? this.emptyMeta(key) };
    let min = rows[0]!.observedAt, max = rows[0]!.observedAt;
    const lines: string[] = [];
    for (const r of rows) {
      if (r.objectType !== key.objectType || r.providerId !== key.providerId) throw new Error(`row ${r.observationId} does not belong to partition ${id}`);
      if (r.observedAt < min) min = r.observedAt;
      if (r.observedAt > max) max = r.observedAt;
      lines.push(rowToLine(r));
    }
    const data = lines.join('\n') + '\n';
    const stagingFile = this.file(key, STAGING_EXT);
    await fs.mkdir(path.dirname(stagingFile), { recursive: true });
    await fs.appendFile(stagingFile, data, 'utf8');
    const bytes = Buffer.byteLength(data, 'utf8');
    const meta: PartitionMeta = existing
      ? { ...existing, minObservedAt: min < existing.minObservedAt ? min : existing.minObservedAt, maxObservedAt: max > existing.maxObservedAt ? max : existing.maxObservedAt, rows: existing.rows + rows.length, originalRows: existing.originalRows + rows.length, bytes: existing.bytes + bytes, updatedAt: this.nowIso() }
      : { ...this.emptyMeta(key), minObservedAt: min, maxObservedAt: max, rows: rows.length, originalRows: rows.length, bytes };
    meta.files = withFile(meta.files, partitionRelativePath(key, STAGING_EXT));
    this.index.upsert(meta);
    const s = this.staging.get(id) ?? { rows: 0, since: this.clock.now() };
    s.rows += rows.length;
    this.staging.set(id, s);
    if (s.rows >= this.rollRows || this.clock.now() - s.since >= this.rollMs) await this.roll(key);
    return { rows: rows.length, bytes, partition: this.index.get(id) ?? meta };
  }

  /** Fold staging rows into the partition's Parquet file (atomic replace). */
  async roll(key: PartitionKey): Promise<void> {
    const run = async () => {
      const id = partitionId(key);
      const stagingFile = this.file(key, STAGING_EXT);
      const parquetFile = this.file(key, PARQUET_EXT);
      const tmpFile = `${parquetFile}.${process.pid}.${this.clock.now()}.tmp`;
      let stagingExists = true;
      try { const st = await fs.stat(stagingFile); stagingExists = st.size > 0; } catch { stagingExists = false; }
      if (!stagingExists) { this.staging.delete(id); return; }
      const parquetExists = await exists(parquetFile);
      const sources = [
        ...(parquetExists ? [`SELECT ${COLS} FROM read_parquet(${lit(toDuckPath(parquetFile))}, union_by_name = true)`] : []),
        `SELECT ${COLS} FROM read_ndjson(${lit(toDuckPath(stagingFile))}, columns = ${NDJSON_COLUMNS}, ignore_errors = true)`,
      ].join(' UNION ALL ');
      const geometry = this.spatial.loaded ? `, CASE WHEN "lon" IS NOT NULL AND "lat" IS NOT NULL THEN ST_AsWKB(ST_Point("lon", "lat")) END AS "geometry"` : '';
      await this.exec(`COPY (SELECT ${COLS}${geometry} FROM (${sources}) ORDER BY "objectId", "observedAt") TO ${lit(toDuckPath(tmpFile))} (FORMAT PARQUET)`);
      await fs.rename(tmpFile, parquetFile);
      await fs.rm(stagingFile, { force: true });
      this.staging.delete(id);
      const meta = this.index.get(id);
      if (meta) {
        const stat = await fs.stat(parquetFile);
        this.index.upsert({ ...meta, bytes: stat.size, files: [partitionRelativePath(key, PARQUET_EXT)], updatedAt: this.nowIso() });
      }
    };
    this.rolling = this.rolling.then(run, run);
    return this.rolling;
  }

  /** Roll every partition with staging rows: at startup by scanning the tree (crash recovery), later from the in-memory staging set. */
  async rollAll(reason: 'startup' | 'flush' | 'close'): Promise<void> {
    const pending: PartitionKey[] = [];
    if (reason === 'startup') {
      for (const rel of await walkFiles(this.historyRoot)) {
        const key = parsePartitionRelativePath(rel, STAGING_EXT);
        if (key) pending.push(key);
      }
    } else {
      for (const id of this.staging.keys()) {
        const meta = this.index.get(id);
        if (meta) pending.push(meta);
      }
    }
    for (const key of pending) {
      try { await this.roll(key); } catch (err) { this.log.error('history: parquet roll failed', { partition: partitionId(key), reason, error: errorMessage(err) }); }
    }
  }

  async listPartitions(filter?: PartitionFilter): Promise<PartitionMeta[]> {
    await this.ensureOpen();
    return this.index.list(filter);
  }

  async readPartition(key: PartitionKey): Promise<ReadResult> {
    await this.ensureOpen();
    return this.readPartitionFiles(key);
  }

  /** Parquet rows (SQL) + staging rows (NDJSON scan); malformed records counted, never fatal. */
  private async readPartitionFiles(key: PartitionKey): Promise<ReadResult> {
    assertValidPartitionKey(key);
    const parquetFile = this.file(key, PARQUET_EXT);
    const rows: HistoryRow[] = [];
    let malformed = 0;
    if (await exists(parquetFile)) {
      for (const r of await this.query(`SELECT ${COLS} FROM read_parquet(${lit(toDuckPath(parquetFile))}, union_by_name = true)`)) {
        const row = compactRow(r);
        if (row) rows.push(row); else malformed++;
      }
    }
    const staged = await readNdjsonFile(this.file(key, STAGING_EXT));
    rows.push(...staged.rows);
    malformed += staged.malformed;
    if (malformed > 0) { this.malformedTotal += malformed; this.log.warn('malformed history rows skipped', { partition: partitionId(key), malformed }); }
    return { rows, malformed };
  }

  async deletePartition(key: PartitionKey): Promise<boolean> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    await this.rolling;
    const parquetFile = this.file(key, PARQUET_EXT);
    await fs.rm(parquetFile, { force: true });
    await fs.rm(this.file(key, STAGING_EXT), { force: true });
    this.staging.delete(partitionId(key));
    const removed = this.index.remove(partitionId(key));
    await pruneEmptyDirs(path.dirname(parquetFile), this.historyRoot);
    return removed;
  }

  async rewritePartition(key: PartitionKey, rows: HistoryRow[], meta: RewriteMeta): Promise<PartitionMeta> {
    await this.ensureOpen();
    assertValidPartitionKey(key);
    await this.rolling;
    const id = partitionId(key);
    const existing = this.index.get(id) ?? this.emptyMeta(key);
    if (rows.length === 0) {
      await this.deletePartition(key);
      return { ...existing, rows: 0, bytes: 0, originalRows: meta.originalRows, updatedAt: this.nowIso() };
    }
    const parquetFile = this.file(key, PARQUET_EXT);
    const stagingFile = this.file(key, STAGING_EXT);
    // Staging becomes the single source of truth, then the old Parquet is dropped and the partition re-rolled.
    await writeFileAtomic(stagingFile, rows.map(rowToLine).join('\n') + '\n');
    await fs.rm(parquetFile, { force: true });
    let min = rows[0]!.observedAt, max = rows[0]!.observedAt;
    for (const r of rows) { if (r.observedAt < min) min = r.observedAt; if (r.observedAt > max) max = r.observedAt; }
    const next: PartitionMeta = {
      ...existing, minObservedAt: min, maxObservedAt: max, rows: rows.length, originalRows: Math.max(meta.originalRows, rows.length),
      bytes: 0, files: [partitionRelativePath(key, STAGING_EXT)], updatedAt: this.nowIso(),
      ...(meta.downsampleTier !== undefined ? { downsampleTier: meta.downsampleTier } : {}),
      ...(meta.rawStripped !== undefined ? { rawStripped: meta.rawStripped } : {}),
    };
    this.index.upsert(next);
    this.staging.set(id, { rows: rows.length, since: 0 });
    await this.roll(key);
    return this.index.get(id) ?? next;
  }

  // ---- queries --------------------------------------------------------------

  async objectsAt(cursor: IsoTimestamp, opts: ObjectsAtOptions): Promise<HistoryRow[]> {
    await this.ensureOpen();
    const range = lookbackRange(cursor, opts.lookbackSeconds);
    const filter: PartitionFilter = { overlapping: range, ...(opts.objectTypes ? { objectTypes: opts.objectTypes } : {}), ...(opts.providerIds ? { providerIds: opts.providerIds } : {}) };
    const metas = this.index.list(filter);
    const latest = new Map<string, HistoryRow>();
    const parquet = await this.parquetFiles(metas);
    if (parquet.length) {
      const where = [`"observedAt" >= ${lit(range.start)}`, `"observedAt" <= ${lit(range.end)}`, ...(opts.bounds ? [boundsSql(opts.bounds)] : [])].join(' AND ');
      const sql = `SELECT ${COLS} FROM (SELECT ${COLS}, row_number() OVER (PARTITION BY "objectId" ORDER BY "observedAt" DESC, "receivedAt" DESC, "observationId" DESC) AS rn FROM read_parquet([${parquet.map((f) => lit(f)).join(', ')}], union_by_name = true) WHERE ${where}) WHERE rn = 1`;
      reduceLatestPerObject(this.toRows(await this.query(sql)), latest);
    }
    for (const meta of metas) {
      const staged = await this.stagingRows(meta);
      reduceLatestPerObject(staged.filter((r) => inRange(r, range) && rowInBounds(r, opts.bounds)), latest);
    }
    const out = sortByObjectId([...latest.values()]);
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  async track(objectId: string, range: TimeRange): Promise<HistoryRow[]> {
    await this.ensureOpen();
    const type = objectId.split(':')[0];
    const metas = this.index.list({ overlapping: range, ...(type ? { objectTypes: [type] } : {}) });
    const out: HistoryRow[] = [];
    const parquet = await this.parquetFiles(metas);
    if (parquet.length) {
      out.push(...this.toRows(await this.query(`SELECT ${COLS} FROM read_parquet([${parquet.map((f) => lit(f)).join(', ')}], union_by_name = true) WHERE "objectId" = ${lit(objectId)} AND "observedAt" >= ${lit(range.start)} AND "observedAt" <= ${lit(range.end)}`)));
    }
    for (const meta of metas) for (const r of await this.stagingRows(meta)) if (r.objectId === objectId && inRange(r, range)) out.push(r);
    return sortByObservedAt(out);
  }

  async availability(objectTypes?: string[]): Promise<TypeAvailability[]> {
    await this.ensureOpen();
    return availabilityFromMetas(this.index.list(objectTypes ? { objectTypes } : undefined), objectTypes, this.gapMs);
  }

  async counts(query: RangeQuery): Promise<TypeCounts[]> {
    await this.ensureOpen();
    const metas = this.index.list(rangeFilter(query));
    const acc = new Map<string, { objects: Set<string>; rows: number }>();
    const parquet = await this.parquetFiles(metas);
    if (parquet.length) {
      const bounds = query.region ? regionBounds(query.region) : undefined;
      const where = [`"observedAt" >= ${lit(query.range.start)}`, `"observedAt" <= ${lit(query.range.end)}`, ...(bounds ? [boundsSql(bounds)] : [])].join(' AND ');
      const needExact = query.region !== undefined && query.region.kind !== 'bounds';
      if (needExact) {
        reduceCounts(this.toRows(await this.query(`SELECT ${COLS} FROM read_parquet([${parquet.map((f) => lit(f)).join(', ')}], union_by_name = true) WHERE ${where}`)).filter((r) => rowMatchesRange(r, query)), acc);
      } else {
        for (const r of await this.query(`SELECT "objectType", "objectId", count(*) AS n FROM read_parquet([${parquet.map((f) => lit(f)).join(', ')}], union_by_name = true) WHERE ${where} GROUP BY 1, 2`)) {
          const objectType = String(r['objectType']), objectId = String(r['objectId']), n = Number(r['n'] ?? 0);
          let c = acc.get(objectType);
          if (!c) { c = { objects: new Set(), rows: 0 }; acc.set(objectType, c); }
          c.objects.add(objectId);
          c.rows += n;
        }
      }
    }
    for (const meta of metas) reduceCounts((await this.stagingRows(meta)).filter((r) => rowMatchesRange(r, query)), acc);
    return countsToList(acc, query.objectTypes);
  }

  async observationsInRange(query: RangeQuery): Promise<HistoryRow[]> {
    await this.ensureOpen();
    const metas = this.index.list(rangeFilter(query));
    const out: HistoryRow[] = [];
    const parquet = await this.parquetFiles(metas);
    if (parquet.length) {
      const bounds = query.region ? regionBounds(query.region) : undefined;
      const where = [`"observedAt" >= ${lit(query.range.start)}`, `"observedAt" <= ${lit(query.range.end)}`, ...(bounds ? [boundsSql(bounds)] : [])].join(' AND ');
      out.push(...this.toRows(await this.query(`SELECT ${COLS} FROM read_parquet([${parquet.map((f) => lit(f)).join(', ')}], union_by_name = true) WHERE ${where}`)).filter((r) => rowMatchesRange(r, query)));
    }
    for (const meta of metas) out.push(...(await this.stagingRows(meta)).filter((r) => rowMatchesRange(r, query)));
    sortByObservedAt(out);
    return query.limit !== undefined ? out.slice(0, query.limit) : out;
  }

  async diagnostics(): Promise<BackendDiagnostics> {
    await this.ensureOpen();
    const details: Record<string, JsonValue> = {
      historyRoot: this.historyRoot, indexFile: this.index.path, databasePath: this.databasePath,
      spatialExtension: this.spatial.loaded, ...(this.spatial.reason ? { spatialReason: this.spatial.reason } : {}),
      stagingPartitions: this.staging.size, malformedRowsSkipped: this.malformedTotal,
    };
    return { kind: this.kind, status: 'ok', partitions: this.index.size(), sizeBytes: this.index.totalBytes(), details };
  }

  /** Bring index.json in line with the Parquet + staging files on disk (lost index, crash inside the index write window). */
  async reconcile(): Promise<ReconcileReport> {
    const files: IndexFileEntry[] = [];
    for (const rel of await walkFiles(this.historyRoot)) {
      const ext = rel.endsWith(`.${STAGING_EXT}`) ? STAGING_EXT : rel.endsWith(`.${PARQUET_EXT}`) ? PARQUET_EXT : undefined;
      if (!ext) continue;
      const key = parsePartitionRelativePath(rel, ext);
      if (!key) continue;
      const stat = await fs.stat(path.join(this.historyRoot, ...rel.split('/')));
      files.push({ key, rel, bytes: stat.size });
    }
    return reconcileIndex(this.index, files, async (key) => (await this.readPartitionFiles(key)).rows, this.nowIso());
  }

  // ---- internals ------------------------------------------------------------

  private file(key: PartitionKey, ext: string): string { return partitionFilePath(this.historyRoot, key, ext); }

  private async parquetFiles(metas: PartitionMeta[]): Promise<string[]> {
    const out: string[] = [];
    for (const m of metas) {
      const f = this.file(m, PARQUET_EXT);
      if (await exists(f)) out.push(toDuckPath(f));
    }
    return out;
  }

  private async stagingRows(meta: PartitionMeta): Promise<HistoryRow[]> {
    const f = this.file(meta, STAGING_EXT);
    if (!(await exists(f))) return [];
    const r = await readNdjsonFile(f);
    if (r.malformed) this.malformedTotal += r.malformed;
    return r.rows;
  }

  private toRows(records: Record<string, unknown>[]): HistoryRow[] {
    const out: HistoryRow[] = [];
    for (const rec of records) {
      const row = compactRow(rec);
      if (row) out.push(row); else this.malformedTotal++;
    }
    return out;
  }

  private conn(): DuckDbConnection {
    if (!this.connection) throw new HistoryBackendUnavailableError(this.kind, 'connection not open');
    return this.connection;
  }

  private async exec(sql: string): Promise<void> { await this.conn().run(sql); }

  private async query(sql: string): Promise<Record<string, unknown>[]> {
    const reader = await this.conn().runAndReadAll(sql);
    return reader.getRowObjects() as Record<string, unknown>[];
  }

  private async tryLoadExtension(name: string): Promise<{ loaded: boolean; reason?: string }> {
    try { await this.exec(`LOAD ${name}`); return { loaded: true }; } catch (first) {
      try { await this.exec(`INSTALL ${name}`); await this.exec(`LOAD ${name}`); return { loaded: true }; } catch (second) {
        return { loaded: false, reason: `${errorMessage(first)}; install: ${errorMessage(second)}` };
      }
    }
  }

  private emptyMeta(key: PartitionKey): PartitionMeta {
    return { ...key, id: partitionId(key), minObservedAt: '', maxObservedAt: '', rows: 0, originalRows: 0, bytes: 0, updatedAt: this.nowIso() };
  }

  private nowIso(): string { return new Date(this.clock.now()).toISOString(); }
}

async function defaultLoader(): Promise<DuckDbModule> {
  try {
    return await import('@duckdb/node-api');
  } catch (err) {
    throw new HistoryBackendUnavailableError(DUCKDB_BACKEND_KIND, `cannot load @duckdb/node-api: ${errorMessage(err)}`, { cause: err });
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

function withFile(files: string[] | undefined, rel: string): string[] {
  return files?.includes(rel) ? files : [...(files ?? []), rel];
}

function boundsSql(b: GeoBounds): string {
  const lat = `"lat" >= ${b.south} AND "lat" <= ${b.north}`;
  const lon = b.west <= b.east ? `"lon" >= ${b.west} AND "lon" <= ${b.east}` : `("lon" >= ${b.west} OR "lon" <= ${b.east})`;
  return `(${lat} AND ${lon})`;
}
