import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  indexedForms,
  matchEntry,
  normalizePlaceText,
  rankHits,
  type PlaceEntry,
  type PlaceMatchKind,
  type PlaceSearchHit,
  type PlaceSearchOptions,
  type PlaceSearcher,
} from './place-index.js';

/**
 * SqlitePlaceIndex — the place index on disk, for packs too large to hold in memory
 * (roadmap 0.2: "SQLite FTS place index at country scale"; ADR-007).
 *
 * Built by the app itself from a pack's validated `search/index.json`, never opened from a
 * file a pack supplies: a pack stays data the app parses, not a database it trusts. The
 * database lives beside the installed packs (`worldpacks/.index/<pack>.sqlite`) and records
 * the SHA-256 of the index it was built from, so a changed pack is rebuilt and an unchanged
 * one is opened as is.
 *
 * Retrieval is SQLite's; ranking is not. Candidates come from an exact-code table, a B-tree
 * over every normalized full name (exact and prefix), and an FTS5 table over the name tokens
 * (every query token, the last as a prefix) taken in order of importance — then they are
 * scored by `matchEntry`/`rankHits`, the rules the in-memory index uses. Entries are numbered
 * in order of importance when the index is built (most important first, ties by id), so
 * "most important first" is rowid order — which FTS5 returns without sorting and stops at the
 * limit — and the FTS table keeps two- and three-letter prefix indexes, so a short prefix
 * does not scan every term (index version 2: "ka" over 100,000 places went from ~60 ms to
 * a few). Over the same
 * entries the two return the same results, until a query matches more than
 * CANDIDATE_LIMIT entries by token alone; then the most important of them are scored.
 *
 * The file is opened for each search and closed after it — a millisecond or two — rather than
 * held: on Windows an open database cannot be deleted or replaced, and a pack removed or
 * updated while its index is open must be able to take the file with it.
 *
 * `node:sqlite` ships with Node 22 and the Electron main process; where it is missing the
 * registry keeps the in-memory index.
 */
export type SqliteModule = typeof import('node:sqlite');
type Database = InstanceType<SqliteModule['DatabaseSync']>;

export const SQLITE_INDEX_VERSION = 2;
export const CANDIDATE_LIMIT = 2000;

/** `node:sqlite`, or undefined where this runtime has none. */
export async function loadSqlite(): Promise<SqliteModule | undefined> {
  try {
    const mod = (await import('node:sqlite' as string)) as SqliteModule;
    return typeof mod.DatabaseSync === 'function' ? mod : undefined;
  } catch {
    return undefined;
  }
}

export class SqlitePlaceIndex implements PlaceSearcher {
  private constructor(
    private readonly sqlite: SqliteModule,
    readonly size: number,
    readonly file: string,
  ) {}

  /**
   * The index for `entries` at `file`: opened when it was built from `sourceSha256`, rebuilt
   * (into a temporary file, then moved into place) when not.
   */
  static async openOrBuild(
    sqlite: SqliteModule,
    file: string,
    sourceSha256: string,
    entries: () => Promise<readonly PlaceEntry[]>,
  ): Promise<{ index: SqlitePlaceIndex; built: boolean }> {
    const existing = await SqlitePlaceIndex.tryOpen(sqlite, file, sourceSha256);
    if (existing) return { index: existing, built: false };
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.building`;
    await fs.rm(tmp, { force: true });
    SqlitePlaceIndex.build(sqlite, tmp, sourceSha256, await entries());
    await fs.rm(file, { force: true });
    await fs.rename(tmp, file);
    const opened = await SqlitePlaceIndex.tryOpen(sqlite, file, sourceSha256);
    if (!opened) throw new Error('the place index just built does not open');
    return { index: opened, built: true };
  }

  private static async tryOpen(sqlite: SqliteModule, file: string, sha: string): Promise<SqlitePlaceIndex | undefined> {
    try {
      await fs.access(file);
    } catch {
      return undefined;
    }
    let db: Database | undefined;
    try {
      db = new sqlite.DatabaseSync(file, { readOnly: true });
      const meta = new Map(
        (db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map((r) => [
          r.key,
          r.value,
        ]),
      );
      if (meta.get('version') !== String(SQLITE_INDEX_VERSION) || meta.get('source') !== sha) {
        db.close();
        return undefined;
      }
      const size = Number((db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n);
      db.close();
      return new SqlitePlaceIndex(sqlite, size, file);
    } catch {
      try {
        db?.close();
      } catch {
        // already closed
      }
      return undefined;
    }
  }

  /** Write a fresh index of `entries` to `file` (which must not exist). */
  static build(sqlite: SqliteModule, file: string, sourceSha256: string, entries: readonly PlaceEntry[]): void {
    const db = new sqlite.DatabaseSync(file);
    try {
      db.exec(`
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE entries (rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, importance REAL NOT NULL, json TEXT NOT NULL);
        CREATE TABLE names (norm TEXT NOT NULL, rid INTEGER NOT NULL);
        CREATE TABLE codes (code TEXT NOT NULL, rid INTEGER NOT NULL);
        CREATE VIRTUAL TABLE tokens USING fts5(t, content='', tokenize='unicode61', prefix='2 3');
      `);
      const putEntry = db.prepare('INSERT INTO entries (rid, id, importance, json) VALUES (?, ?, ?, ?)');
      const putName = db.prepare('INSERT INTO names (norm, rid) VALUES (?, ?)');
      const putCode = db.prepare('INSERT INTO codes (code, rid) VALUES (?, ?)');
      const putTokens = db.prepare('INSERT INTO tokens (rowid, t) VALUES (?, ?)');
      db.exec('BEGIN');
      // The first entry with an id wins (as in the in-memory index); then most important first.
      const seen = new Set<string>();
      const unique: PlaceEntry[] = [];
      for (const entry of entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        unique.push(entry);
      }
      unique.sort((a, b) => b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      let rid = 0;
      for (const entry of unique) {
        rid++;
        const forms = indexedForms(entry);
        putEntry.run(rid, entry.id, entry.importance, JSON.stringify(entry));
        for (const n of new Set(forms.fullNames)) putName.run(n, rid);
        for (const c of [entry.iata, entry.icao]) if (c) putCode.run(c.toLowerCase(), rid);
        // Normalized text is [a-z0-9 ] only, so unicode61 splits it exactly as tokenizePlaceText does.
        putTokens.run(rid, [...forms.tokens].join(' '));
      }
      db.exec('COMMIT');
      db.exec(`
        CREATE INDEX names_norm ON names (norm, rid);
        CREATE INDEX codes_code ON codes (code);
      `);
      const putMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      putMeta.run('version', String(SQLITE_INDEX_VERSION));
      putMeta.run('source', sourceSha256);
      putMeta.run('entries', String(rid));
    } finally {
      db.close();
    }
  }

  search(query: string, opts: PlaceSearchOptions = {}): PlaceSearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 200));
    const qNorm = normalizePlaceText(query);
    if (!qNorm) return [];
    let db: Database;
    try {
      db = new this.sqlite.DatabaseSync(this.file, { readOnly: true });
    } catch {
      return [];
    }
    try {
      return this.searchIn(db, qNorm, opts, limit);
    } finally {
      db.close();
    }
  }

  private searchIn(db: Database, qNorm: string, opts: PlaceSearchOptions, limit: number): PlaceSearchHit[] {
    const qTokens = qNorm.split(' ');
    const code = qTokens.length === 1 && (qNorm.length === 3 || qNorm.length === 4);
    // Every query token, two letters on as a prefix (one letter only whole).
    const match = qTokens.map((t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`)).join(' ');
    // One statement for every candidate, each row with its entry: an exact code; the exact
    // name, always; then full names starting with the query and token matches, most
    // important first — rowid order is importance order (see above), and FTS5 yields rowids
    // in order ('~' sorts after every character a normalized name can hold).
    const rows = db
      .prepare(
        `WITH c(rid) AS (
           SELECT rid FROM codes WHERE code = :code
           UNION SELECT * FROM (SELECT rid FROM names WHERE norm = :q LIMIT 200)
           UNION SELECT * FROM (SELECT rid FROM names WHERE norm >= :q AND norm < :qEnd ORDER BY rid LIMIT :limit)
           UNION SELECT * FROM (SELECT rowid FROM tokens WHERE tokens MATCH :match LIMIT :limit)
         )
         SELECT e.json AS json FROM c JOIN entries e ON e.rid = c.rid ORDER BY e.rid`,
      )
      .all({ code: code ? qNorm : '', q: qNorm, qEnd: `${qNorm}~`, limit: CANDIDATE_LIMIT, match }) as Array<{
      json: string;
    }>;
    const matched: Array<{ entry: PlaceEntry; base: number; match: PlaceMatchKind }> = [];
    for (const row of rows) {
      const entry = storedEntry(row.json);
      if (!entry) continue;
      const m = matchEntry(entry, indexedForms(entry), qNorm, qTokens);
      if (m) matched.push({ entry, ...m });
    }
    return rankHits(matched, opts, limit);
  }

  /** Nothing is held open between searches; kept so callers need not know that. */
  close(): void {}
}

/**
 * An entry as the index stored it. Every entry was validated (`placeEntrySchema`) before the
 * app wrote it, and the file is the app's own, rebuilt when its source changes — so a read
 * checks the shape it relies on rather than validating every field again, which was the
 * largest cost of a broad search (a quarter of a millisecond per hundred candidates).
 */
function storedEntry(json: string): PlaceEntry | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  const e = v as Partial<PlaceEntry> | null;
  if (
    !e ||
    typeof e.id !== 'string' ||
    typeof e.name !== 'string' ||
    typeof e.kind !== 'string' ||
    typeof e.importance !== 'number' ||
    !Array.isArray(e.altNames) ||
    typeof e.position?.latitude !== 'number' ||
    typeof e.position.longitude !== 'number'
  )
    return undefined;
  return e as PlaceEntry;
}

/** Several indexes searched as one; an id found in an earlier one wins (first installed pack). */
export class CompositePlaceSearch implements PlaceSearcher {
  constructor(private readonly parts: readonly PlaceSearcher[]) {}

  get size(): number {
    return this.parts.reduce((n, p) => n + p.size, 0);
  }

  search(query: string, opts: PlaceSearchOptions = {}): PlaceSearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 200));
    const byId = new Map<string, PlaceSearchHit>();
    for (const part of this.parts)
      for (const hit of part.search(query, { ...opts, limit }))
        if (!byId.has(hit.entry.id)) byId.set(hit.entry.id, hit);
    return [...byId.values()]
      .sort(
        (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name) || a.entry.id.localeCompare(b.entry.id),
      )
      .slice(0, limit);
  }
}
