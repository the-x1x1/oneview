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

/** What search needs from a place index: the in-memory one here, or the SQLite one (place-sqlite.ts). */
export interface PlaceSearcher {
  readonly size: number;
  search(query: string, opts?: PlaceSearchOptions): PlaceSearchHit[];
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

/** The normalized full names and tokens of an entry, as both indexes score them. */
export function indexedForms(entry: PlaceEntry): { fullNames: string[]; tokens: Set<string> } {
  const fullNames = [normalizePlaceText(entry.name), ...entry.altNames.map(normalizePlaceText)].filter(
    (n) => n.length > 0,
  );
  const tokens = new Set<string>();
  for (const full of fullNames) for (const t of full.split(' ')) if (t) tokens.add(t);
  return { fullNames, tokens };
}

/**
 * How an entry matches a normalized query, or undefined when it does not: a code match, or —
 * every query token matching one of its tokens exactly or (two letters on) as a prefix — an
 * exact name, a name prefix, or token overlap. The one scoring rule both indexes use, so
 * the SQLite index ranks exactly as the in-memory one over the same candidates.
 */
export function matchEntry(
  entry: PlaceEntry,
  forms: { fullNames: readonly string[]; tokens: ReadonlySet<string> },
  qNorm: string,
  qTokens: readonly string[],
): { base: number; match: PlaceMatchKind } | undefined {
  let best: { base: number; match: PlaceMatchKind } | undefined;
  if (qTokens.length === 1 && (qNorm.length === 3 || qNorm.length === 4)) {
    if (entry.iata?.toLowerCase() === qNorm || entry.icao?.toLowerCase() === qNorm)
      best = { base: SCORE_CODE, match: 'code' };
  }
  let sum = 0;
  for (const qt of qTokens) {
    let partial = forms.tokens.has(qt) ? 1 : 0;
    if (partial < 1 && qt.length >= 2)
      for (const token of forms.tokens)
        if (token !== qt && token.startsWith(qt)) partial = Math.max(partial, 0.5 + 0.5 * (qt.length / token.length));
    if (partial === 0) return best;
    sum += partial;
  }
  const avg = sum / qTokens.length;
  const token: { base: number; match: PlaceMatchKind } = forms.fullNames.includes(qNorm)
    ? { base: SCORE_EXACT, match: 'exact' }
    : forms.fullNames.some((n) => n.startsWith(qNorm))
      ? { base: SCORE_PREFIX * avg, match: 'prefix' }
      : { base: SCORE_TOKENS * avg, match: 'tokens' };
  return !best || token.base > best.base ? token : best;
}

/** Score, filter and order matched entries (importance, distance bias), as both indexes return them. */
export function rankHits(
  matched: Iterable<{ entry: PlaceEntry; base: number; match: PlaceMatchKind }>,
  opts: PlaceSearchOptions,
  limit: number,
): PlaceSearchHit[] {
  const kinds = opts.kinds ? new Set(opts.kinds) : undefined;
  const hits: PlaceSearchHit[] = [];
  for (const { entry, base, match } of matched) {
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

export class PlaceIndex implements PlaceSearcher {
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
      const { fullNames, tokens } = indexedForms(entry);
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
    // Candidates: code matches, and entries carrying the first query token exactly or as a
    // prefix — every match needs that token, so nothing that can match is missed.
    const candidates = new Set<number>();
    if (qTokens.length === 1 && (qNorm.length === 3 || qNorm.length === 4))
      for (const idx of this.codes.get(qNorm) ?? []) candidates.add(idx);
    const first = qTokens[0]!;
    for (const idx of this.postings.get(first) ?? []) candidates.add(idx);
    if (first.length >= 2)
      for (const token of this.tokensWithPrefix(first))
        for (const idx of this.postings.get(token) ?? []) candidates.add(idx);
    const matched: Array<{ entry: PlaceEntry; base: number; match: PlaceMatchKind }> = [];
    for (const idx of candidates) {
      const item = this.items[idx]!;
      const m = matchEntry(item.entry, item, qNorm, qTokens);
      if (m) matched.push({ entry: item.entry, ...m });
    }
    return rankHits(matched, opts, limit);
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
