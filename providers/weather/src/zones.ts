import { ProviderError } from '@worldview/provider-sdk';
import { geometrySchema, simplifyRing, type WorldGeometry } from '@worldview/world-model';

/**
 * NWS zone geometry (api.weather.gov/zones/…).
 *
 * Roughly half of the active-alert feed carries no polygon of its own: the alert names
 * the forecast, county or fire-weather zones it covers in `affectedZones`, and the
 * geometry lives behind a second request. Those alerts used to be skipped, which meant
 * WORLDVIEW showed a strict subset of what was in force — a quiet, misleading omission.
 *
 * Zone outlines are static in practice (they change with NWS zone updates, a few times a
 * year), so they are cached with a long TTL and the fetch work is bounded per poll: a
 * cold start resolves what it can within the budget and the rest resolve on the next
 * poll, rather than issuing hundreds of requests at once. An alert whose zones are not
 * yet resolved stays skipped with a reason and is counted — never invented.
 */

/** `https://api.weather.gov/zones/forecast/TXZ123` → `forecast/TXZ123`. */
const ZONE_URL =
  /^https:\/\/api\.weather\.gov\/zones\/(forecast|county|fire|coastal|offshore|public|marine)\/([A-Z]{2}[CZ][0-9]{3})$/;

export function parseZoneRef(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = ZONE_URL.exec(raw.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The zone ids an alert covers, de-duplicated and in feed order. */
export function zoneRefsOf(affectedZones: unknown): string[] {
  if (!Array.isArray(affectedZones)) return [];
  const out: string[] = [];
  for (const raw of affectedZones) {
    const id = parseZoneRef(raw);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Did the client decline to make the request, rather than the request failing?
 *
 * `RATE_LIMITED` is our own limiter; `OFFLINE` is our own connectivity check. Neither is
 * an observation about the zone, and neither gets better by asking for a different one,
 * so both end the poll rather than being blamed on whichever zone happened to be next.
 */
function isTransportRefusal(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.code === 'RATE_LIMITED' || error.code === 'OFFLINE';
}

export function zoneUrl(zoneId: string): string {
  return `https://api.weather.gov/zones/${zoneId}`;
}

/**
 * How closely a zone outline is kept: 0.005° is ~550 m north–south (less east–west away
 * from the equator), finer than a county line drawn at any zoom the alert layer is read at.
 *
 * NWS zone outlines follow coastlines and county lines vertex by vertex. Stored as fetched,
 * the ~300 alerts drawn from zones came to tens of megabytes of coordinates, and every poll
 * that touched them re-sent all of it to the map: the operator's perf log showed a 5,365-
 * object delta — ~5,000 satellites and those alerts — taking 152 ms to parse, against ~14 ms
 * for the satellites alone. Simplified outlines also triangulate in a fraction of the time.
 */
export const ZONE_SIMPLIFY_DEG = 0.005;

/** Extract the polygon(s) from a zone Feature response, simplified to `ZONE_SIMPLIFY_DEG`. */
export function zoneGeometry(payload: unknown): WorldGeometry | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const geometry = (payload as { geometry?: unknown }).geometry;
  if (!geometry || typeof geometry !== 'object') return undefined;
  const type = (geometry as { type?: unknown }).type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return undefined;
  const parsed = geometrySchema.parse(geometry);
  if (!parsed.ok) return undefined;
  const g = parsed.value;
  if (g.type === 'Polygon')
    return { type: 'Polygon', coordinates: g.coordinates.map((r) => simplifyRing(r, ZONE_SIMPLIFY_DEG)) };
  if (g.type === 'MultiPolygon')
    return {
      type: 'MultiPolygon',
      coordinates: g.coordinates.map((poly) => poly.map((r) => simplifyRing(r, ZONE_SIMPLIFY_DEG))),
    };
  return undefined;
}

/**
 * Combine the zones of one alert into a single geometry. Zones are disjoint areas, so
 * they become a MultiPolygon rather than being merged — no union is computed and no
 * boundary is invented.
 */
export function combineZoneGeometries(geometries: readonly WorldGeometry[]): WorldGeometry | undefined {
  const polygons: Array<Array<Array<[number, number] | [number, number, number]>>> = [];
  for (const g of geometries) {
    if (g.type === 'Polygon') polygons.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polygons.push(...g.coordinates);
  }
  if (polygons.length === 0) return undefined;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0]! };
  return { type: 'MultiPolygon', coordinates: polygons };
}

export interface ZoneCacheDeps {
  /** Fetch one zone document; resolves to undefined when the zone cannot be read. */
  fetchZone(zoneId: string, signal: AbortSignal): Promise<unknown>;
  cache: {
    get(key: string): Promise<{ value: unknown; storedAt: string } | undefined>;
    set(key: string, value: never, ttlMs?: number): Promise<void>;
  };
  now(): number;
  log?: (message: string, fields: Record<string, string | number | boolean>) => void;
}

/** Zone outlines change a few times a year; a month of caching is conservative. */
export const ZONE_TTL_MS = 30 * 24 * 3600_000;
/** How many uncached zones one poll may fetch. The remainder resolve on later polls. */
export const ZONE_FETCH_BUDGET = 20;
/** A zone that answered 404 or malformed data is not retried every poll. */
export const ZONE_FAILURE_BACKOFF_MS = 6 * 3600_000;

export class ZoneGeometryCache {
  private readonly memory = new Map<string, WorldGeometry>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly deps: ZoneCacheDeps) {}

  /** Synchronous lookup for the normalizer; only what has already been resolved. */
  lookup(zoneId: string): WorldGeometry | undefined {
    return this.memory.get(zoneId);
  }

  known(): number {
    return this.memory.size;
  }

  /**
   * Resolve as many of `zoneIds` as the budget allows, warming the in-memory map.
   * Returns how many were fetched from upstream and how many remain unresolved.
   */
  async resolve(zoneIds: readonly string[], signal: AbortSignal): Promise<{ fetched: number; pending: number }> {
    const wanted = zoneIds.filter((id) => !this.memory.has(id));
    let fetched = 0;
    let budget = ZONE_FETCH_BUDGET;
    for (const zoneId of wanted) {
      if (signal.aborted) break;
      const cached = await this.deps.cache.get(cacheKey(zoneId)).catch(() => undefined);
      if (cached) {
        const geometry = zoneGeometry({ geometry: cached.value });
        if (geometry) {
          this.memory.set(zoneId, geometry);
          continue;
        }
      }
      const failed = this.failedAt.get(zoneId);
      if (failed !== undefined && this.deps.now() - failed < ZONE_FAILURE_BACKOFF_MS) continue;
      if (budget <= 0) continue;
      budget--;
      let payload: unknown;
      try {
        payload = await this.deps.fetchZone(zoneId, signal);
      } catch (error) {
        // A refusal to *send* the request says nothing about the zone, and recording it as
        // a zone failure was the bug that made US weather alerts look permanently broken.
        // The HTTP client throws RATE_LIMITED when its own limiter would make the caller
        // wait more than ten seconds, so a poll that ran out of request slots marked every
        // remaining zone failed — each one then sat out a six-hour backoff without anyone
        // having asked upstream about it even once. A few cycles of that poisoned the whole
        // list, and the log showed the same 564 unresolved zones hour after hour while the
        // provider reported healthy. Give up on the poll instead of on the zones: they are
        // still wanted, and the next cycle starts with a fresh window.
        if (isTransportRefusal(error)) break;
        this.failedAt.set(zoneId, this.deps.now());
        continue;
      }
      const geometry = zoneGeometry(payload);
      if (!geometry) {
        this.failedAt.set(zoneId, this.deps.now());
        continue;
      }
      this.memory.set(zoneId, geometry);
      fetched++;
      await this.deps.cache.set(cacheKey(zoneId), geometry as never, ZONE_TTL_MS).catch(() => undefined);
    }
    const pending = zoneIds.filter((id) => !this.memory.has(id)).length;
    if (fetched || pending) this.deps.log?.('NWS zone geometry', { fetched, pending, known: this.memory.size });
    return { fetched, pending };
  }
}

function cacheKey(zoneId: string): string {
  return `zone:${zoneId}`;
}
