import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IsoTimestamp, JsonValue, TimeRange } from '@worldview/world-model';
import { writeFileAtomic, readJsonFile } from '@worldview/core/node';

/**
 * Partition layout (ADR-005):
 *
 *   history/<objectType>/<YYYY>/<MM>/<DD>/<providerId>-<HHMM>.<ext>
 *
 * A partition is one (objectType, providerId, UTC day, time slot) cell. The slot is the
 * start of the bucket the observation's `observedAt` falls in (default 60-minute slots
 * → HH00). Keys are derived from observedAt, not receipt time, so a time query can prune
 * partitions from the index alone.
 */
export interface PartitionKey {
  objectType: string;
  providerId: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** UTC slot start within the day, HHMM. */
  slot: string;
}

export interface PartitionMeta extends PartitionKey {
  /** `<objectType>/<day>/<providerId>-<slot>` */
  id: string;
  minObservedAt: IsoTimestamp;
  maxObservedAt: IsoTimestamp;
  /** Rows currently stored. */
  rows: number;
  /** Rows ever written. `originalRows - rows` is exactly what downsampling and dedupe removed. */
  originalRows: number;
  bytes: number;
  /** 0/undefined = full resolution; n = tier n of the type's downsampling schedule was applied. */
  downsampleTier?: number;
  /** rawPayloadHash has been stripped from this partition by retention. */
  rawStripped?: boolean;
  /** When repeated observations were removed from it (history written before write-time dedupe). */
  dedupedAt?: IsoTimestamp;
  /** Backend-specific files relative to the history root (Parquet + staging), when more than the canonical one. */
  files?: string[];
  updatedAt: IsoTimestamp;
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_RE = /^\d{4}$/;

export function partitionId(key: PartitionKey): string {
  return `${key.objectType}/${key.day}/${key.providerId}-${key.slot}`;
}

export function parsePartitionId(id: string): PartitionKey | undefined {
  const m = /^([^/]+)\/(\d{4}-\d{2}-\d{2})\/(.+)-(\d{4})$/.exec(id);
  if (!m) return undefined;
  const key = { objectType: m[1]!, day: m[2]!, providerId: m[3]!, slot: m[4]! };
  return isValidPartitionKey(key) ? key : undefined;
}

export function isValidPartitionKey(key: PartitionKey): boolean {
  return (
    SAFE_SEGMENT.test(key.objectType) &&
    SAFE_SEGMENT.test(key.providerId) &&
    DAY_RE.test(key.day) &&
    SLOT_RE.test(key.slot)
  );
}

export function assertValidPartitionKey(key: PartitionKey): void {
  if (!isValidPartitionKey(key)) throw new Error(`invalid partition key ${JSON.stringify(key)}`);
}

/** Slot start for an observedAt (UTC), e.g. 60-minute slots → "0800", "0900". */
export function partitionKeyFor(
  objectType: string,
  providerId: string,
  observedAt: IsoTimestamp,
  slotMinutes = 60,
): PartitionKey {
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) throw new Error(`invalid observedAt "${observedAt}"`);
  const d = new Date(ms);
  const minutesOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const slotStart = Math.floor(minutesOfDay / slotMinutes) * slotMinutes;
  const hh = String(Math.floor(slotStart / 60)).padStart(2, '0');
  const mm = String(slotStart % 60).padStart(2, '0');
  return {
    objectType,
    providerId,
    day: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    slot: `${hh}${mm}`,
  };
}

/** Relative path under the history root: `<objectType>/<YYYY>/<MM>/<DD>/<providerId>-<HHMM>.<ext>` */
export function partitionRelativePath(key: PartitionKey, ext: string): string {
  const [yyyy, mm, dd] = key.day.split('-');
  return path.posix.join(key.objectType, yyyy!, mm!, dd!, `${key.providerId}-${key.slot}.${ext}`);
}

export function partitionFilePath(historyRoot: string, key: PartitionKey, ext: string): string {
  return path.join(historyRoot, ...partitionRelativePath(key, ext).split('/'));
}

/**
 * A Parquet file may carry a generation (`opensky-0800.g3.parquet`). A partition's
 * Parquet is never rewritten in place: each roll writes the next generation and the
 * previous one is deleted afterwards. DuckDB caches file contents by path and serves a
 * stale view when the bytes behind a path change — reading a replaced file produced
 * "No magic bytes found at end of file" on Windows — so a path, once written, is
 * immutable. Generation 0 has no suffix, which is what existing installations hold.
 */
export function partitionParquetName(key: PartitionKey, generation: number): string {
  return generation === 0
    ? `${key.providerId}-${key.slot}.parquet`
    : `${key.providerId}-${key.slot}.g${generation}.parquet`;
}

/** The generation encoded in a partition file name, or undefined when it is not one. */
export function partitionGeneration(file: string, ext: string): number | undefined {
  const suffix = `.${ext}`;
  if (!file.endsWith(suffix)) return undefined;
  const base = file.slice(0, -suffix.length);
  const m = /^(.+)-(\d{4})(?:\.g(\d+))?$/.exec(base);
  if (!m) return undefined;
  return m[3] === undefined ? 0 : Number(m[3]);
}

/** Inverse of partitionRelativePath; undefined for files that are not partitions (index, temp, staging). */
export function parsePartitionRelativePath(rel: string, ext: string): PartitionKey | undefined {
  const parts = rel.split('/');
  if (parts.length !== 5) return undefined;
  const [objectType, yyyy, mm, dd, file] = parts as [string, string, string, string, string];
  const suffix = `.${ext}`;
  if (!file.endsWith(suffix)) return undefined;
  const base = file.slice(0, -suffix.length);
  const m = /^(.+)-(\d{4})(?:\.g\d+)?$/.exec(base);
  if (!m) return undefined;
  const key = { objectType, providerId: m[1]!, day: `${yyyy}-${mm}-${dd}`, slot: m[2]! };
  return isValidPartitionKey(key) ? key : undefined;
}

export interface PartitionFilter {
  objectTypes?: string[];
  providerIds?: string[];
  /** Keep partitions whose [minObservedAt, maxObservedAt] intersects this range. */
  overlapping?: TimeRange;
}

export function partitionMatches(meta: PartitionMeta, filter: PartitionFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.objectTypes && !filter.objectTypes.includes(meta.objectType)) return false;
  if (filter.providerIds && !filter.providerIds.includes(meta.providerId)) return false;
  if (filter.overlapping) {
    if (meta.maxObservedAt < filter.overlapping.start || meta.minObservedAt > filter.overlapping.end) return false;
  }
  return true;
}

// ---- index file ---------------------------------------------------------------

interface PartitionIndexFile {
  version: 1;
  backend: string;
  partitions: PartitionMeta[];
}

export interface PartitionIndexOptions {
  /** Coalesce index writes: metadata changes within this window are committed in one atomic write. */
  debounceMs?: number;
  onWriteError?: (err: unknown) => void;
}

/**
 * `history/index.json` — one small atomic file with every partition's metadata.
 * Availability, pruning and retention decisions read only this file; row files are
 * opened only for actual row reads.
 *
 * Mutations update memory immediately and schedule one coalesced, serialised, atomic
 * write (temp + fsync + rename); `flush()` forces it. A crash inside the window leaves
 * row files ahead of the index, which `reconcileIndex()` repairs at the next open by
 * comparing file sizes with the recorded bytes — so the index never claims rows that
 * are not on disk, and rows on disk are never orphaned.
 */
export class PartitionIndex {
  private readonly file: string;
  private readonly entries = new Map<string, PartitionMeta>();
  private readonly debounceMs: number;
  private readonly onWriteError: ((err: unknown) => void) | undefined;
  private chain: Promise<void> = Promise.resolve();
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  private writeError: string | undefined;

  constructor(
    historyRoot: string,
    private readonly backend: string,
    opts: PartitionIndexOptions = {},
  ) {
    this.file = path.join(historyRoot, 'index.json');
    this.debounceMs = opts.debounceMs ?? 100;
    this.onWriteError = opts.onWriteError;
  }

  get path(): string {
    return this.file;
  }
  get lastWriteError(): string | undefined {
    return this.writeError;
  }

  async load(): Promise<{ loaded: boolean; issues: string[] }> {
    const issues: string[] = [];
    this.entries.clear();
    let data: unknown;
    try {
      data = await readJsonFile(this.file);
    } catch (err) {
      issues.push(`index unreadable: ${(err as Error).message}`);
    }
    if (data !== undefined) {
      const parsed = data as Partial<PartitionIndexFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.partitions)) issues.push('index has unknown format');
      else
        for (const p of parsed.partitions) {
          if (isPartitionMeta(p)) this.entries.set(p.id, p);
          else issues.push(`index entry skipped: ${JSON.stringify(p).slice(0, 120)}`);
        }
    }
    this.loaded = true;
    return { loaded: data !== undefined, issues };
  }

  isLoaded(): boolean {
    return this.loaded;
  }
  get(id: string): PartitionMeta | undefined {
    return this.entries.get(id);
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  size(): number {
    return this.entries.size;
  }

  list(filter?: PartitionFilter): PartitionMeta[] {
    const out: PartitionMeta[] = [];
    for (const m of this.entries.values()) if (partitionMatches(m, filter)) out.push(m);
    return out.sort((a, b) =>
      a.minObservedAt < b.minObservedAt ? -1 : a.minObservedAt > b.minObservedAt ? 1 : a.id.localeCompare(b.id),
    );
  }

  totalBytes(): number {
    let n = 0;
    for (const m of this.entries.values()) n += m.bytes;
    return n;
  }

  upsert(meta: PartitionMeta): void {
    this.entries.set(meta.id, meta);
    this.markDirty();
  }

  remove(id: string): boolean {
    const had = this.entries.delete(id);
    if (had) this.markDirty();
    return had;
  }

  replaceAll(metas: PartitionMeta[]): void {
    this.entries.clear();
    for (const m of metas) this.entries.set(m.id, m);
    this.markDirty();
  }

  /** Commit pending changes now and wait until they are on disk. */
  flush(): Promise<void> {
    return this.commit();
  }

  private markDirty(): void {
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      void this.commit();
    }, this.debounceMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) (this.timer as { unref(): void }).unref();
  }

  /** Serialised, atomic write of the whole index (snapshot taken synchronously). */
  private commit(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.pending) return this.chain;
    this.pending = false;
    const snapshot: PartitionIndexFile = { version: 1, backend: this.backend, partitions: [...this.entries.values()] };
    const data = JSON.stringify(snapshot);
    const run = async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, data);
        this.writeError = undefined;
      } catch (err) {
        this.writeError = err instanceof Error ? err.message : String(err);
        this.pending = true;
        this.onWriteError?.(err);
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
}

export interface IndexFileEntry {
  key: PartitionKey;
  /** Relative path under the history root. */
  rel: string;
  bytes: number;
}

export interface ReconcileReport {
  added: number;
  updated: number;
  removed: number;
}

/**
 * Bring the index in line with the files on disk: partitions without an index entry are
 * added, entries without files are dropped, entries whose recorded bytes differ from the
 * file sizes are re-read. `readRows` must return the partition's current rows.
 */
export async function reconcileIndex(
  index: PartitionIndex,
  files: IndexFileEntry[],
  readRows: (key: PartitionKey) => Promise<HistoryRowLike[]>,
  nowIso: string,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { added: 0, updated: 0, removed: 0 };
  const byId = new Map<string, { key: PartitionKey; rels: string[]; bytes: number }>();
  for (const f of files) {
    const id = partitionId(f.key);
    const e = byId.get(id) ?? { key: f.key, rels: [], bytes: 0 };
    e.rels.push(f.rel);
    e.bytes += f.bytes;
    byId.set(id, e);
  }
  for (const meta of index.list()) {
    if (!byId.has(meta.id)) {
      index.remove(meta.id);
      report.removed++;
    }
  }
  for (const [id, e] of byId) {
    const existing = index.get(id);
    if (existing && existing.bytes === e.bytes) continue;
    const rows = await readRows(e.key);
    if (rows.length === 0 && !existing) continue;
    let min = rows[0]?.observedAt ?? '',
      max = rows[0]?.observedAt ?? '';
    for (const r of rows) {
      if (r.observedAt < min) min = r.observedAt;
      if (r.observedAt > max) max = r.observedAt;
    }
    const base: PartitionMeta = existing ?? {
      ...e.key,
      id,
      minObservedAt: min,
      maxObservedAt: max,
      rows: 0,
      originalRows: 0,
      bytes: 0,
      updatedAt: nowIso,
    };
    index.upsert({
      ...base,
      minObservedAt: min,
      maxObservedAt: max,
      rows: rows.length,
      originalRows: Math.max(base.originalRows + Math.max(0, rows.length - base.rows), rows.length),
      bytes: e.bytes,
      files: e.rels.sort(),
      updatedAt: nowIso,
    });
    if (existing) report.updated++;
    else report.added++;
  }
  return report;
}

interface HistoryRowLike {
  observedAt: string;
}

function isPartitionMeta(v: unknown): v is PartitionMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m['id'] === 'string' &&
    typeof m['objectType'] === 'string' &&
    typeof m['providerId'] === 'string' &&
    typeof m['day'] === 'string' &&
    typeof m['slot'] === 'string' &&
    typeof m['minObservedAt'] === 'string' &&
    typeof m['maxObservedAt'] === 'string' &&
    typeof m['rows'] === 'number' &&
    typeof m['originalRows'] === 'number' &&
    typeof m['bytes'] === 'number' &&
    typeof m['updatedAt'] === 'string'
  );
}

/** Merge per-partition windows of one type into contiguous availability ranges (gaps ≤ tolerance are bridged). */
export function mergeAvailability(metas: PartitionMeta[], gapToleranceMs: number): TimeRange[] {
  const sorted = [...metas].sort((a, b) =>
    a.minObservedAt < b.minObservedAt ? -1 : a.minObservedAt > b.minObservedAt ? 1 : 0,
  );
  const out: TimeRange[] = [];
  for (const m of sorted) {
    if (m.rows <= 0) continue;
    const last = out[out.length - 1];
    if (last && Date.parse(m.minObservedAt) - Date.parse(last.end) <= gapToleranceMs) {
      if (m.maxObservedAt > last.end) last.end = m.maxObservedAt;
    } else {
      out.push({ start: m.minObservedAt, end: m.maxObservedAt });
    }
  }
  return out;
}

export function metaToJson(meta: PartitionMeta): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(meta)) as Record<string, JsonValue>;
}
