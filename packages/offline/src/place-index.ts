import {
  boundsSchema,
  haversineMeters,
  s,
  type GeoBounds,
  type GeoPosition,
  type Schema,
} from '@worldview/world-model';
import type { SearchResult } from '@worldview/ipc-contract';

/**
 * PlaceIndex — local place search with no network (ADR-007, Release 1).
 *
 * A pure-TypeScript inverted index over normalized name tokens (lowercase,
 * diacritics stripped, apostrophes/ʻokina removed) with prefix matching and a small
 * deterministic ranking: code match > exact name > name prefix > token overlap, then
 * an importance boost and an optional distance bias. Serialized as
 * `search/index.json` (entries only; the postings are rebuilt on load, which is
 * cheap for the tens of thousands of entries a regional pack carries).
 */
export type PlaceKind = 'country' | 'region' | 'city' | 'airport' | 'port' | 'feature' | 'poi';

export interface PlaceEntry {
  id: string;
  name: string;
  altNames: string[];
  kind: PlaceKind;
  iata?: string;
  icao?: string;
  countryCode?: string;
  position: GeoPosition;
  bounds?: GeoBounds;
  /** 0..1 — population/prominence proxy used as a ranking boost. */
  importance: number;
}

export type PlaceMatchKind = 'code' | 'exact' | 'prefix' | 'tokens';

export interface PlaceSearchHit {
  entry: PlaceEntry;
  score: number;
  match: PlaceMatchKind;
}

export interface PlaceSearchOptions {
  limit?: number;
  /** Bias results toward this position (closer scores higher). */
  position?: GeoPosition;
  kinds?: PlaceKind[];
}

export const PLACE_INDEX_FORMAT_VERSION = 1;

export interface SerializedPlaceIndex {
  formatVersion: typeof PLACE_INDEX_FORMAT_VERSION;
  entries: PlaceEntry[];
}

const PLACE_KINDS = ['country', 'region', 'city', 'airport', 'port', 'feature', 'poi'] as const;

export const placeEntrySchema: Schema<PlaceEntry> = s.object({
  id: s.string({ min: 1, max: 256 }),
  name: s.string({ min: 1, max: 200 }),
  altNames: s.array(s.string({ min: 1, max: 200 }), { max: 64 }),
  kind: s.enum(PLACE_KINDS),
  iata: s.optional(s.string({ pattern: /^[A-Z0-9]{3}$/ })),
  icao: s.optional(s.string({ pattern: /^[A-Z0-9]{4}$/ })),
  countryCode: s.optional(s.string({ pattern: /^[A-Z]{2}$/ })),
  position: s.object({ latitude: s.number({ min: -90, max: 90 }), longitude: s.number({ min: -180, max: 180 }) }),
  bounds: s.optional(boundsSchema),
  importance: s.number({ min: 0, max: 1 }),
}) as Schema<PlaceEntry>;

export const serializedPlaceIndexSchema: Schema<SerializedPlaceIndex> = s.object({
  formatVersion: s.literal(PLACE_INDEX_FORMAT_VERSION),
  entries: s.array(placeEntrySchema, { max: 5_000_000 }),
}) as Schema<SerializedPlaceIndex>;

const APOSTROPHES = /['‘’ʻʼ`´]/g;
const COMBINING = /[̀-ͯ]/g;

/** Lowercase, strip diacritics and apostrophes, collapse everything else to single spaces. */
export function normalizePlaceText(text: string): string {
  return text
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(APOSTROPHES, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenizePlaceText(text: string): string[] {
  const n = normalizePlaceText(text);
  return n ? n.split(' ') : [];
}

const SCORE_CODE = 3.0;
const SCORE_EXACT = 2.5;
const SCORE_PREFIX = 2.0;
const SCORE_TOKENS = 1.0;
const IMPORTANCE_WEIGHT = 0.5;
const DISTANCE_WEIGHT = 0.3;
const DISTANCE_HORIZON_M = 3_000_000;

interface IndexedEntry {
  entry: PlaceEntry;
  /** Normalized full strings (name + altNames). */
  fullNames: string[];
  tokens: Set<string>;
}

export class PlaceIndex {
  private readonly items: IndexedEntry[] = [];
  private readonly byId = new Map<string, number>();
  private readonly postings = new Map<string, number[]>();
  private readonly codes = new Map<string, number[]>();
  private sortedTokens: string[] | undefined;

  constructor(entries: readonly PlaceEntry[] = []) {
    this.add(entries);
  }

  get size(): number {
    return this.items.length;
  }

  entries(): PlaceEntry[] {
    return this.items.map((i) => i.entry);
  }

  get(id: string): PlaceEntry | undefined {
    const idx = this.byId.get(id);
    return idx === undefined ? undefined : this.items[idx]!.entry;
  }

  /** Add entries; an id that already exists is ignored (first pack wins on merge). */
  add(entries: readonly PlaceEntry[]): number {
    let added = 0;
    for (const entry of entries) {
      if (this.byId.has(entry.id)) continue;
      const idx = this.items.length;
      const fullNames = [normalizePlaceText(entry.name), ...entry.altNames.map(normalizePlaceText)].filter(
        (n) => n.length > 0,
      );
      const tokens = new Set<string>();
      for (const full of fullNames) for (const t of full.split(' ')) if (t) tokens.add(t);
      this.items.push({ entry, fullNames, tokens });
      this.byId.set(entry.id, idx);
      for (const t of tokens) {
        const list = this.postings.get(t);
        if (list) list.push(idx);
        else this.postings.set(t, [idx]);
      }
      for (const code of [entry.iata, entry.icao]) {
        if (!code) continue;
        const key = code.toLowerCase();
        const list = this.codes.get(key);
        if (list) list.push(idx);
        else this.codes.set(key, [idx]);
      }
      added++;
    }
    if (added > 0) this.sortedTokens = undefined;
    return added;
  }

  search(query: string, opts: PlaceSearchOptions = {}): PlaceSearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 200));
    const qNorm = normalizePlaceText(query);
    if (!qNorm) return [];
    const qTokens = qNorm.split(' ');
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined;
    const candidates = new Map<number, { base: number; match: PlaceMatchKind }>();

    const consider = (idx: number, base: number, match: PlaceMatchKind) => {
      const cur = candidates.get(idx);
      if (!cur || base > cur.base) candidates.set(idx, { base, match });
    };

    // 1. Airport / ICAO codes.
    if (qTokens.length === 1 && (qNorm.length === 3 || qNorm.length === 4)) {
      for (const idx of this.codes.get(qNorm) ?? []) consider(idx, SCORE_CODE, 'code');
    }

    // 2. Token overlap with prefix matching (every query token must match).
    const perToken: Array<Map<number, number>> = [];
    for (const qt of qTokens) {
      const matches = new Map<number, number>();
      for (const idx of this.postings.get(qt) ?? []) matches.set(idx, 1);
      if (qt.length >= 2) {
        for (const token of this.tokensWithPrefix(qt)) {
          if (token === qt) continue;
          const partial = 0.5 + 0.5 * (qt.length / token.length);
          for (const idx of this.postings.get(token) ?? [])
            if ((matches.get(idx) ?? 0) < partial) matches.set(idx, partial);
        }
      }
      perToken.push(matches);
    }
    if (perToken.length > 0) {
      const first = perToken[0]!;
      for (const [idx, firstScore] of first) {
        let sum = firstScore;
        let all = true;
        for (let i = 1; i < perToken.length; i++) {
          const sc = perToken[i]!.get(idx);
          if (sc === undefined) {
            all = false;
            break;
          }
          sum += sc;
        }
        if (!all) continue;
        const item = this.items[idx]!;
        const avg = sum / perToken.length;
        if (item.fullNames.includes(qNorm)) consider(idx, SCORE_EXACT, 'exact');
        else if (item.fullNames.some((n) => n.startsWith(qNorm))) consider(idx, SCORE_PREFIX * avg, 'prefix');
        else consider(idx, SCORE_TOKENS * avg, 'tokens');
      }
    }

    const hits: PlaceSearchHit[] = [];
    for (const [idx, { base, match }] of candidates) {
      const entry = this.items[idx]!.entry;
      if (kinds && !kinds.has(entry.kind)) continue;
      let score = base + IMPORTANCE_WEIGHT * clamp01(entry.importance);
      if (opts.position) {
        const d = haversineMeters(opts.position, entry.position);
        score += DISTANCE_WEIGHT * (1 - Math.min(d, DISTANCE_HORIZON_M) / DISTANCE_HORIZON_M);
      }
      hits.push({ entry, score: round4(score), match });
    }
    hits.sort(
      (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name) || a.entry.id.localeCompare(b.entry.id),
    );
    return hits.slice(0, limit);
  }

  toJSON(): SerializedPlaceIndex {
    return { formatVersion: PLACE_INDEX_FORMAT_VERSION, entries: this.entries() };
  }

  static fromJSON(value: unknown): { ok: true; index: PlaceIndex } | { ok: false; issues: string[] } {
    const r = serializedPlaceIndexSchema.parse(value);
    if (!r.ok) return { ok: false, issues: r.issues.slice(0, 10).map((i) => `${i.path || '<root>'}: ${i.message}`) };
    return { ok: true, index: new PlaceIndex(r.value.entries) };
  }

  static merge(indexes: readonly PlaceIndex[]): PlaceIndex {
    const out = new PlaceIndex();
    for (const ix of indexes) out.add(ix.entries());
    return out;
  }

  private tokensWithPrefix(prefix: string): string[] {
    if (!this.sortedTokens) this.sortedTokens = [...this.postings.keys()].sort();
    const arr = this.sortedTokens;
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < arr.length && arr[i]!.startsWith(prefix); i++) out.push(arr[i]!);
    return out;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

/** Present a hit through the IPC SearchResult shape (source 'worldpack'). */
export function placeHitToSearchResult(hit: PlaceSearchHit): SearchResult {
  const e = hit.entry;
  const subtitleParts: string[] = [kindLabel(e.kind)];
  if (e.iata) subtitleParts.push(e.iata);
  if (e.countryCode) subtitleParts.push(e.countryCode);
  return {
    kind: 'place',
    id: e.id,
    title: e.name,
    subtitle: subtitleParts.join(' · '),
    position: e.position,
    ...(e.bounds ? { bounds: e.bounds } : {}),
    source: 'worldpack',
    score: hit.score,
  };
}

function kindLabel(kind: PlaceKind): string {
  switch (kind) {
    case 'country':
      return 'Country';
    case 'region':
      return 'Region';
    case 'city':
      return 'City';
    case 'airport':
      return 'Airport';
    case 'port':
      return 'Port';
    case 'feature':
      return 'Feature';
    case 'poi':
      return 'Place';
  }
}
