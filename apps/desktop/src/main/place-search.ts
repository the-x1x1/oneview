import type { GeoBounds } from '@worldview/world-model';
import type { PlaceSearchAnswer, RequestOf, SearchResult } from '@worldview/ipc-contract';

/**
 * Online place search (`search.places`), asked from the main process: addresses, streets
 * and places the offline gazetteer does not have.
 *
 * OpenStreetMap's Nominatim answers first; Photon (komoot's search over the same OSM data,
 * forgiving of typos and partial names) is asked only when Nominatim finds nothing or
 * fails. Settings → Search can put Photon first instead, or switch it all off: Nominatim's
 * policy asks that an application can be moved off its service without a software update. Both are community services run for everyone, and this client keeps to their
 * terms (Nominatim usage policy, read 2026-09-28; Photon's README for the public instance):
 *
 *  - At most one request a second to each, for the whole application: requests queue for
 *    their turn, and more than a couple waiting is refused as `busy` rather than piled up.
 *  - Never per keystroke. The shell asks only when the operator presses Enter or picks
 *    "Search places online" (Nominatim forbids autocomplete on its API).
 *  - A User-Agent that names the application and where it comes from, not a library's.
 *  - Answers are cached (a day; a failure for two minutes), and the same question asked
 *    while it is in flight shares the one request.
 *  - "© OpenStreetMap contributors" goes with every answer (ODbL 1.0), shown under the
 *    results.
 *  - Only these two hosts, over https; the URL is built here, never taken from the page.
 *
 * Offline (the OS says so), or switched off in Settings, nothing is sent.
 */
export const NOMINATIM_HOST = 'nominatim.openstreetmap.org';
export const PHOTON_HOST = 'photon.komoot.io';
export const PLACE_SEARCH_HOSTS: readonly string[] = Object.freeze([NOMINATIM_HOST, PHOTON_HOST]);

export const NOMINATIM_ATTRIBUTION = 'Places © OpenStreetMap contributors (ODbL) · search by Nominatim';
export const PHOTON_ATTRIBUTION = 'Places © OpenStreetMap contributors (ODbL) · search by Photon (komoot)';

/** A little over the one-a-second both services allow, so clock jitter never makes it two. */
export const MIN_GAP_MS = 1_100;
const TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 512 * 1024;
const HIT_TTL_MS = 24 * 3_600_000;
const FAIL_TTL_MS = 2 * 60_000;
const CACHE_MAX = 200;
/** Requests that may wait for their turn at one service; one more is `busy`. */
const MAX_WAITING = 2;
const DEFAULT_LIMIT = 6;

export interface PlaceSearchOptions {
  fetchImpl: typeof fetch;
  userAgent: string;
  isOnline: () => boolean;
  enabled: () => boolean;
  /** The service asked first (Settings → Search); the other is the fallback. Default Nominatim. */
  first?: () => Service;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type Service = 'nominatim' | 'photon';

interface CacheEntry {
  answer: PlaceSearchAnswer;
  expires: number;
}

class Turnstile {
  private next = 0;
  private waiting = 0;
  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}
  /** Waits for this service's next free second; false when too many are waiting already. */
  async enter(): Promise<boolean> {
    if (this.waiting >= MAX_WAITING) return false;
    this.waiting++;
    try {
      const at = Math.max(this.now(), this.next);
      this.next = at + MIN_GAP_MS;
      const wait = at - this.now();
      if (wait > 0) await this.sleep(wait);
      return true;
    } finally {
      this.waiting--;
    }
  }
}

export class PlaceSearch {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<PlaceSearchAnswer>>();
  private readonly turns: Record<Service, Turnstile>;
  private readonly now: () => number;
  /** What was actually sent, for the log and the tests. */
  readonly stats = { asked: 0, fromCache: 0, sent: 0, refused: 0, failed: 0 };

  constructor(private readonly opts: PlaceSearchOptions) {
    this.now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.turns = { nominatim: new Turnstile(this.now, sleep), photon: new Turnstile(this.now, sleep) };
  }

  async search(req: RequestOf<'search.places'>, signal?: AbortSignal): Promise<PlaceSearchAnswer> {
    this.stats.asked++;
    const text = req.text.trim().replace(/\s+/g, ' ');
    if (text.length < 2) return { status: 'ok', results: [], attribution: NOMINATIM_ATTRIBUTION };
    if (!this.opts.enabled())
      return {
        status: 'disabled',
        results: [],
        attribution: '',
        message: 'Online place search is off (Settings → Search).',
      };
    if (!this.opts.isOnline())
      return {
        status: 'offline',
        results: [],
        attribution: '',
        message: 'Offline — online place search is unavailable; the built-in gazetteer is searched instead.',
      };
    const limit = Math.min(10, Math.max(1, req.limit ?? DEFAULT_LIMIT));
    const first = this.opts.first?.() ?? 'nominatim';
    const key = `${first}|${text.toLowerCase()}|${limit}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) {
      this.stats.fromCache++;
      // Refreshed as most recently used.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.answer;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.ask(first, text, limit, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    const answer = await work;
    if (answer.status !== 'busy') {
      this.cache.set(key, { answer, expires: this.now() + (answer.status === 'ok' ? HIT_TTL_MS : FAIL_TTL_MS) });
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    }
    return answer;
  }

  private async ask(
    service: Service,
    text: string,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<PlaceSearchAnswer> {
    const first = await this.fromService(service, text, limit, signal);
    if (first.status === 'ok' && first.results.length) return first;
    if (first.status === 'busy') return first;
    const second = await this.fromService(service === 'nominatim' ? 'photon' : 'nominatim', text, limit, signal);
    if (second.status === 'ok') return second.results.length || first.status !== 'ok' ? second : first;
    return first.status === 'ok' ? first : second;
  }

  private async fromService(
    service: Service,
    text: string,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<PlaceSearchAnswer> {
    const attribution = service === 'nominatim' ? NOMINATIM_ATTRIBUTION : PHOTON_ATTRIBUTION;
    if (!(await this.turns[service].enter())) {
      this.stats.refused++;
      return { status: 'busy', results: [], attribution, message: 'Online search is busy — try again in a moment.' };
    }
    const url = service === 'nominatim' ? nominatimUrl(text, limit) : photonUrl(text, limit);
    try {
      this.stats.sent++;
      const body = await this.get(url, signal);
      const results = service === 'nominatim' ? parseNominatim(body, limit) : parsePhoton(body, limit);
      return { status: 'ok', results, attribution, service };
    } catch (err) {
      this.stats.failed++;
      return {
        status: 'unavailable',
        results: [],
        attribution,
        message: `Online place search did not answer (${err instanceof Error ? err.message : String(err)}); the built-in gazetteer is searched instead.`,
      };
    }
  }

  private async get(url: string, outer: AbortSignal | undefined): Promise<unknown> {
    assertAllowed(url);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('timed out')), TIMEOUT_MS);
    const onOuter = () => abort.abort(new Error('cancelled'));
    outer?.addEventListener('abort', onOuter, { once: true });
    try {
      const res = await this.opts.fetchImpl(url, {
        signal: abort.signal,
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json', 'Accept-Language': 'en' },
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new Error('answer too large');
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }
}

/** Refuses any URL that is not https to one of the two services. */
export function assertAllowed(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !PLACE_SEARCH_HOSTS.includes(u.hostname) || u.username || u.password)
    throw new Error(`place search may not fetch ${u.hostname}`);
}

export function nominatimUrl(text: string, limit: number): string {
  const q = new URLSearchParams({ q: text, format: 'jsonv2', limit: String(limit), addressdetails: '0' });
  return `https://${NOMINATIM_HOST}/search?${q.toString()}`;
}

export function photonUrl(text: string, limit: number): string {
  const q = new URLSearchParams({ q: text, limit: String(limit), lang: 'en' });
  return `https://${PHOTON_HOST}/api/?${q.toString()}`;
}

/**
 * A number that is really a coordinate, or null. Blank, missing and non-numeric values are
 * refused rather than coerced — `Number(null)` is 0, and a missing pair read as (0, 0)
 * would fly the operator to the Gulf of Guinea as if it were a hit (God's Eye View's
 * nominatimGeocode.js makes the same point).
 */
export function coordinate(value: unknown, limit: 90 | 180): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** The map zoom that shows a place of this OSM kind whole, when it has no usable box. */
export function zoomForKind(kind: string): number {
  switch (kind) {
    case 'country':
      return 4;
    case 'state':
    case 'region':
    case 'province':
      return 6;
    case 'county':
    case 'district':
      return 8;
    case 'city':
    case 'municipality':
      return 10;
    case 'town':
    case 'suburb':
    case 'village':
      return 12;
    case 'road':
    case 'street':
    case 'highway':
      return 15;
    case 'house':
    case 'building':
      return 17;
    default:
      return 14;
  }
}

/**
 * A box worth framing: ordered, inside the world, not across the antimeridian (framing
 * does not wrap), and not so small that framing it would put the camera on a rooftop — a
 * point with a zoom does that better.
 */
export function usableBounds(b: GeoBounds): GeoBounds | undefined {
  if (!(b.south < b.north) || !(b.west < b.east)) return undefined;
  if (Math.abs(b.south) > 90 || Math.abs(b.north) > 90 || Math.abs(b.west) > 180 || Math.abs(b.east) > 180)
    return undefined;
  if (b.north - b.south < 0.02 && b.east - b.west < 0.02) return undefined;
  return b;
}

function place(
  id: string,
  title: string,
  subtitle: string,
  latitude: number,
  longitude: number,
  kind: string,
  bounds: GeoBounds | undefined,
  rank: number,
): SearchResult {
  const box = bounds ? usableBounds(bounds) : undefined;
  return {
    kind: 'place',
    id,
    title,
    ...(subtitle ? { subtitle } : {}),
    position: { latitude, longitude },
    ...(box ? { bounds: box } : { zoom: zoomForKind(kind) }),
    source: 'geocoder',
    score: Math.max(0, 1 - rank * 0.01),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Nominatim's `format=jsonv2` answer → places. Rows that are not real places are dropped. */
export function parseNominatim(body: unknown, limit: number): SearchResult[] {
  if (!Array.isArray(body)) throw new Error('unexpected answer');
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of body as Array<Record<string, unknown>>) {
    if (out.length >= limit) break;
    if (typeof row !== 'object' || row === null) continue;
    const lat = coordinate(row['lat'], 90);
    const lon = coordinate(row['lon'], 180);
    if (lat === null || lon === null) continue;
    const display = str(row['display_name']);
    const parts = display
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const title = str(row['name']) || parts[0];
    if (!title) continue;
    const osm = `${str(row['osm_type']).charAt(0)}${str(row['osm_id'])}`;
    const id = `place:osm:${osm.length > 1 ? osm : `${lat.toFixed(5)},${lon.toFixed(5)}`}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const bb = Array.isArray(row['boundingbox']) ? (row['boundingbox'] as unknown[]) : [];
    const [s, n, w, e] = [coordinate(bb[0], 90), coordinate(bb[1], 90), coordinate(bb[2], 180), coordinate(bb[3], 180)];
    const bounds =
      s !== null && n !== null && w !== null && e !== null ? { west: w, south: s, east: e, north: n } : undefined;
    const kind = str(row['addresstype']) || str(row['type']);
    const context = parts.filter((p) => p !== title).slice(0, 3);
    out.push(place(id, title, context.join(', '), lat, lon, kind, bounds, out.length));
  }
  return out;
}

/** Photon's GeoJSON answer → places. `extent` is [west, north, east, south]. */
export function parsePhoton(body: unknown, limit: number): SearchResult[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) throw new Error('unexpected answer');
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const f of features as Array<{ geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }>) {
    if (out.length >= limit) break;
    const c = Array.isArray(f?.geometry?.coordinates) ? (f.geometry.coordinates as unknown[]) : [];
    const lon = coordinate(c[0], 180);
    const lat = coordinate(c[1], 90);
    const p = f?.properties ?? {};
    if (lat === null || lon === null) continue;
    const street = [str(p['street']), str(p['housenumber'])].filter(Boolean).join(' ');
    const title = str(p['name']) || street || str(p['city']) || str(p['country']);
    if (!title) continue;
    const osm = `${str(p['osm_type']).toLowerCase()}${str(p['osm_id'])}`;
    const id = `place:osm:${osm.length > 1 ? osm : `${lat.toFixed(5)},${lon.toFixed(5)}`}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const context = [str(p['name']) && street ? street : '', str(p['city']), str(p['state']), str(p['country'])]
      .filter(Boolean)
      .filter((v, i, a) => v !== title && a.indexOf(v) === i)
      .slice(0, 3);
    const ext = Array.isArray(p['extent']) ? (p['extent'] as unknown[]) : [];
    const [w, n, e, s] = [
      coordinate(ext[0], 180),
      coordinate(ext[1], 90),
      coordinate(ext[2], 180),
      coordinate(ext[3], 90),
    ];
    const bounds =
      w !== null && n !== null && e !== null && s !== null
        ? { west: w, south: Math.min(n, s), east: e, north: Math.max(n, s) }
        : undefined;
    const kind = str(p['type']) || str(p['osm_value']);
    out.push(place(id, title, context.join(', '), lat, lon, kind, bounds, out.length));
  }
  return out;
}
