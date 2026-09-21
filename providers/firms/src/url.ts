import type { GeoBounds } from '@worldview/world-model';
import type { ProviderHttpRequest } from '@worldview/provider-sdk';
import type { FirmsSource } from './manifest.js';

/**
 * FIRMS area API URL building — isolated because the MAP_KEY travels in the
 * *path*: https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<SOURCE>/<area>/<dayRange>
 *
 * The request is built with a `{MAP_KEY}` placeholder in the path and the credential
 * declared `as: 'path'`; the HttpClient substitutes the percent-encoded secret into
 * that segment (ADR-003). The provider never holds the key, and the cache key keeps
 * the placeholder form so no secret reaches the cache or the logs.
 */
export const FIRMS_HOST = 'firms.modaps.eosdis.nasa.gov';
export const FIRMS_AREA_BASE = `https://${FIRMS_HOST}/api/area/csv`;
export const FIRMS_KEY_PLACEHOLDER = '{MAP_KEY}';
export const FIRMS_CREDENTIAL_KEY = 'firms.mapKey';

/** Credential attachment for every FIRMS request (see module comment). */
export const FIRMS_CREDENTIAL: NonNullable<ProviderHttpRequest['credential']> = { key: FIRMS_CREDENTIAL_KEY, as: 'path', name: 'MAP_KEY' };

export type FirmsArea = 'world' | GeoBounds;

/** Minimum padding (degrees) added around a viewport before it becomes a FIRMS area. */
export const MIN_AREA_PADDING_DEG = 1;

export function firmsAreaUrl(source: FirmsSource, area: FirmsArea, dayRange: number, keyToken: string = FIRMS_KEY_PLACEHOLDER): string {
  return `${FIRMS_AREA_BASE}/${keyToken}/${source}/${formatArea(area)}/${clampDayRange(dayRange)}`;
}

export function firmsRequest(source: FirmsSource, area: FirmsArea, dayRange: number): Pick<ProviderHttpRequest, 'url' | 'credential' | 'cacheKey'> {
  const url = firmsAreaUrl(source, area, dayRange);
  return { url, credential: { ...FIRMS_CREDENTIAL }, cacheKey: `GET ${url}` };
}

export function clampDayRange(days: number): number {
  if (!Number.isFinite(days)) return 1;
  return Math.min(10, Math.max(1, Math.trunc(days)));
}

/** FIRMS area syntax: `world` or `west,south,east,north`. */
export function formatArea(area: FirmsArea): string {
  if (area === 'world') return 'world';
  return [area.west, area.south, area.east, area.north].map((v) => String(Math.round(v * 100) / 100)).join(',');
}

/**
 * Viewport → FIRMS area: pad by ≥ 1°, snap outward to whole degrees (stable cache
 * keys while panning), clamp to the globe. Antimeridian-crossing or degenerate
 * bounds fall back to `world`.
 */
export function boundsToArea(bounds: GeoBounds | undefined): FirmsArea {
  if (!bounds) return 'world';
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(Number.isFinite) || west > east || south > north) return 'world';
  const w = Math.max(-180, Math.floor(west - MIN_AREA_PADDING_DEG));
  const e = Math.min(180, Math.ceil(east + MIN_AREA_PADDING_DEG));
  const s = Math.max(-90, Math.floor(south - MIN_AREA_PADDING_DEG));
  const n = Math.min(90, Math.ceil(north + MIN_AREA_PADDING_DEG));
  if (w <= -180 && e >= 180 && s <= -90 && n >= 90) return 'world';
  return { west: w, south: s, east: e, north: n };
}

/** Parse an area-API URL (either key form) — used by fixtures to answer per source. */
export function parseFirmsAreaUrl(url: string): { source: string; area: string; dayRange: number } | undefined {
  const m = /\/api\/area\/csv\/[^/]+\/([A-Z0-9_]+)\/([^/]+)\/(\d+)(?:\?|$)/.exec(url);
  if (!m) return undefined;
  return { source: m[1]!, area: decodeURIComponent(m[2]!), dayRange: Number(m[3]) };
}
