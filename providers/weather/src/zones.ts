import { geometrySchema, type WorldGeometry } from '@worldview/world-model';

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
const ZONE_URL = /^https:\/\/api\.weather\.gov\/zones\/(forecast|county|fire|coastal|offshore|public|marine)\/([A-Z]{2}[CZ][0-9]{3})$/;

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

export function zoneUrl(zoneId: string): string {
  return `https://api.weather.gov/zones/${zoneId}`;
}

/** Extract the polygon(s) from a zone Feature response. */
export function zoneGeometry(payload: unknown): WorldGeometry | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const geometry = (payload as { geometry?: unknown }).geometry;
  if (!geometry || typeof geometry !== 'object') return undefined;
  const type = (geometry as { type?: unknown }).type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return undefined;
  const parsed = geometrySchema.parse(geometry);
  if (!parsed.ok) return undefined;
  const g = parsed.value;
  return g.type === 'Polygon' || g.type === 'MultiPolygon' ? g : undefined;
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

  known(): number { return this.memory.size; }

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
        if (geometry) { this.memory.set(zoneId, geometry); continue; }
      }
      const failed = this.failedAt.get(zoneId);
      if (failed !== undefined && this.deps.now() - failed < ZONE_FAILURE_BACKOFF_MS) continue;
      if (budget <= 0) continue;
      budget--;
      let payload: unknown;
      try {
        payload = await this.deps.fetchZone(zoneId, signal);
      } catch {
        this.failedAt.set(zoneId, this.deps.now());
        continue;
      }
      const geometry = zoneGeometry(payload);
      if (!geometry) { this.failedAt.set(zoneId, this.deps.now()); continue; }
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
