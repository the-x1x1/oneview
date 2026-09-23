import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  indexedForms,
  matchEntry,
  normalizePlaceText,
  placeEntrySchema,
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
 * scored by `matchEntry`/`rankHits`, the rules the in-memory index uses. Over the same
 * entries the two return the same results, until a query matches more than
 * CANDIDATE_LIMIT entries by token alone; then the most important of them are scored.
 *
 * `node:sqlite` ships with Node 22 and the Electron main process; where it is missing the
 * registry keeps the in-memory index.
 */
export type SqliteModule = typeof import('node:sqlite');
type Database = InstanceType<SqliteModule['DatabaseSync']>;

export const SQLITE_INDEX_VERSION = 1;
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
    private readonly db: Database,
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
      return new SqlitePlaceIndex(db, size, file);
    } catch {
      db?.close();
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
        CREATE VIRTUAL TABLE tokens USING fts5(t, content='', tokenize='unicode61');
      `);
      const putEntry = db.prepare('INSERT INTO entries (rid, id, importance, json) VALUES (?, ?, ?, ?)');
      const putName = db.prepare('INSERT INTO names (norm, rid) VALUES (?, ?)');
      const putCode = db.prepare('INSERT INTO codes (code, rid) VALUES (?, ?)');
      const putTokens = db.prepare('INSERT INTO tokens (rowid, t) VALUES (?, ?)');
      db.exec('BEGIN');
      const seen = new Set<string>();
      let rid = 0;
      for (const entry of entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
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
        CREATE INDEX names_norm ON names (norm);
        CREATE INDEX codes_code ON codes (code);
        CREATE INDEX entries_importance ON entries (importance DESC);
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
    const qTokens = qNorm.split(' ');
    const rids = new Set<number>();
    const add = (rows: unknown[]) => {
      for (const r of rows) rids.add(Number((r as { rid: number }).rid));
    };
    if (qTokens.length === 1 && (qNorm.length === 3 || qNorm.length === 4))
      add(this.db.prepare('SELECT rid FROM codes WHERE code = ?').all(qNorm));
    // The exact name, always; then full names starting with the query, most important first
    // ('~' sorts after every character a normalized name can hold).
    add(this.db.prepare('SELECT rid FROM names WHERE norm = ? LIMIT 200').all(qNorm));
    add(
      this.db
        .prepare(
          'SELECT n.rid AS rid FROM names n JOIN entries e ON e.rid = n.rid WHERE n.norm >= ? AND n.norm < ? ORDER BY e.importance DESC LIMIT ?',
        )
        .all(qNorm, `${qNorm}~`, CANDIDATE_LIMIT),
    );
    // Every query token, two letters on as a prefix (one letter only whole), most important first.
    const match = qTokens.map((t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`)).join(' ');
    add(
      this.db
        .prepare(
          'SELECT e.rid AS rid FROM tokens JOIN entries e ON e.rid = tokens.rowid WHERE tokens MATCH ? ORDER BY e.importance DESC LIMIT ?',
        )
        .all(match, CANDIDATE_LIMIT),
    );
    if (rids.size === 0) return [];
    const matched: Array<{ entry: PlaceEntry; base: number; match: PlaceMatchKind }> = [];
    const get = this.db.prepare('SELECT json FROM entries WHERE rid = ?');
    for (const rid of rids) {
      const row = get.get(rid) as { json: string } | undefined;
      if (!row) continue;
      const parsed = placeEntrySchema.parse(JSON.parse(row.json));
      if (!parsed.ok) continue;
      const entry = parsed.value;
      const m = matchEntry(entry, indexedForms(entry), qNorm, qTokens);
      if (m) matched.push({ entry, ...m });
    }
    return rankHits(matched, opts, limit);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
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
