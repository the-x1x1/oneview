import { geodesicInverse, haversineMeters, type GeoBounds, type GeoPosition } from '@worldview/world-model';
import { cityBeforeItsRegion, collapseDuplicateHits, samePlace } from './place-duplicates.js';

/**
 * Gazetteer — place-name resolution used by the search parser. The runtime composes
 * gazetteers (built-in fallback + the full PlaceIndex + worldpack indexes) with
 * `CompositeGazetteer`. Lookups are deterministic and offline.
 */
export type PlaceKind = 'country' | 'region' | 'city' | 'island' | 'airport' | 'port' | 'poi' | 'coordinate';

export interface GazetteerHit {
  /** Stable id, e.g. `iso3166-1:JP`, `iso3166-2:US-HI`, `airport:iata:HNL`, `place:builtin:honolulu`. */
  id: string;
  name: string;
  kind: PlaceKind;
  position: GeoPosition;
  bounds?: GeoBounds;
  countryCode?: string;
  /** The first-level region a city lies in ("Texas"), to tell same-named places apart. */
  region?: string;
  /** 0..1, how prominent the place is (a city's population); orders hits that tie on score and kind. */
  importance?: number;
  /** 0..1, 1 = exact name/alias match. */
  score: number;
  /** Which gazetteer produced the hit. */
  source?: string;
}

export interface GazetteerLookupOptions {
  kinds?: PlaceKind[];
  limit?: number;
  /** Prefer hits near this position (ties only; ranking stays deterministic). */
  bias?: GeoPosition;
}

/** A place near a point, and where the point is from it ("23 km NNE of Hilo"). */
export interface NearbyPlace {
  id: string;
  name: string;
  kind: PlaceKind;
  position: GeoPosition;
  countryCode?: string;
  region?: string;
  importance?: number;
  source?: string;
  /** From the place to the point, metres on the WGS84 ellipsoid. */
  distanceM: number;
  /** The direction of the point from the place, degrees clockwise from true north. */
  bearingDeg: number;
}

export interface GazetteerNearestOptions {
  /** Which kinds of place; cities when not said. */
  kinds?: PlaceKind[];
  /** How many, nearest first (default 1). */
  limit?: number;
  /** Nothing farther than this. */
  maxDistanceM?: number;
}

export interface Gazetteer {
  lookup(name: string, opts?: GazetteerLookupOptions): GazetteerHit[];
  /**
   * The places nearest a point, nearest first (offline reverse lookup: "what is near here").
   * Optional: a gazetteer that cannot answer it is left out.
   */
  nearest?(position: GeoPosition, opts?: GazetteerNearestOptions): NearbyPlace[];
}

export interface GazetteerEntry {
  id: string;
  name: string;
  kind: PlaceKind;
  position: GeoPosition;
  bounds?: GeoBounds;
  countryCode?: string;
  /** The first-level region a city lies in, shown beside it. */
  region?: string;
  /** 0..1, how prominent the place is; missing means a curated entry, ranked as 1. */
  importance?: number;
  /** Alternate names and codes (IATA/ICAO for airports). Matched case-insensitively. */
  aliases?: string[];
}

/** Lower-case, strip diacritics and punctuation, collapse whitespace. */
export function normalizePlaceName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface IndexedEntry {
  entry: GazetteerEntry;
  names: string[];
  codes: string[];
}

/**
 * In-memory gazetteer over a static entry list. Scoring: exact name/alias 1.0; exact
 * code (uppercase alias such as HNL/PHNL) 1.0; name prefix 0.8; word-prefix 0.7;
 * substring (query ≥ 3 chars) 0.6. Ties break by kind rank (country > region > city >
 * island > airport > port > poi) then name.
 */
export class StaticGazetteer implements Gazetteer {
  private readonly items: IndexedEntry[];
  constructor(
    entries: readonly GazetteerEntry[],
    readonly source = 'static',
  ) {
    this.items = entries.map((entry) => ({
      entry,
      names: [entry.name, ...(entry.aliases ?? []).filter((a) => !isCode(a))].map(normalizePlaceName),
      codes: (entry.aliases ?? []).filter(isCode).map((c) => c.toUpperCase()),
    }));
  }

  lookup(name: string, opts: GazetteerLookupOptions = {}): GazetteerHit[] {
    const q = normalizePlaceName(name);
    if (!q) return [];
    const upper = name.trim().toUpperCase();
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined;
    const hits: GazetteerHit[] = [];
    for (const it of this.items) {
      if (kinds && !kinds.has(it.entry.kind)) continue;
      const score = scoreEntry(it, q, upper);
      if (score <= 0) continue;
      hits.push(toHit(it.entry, score, this.source));
    }
    hits.sort(compareHits);
    return orderPlaceHits(hits).slice(0, opts.limit ?? 10);
  }

  nearest(position: GeoPosition, opts: GazetteerNearestOptions = {}): NearbyPlace[] {
    const kinds = new Set(opts.kinds ?? ['city']);
    const limit = Math.max(1, opts.limit ?? 1);
    const max = opts.maxDistanceM ?? Infinity;
    // Ranked on the sphere first (cheap), then the few that can be nearest on the ellipsoid
    // (the two differ by under 0.5 %).
    const near: Array<{ entry: GazetteerEntry; d: number }> = [];
    for (const { entry } of this.items) {
      if (!kinds.has(entry.kind)) continue;
      const d = haversineMeters(entry.position, position);
      if (d <= max * 1.005) near.push({ entry, d });
    }
    near.sort((a, b) => a.d - b.d);
    const out: NearbyPlace[] = [];
    for (const { entry } of near.slice(0, limit * 3 + 2)) {
      const g = geodesicInverse(entry.position, position);
      if (g.distanceM > max) continue;
      out.push(toNearby(entry, g.distanceM, g.initialBearingDeg, this.source));
    }
    return nearestFirst(out).slice(0, limit);
  }
}

function toNearby(e: GazetteerEntry, distanceM: number, bearingDeg: number, source: string): NearbyPlace {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    position: e.position,
    distanceM,
    bearingDeg,
    source,
    ...(e.countryCode ? { countryCode: e.countryCode } : {}),
    ...(e.region ? { region: e.region } : {}),
    ...(e.importance !== undefined ? { importance: e.importance } : {}),
  };
}

/** Nearest first (then the more prominent, then the name); one place listed by two indexes once. */
function nearestFirst(places: NearbyPlace[]): NearbyPlace[] {
  const sorted = [...places].sort(
    (a, b) =>
      a.distanceM - b.distanceM ||
      (b.importance ?? 1) - (a.importance ?? 1) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const out: NearbyPlace[] = [];
  for (const p of sorted) {
    const twin = out.findIndex((q) => q.id === p.id || samePlace(q, p));
    if (twin < 0) out.push(p);
    else {
      // The first is the nearer; it takes what it lacks from its twin.
      const q = out[twin]!;
      if (!q.countryCode && p.countryCode) q.countryCode = p.countryCode;
      if (!q.region && p.region) q.region = p.region;
    }
  }
  return out;
}

const KIND_RANK: Record<PlaceKind, number> = {
  country: 0,
  region: 1,
  city: 2,
  island: 3,
  airport: 4,
  port: 5,
  poi: 6,
  coordinate: 7,
};

/**
 * Best score first; then country before region before city…; then the more prominent place
 * ("Paris" is Paris, France before Paris, Texas); then the name. An entry without an
 * importance is a curated one and counts as 1.
 */
export function compareHits(a: GazetteerHit, b: GazetteerHit): number {
  return (
    b.score - a.score ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    (b.importance ?? 1) - (a.importance ?? 1) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/** Duplicates folded, then a city ahead of the same-named region it sits in (Paris, Tokyo). */
function orderPlaceHits(sorted: GazetteerHit[]): GazetteerHit[] {
  return cityBeforeItsRegion(
    collapseDuplicateHits(sorted),
    (h) => h.kind,
    (h) => h.name,
  );
}

function isCode(alias: string): boolean {
  return /^[A-Z0-9]{3,4}$/.test(alias);
}

function scoreEntry(it: IndexedEntry, q: string, upper: string): number {
  if (it.codes.includes(upper)) return 1;
  let best = 0;
  for (const n of it.names) {
    if (n === q) return 1;
    if (n.startsWith(q)) best = Math.max(best, 0.8);
    else if (n.split(' ').some((w) => w.startsWith(q))) best = Math.max(best, 0.7);
    else if (q.length >= 3 && n.includes(q)) best = Math.max(best, 0.6);
  }
  return best;
}

function toHit(e: GazetteerEntry, score: number, source: string): GazetteerHit {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    position: e.position,
    score,
    source,
    ...(e.bounds ? { bounds: e.bounds } : {}),
    ...(e.countryCode ? { countryCode: e.countryCode } : {}),
    ...(e.region ? { region: e.region } : {}),
    ...(e.importance !== undefined ? { importance: e.importance } : {}),
  };
}

/**
 * Merges several gazetteers: best score per id wins, then one hit per place (the same city
 * listed by two indexes under two ids is one hit — `collapseDuplicateHits`); order is
 * deterministic.
 */
export class CompositeGazetteer implements Gazetteer {
  constructor(private readonly gazetteers: readonly Gazetteer[]) {}

  lookup(name: string, opts: GazetteerLookupOptions = {}): GazetteerHit[] {
    const byId = new Map<string, GazetteerHit>();
    for (const g of this.gazetteers) {
      for (const hit of g.lookup(name, opts)) {
        const prev = byId.get(hit.id);
        if (!prev || hit.score > prev.score) byId.set(hit.id, hit);
      }
    }
    const hits = [...byId.values()];
    hits.sort(compareHits);
    return orderPlaceHits(hits).slice(0, opts.limit ?? 10);
  }

  nearest(position: GeoPosition, opts: GazetteerNearestOptions = {}): NearbyPlace[] {
    const all: NearbyPlace[] = [];
    for (const g of this.gazetteers) if (g.nearest) all.push(...g.nearest(position, opts));
    return nearestFirst(all).slice(0, Math.max(1, opts.limit ?? 1));
  }
}
