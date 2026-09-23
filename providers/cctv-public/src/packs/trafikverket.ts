import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { normalizeHeading } from '../direction.js';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  invalidIdReason,
  isOnHost,
  offHostReason,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * Trafikverket (Swedish Transport Administration) road cameras — the open API for traffic
 * information, whose data is licensed CC0 1.0 (accepted when the key is registered at
 * data.trafikverket.se). About 1,500 cameras: traffic-flow cameras about every minute,
 * road-condition cameras about every five.
 *
 * The API takes its key inside the POST body (`<LOGIN authenticationkey="…"/>`), so the
 * request carries a placeholder that the network layer fills (credential `xml-body`,
 * ADR-003) — the key never reaches this code, the logs or the cache key. Without a key the
 * pack does not run at all; see PublicCamerasProvider.
 *
 * NOT YET CHECKED AGAINST A LIVE RESPONSE: the field names follow the API's published
 * object model (as used by pytrafikverket and trafikinfo, both open source) and the
 * fixture is synthetic. The first run with a key is that check — a changed shape shows as
 * `camera pack failed` (MALFORMED) or `rejected camera rows` in app.log.
 */
export const TRAFIKVERKET_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
export const TRAFIKVERKET_CREDENTIAL = 'trafikverket.apiKey';
export const TRAFIKVERKET_FRAME_PREFIXES = [
  'api.trafikinfo.trafikverket.se/v1/Images/',
  'api.trafikinfo.trafikverket.se/v2/Images/',
];

const FIELDS = ['Id', 'Name', 'Description', 'Direction', 'Geometry.WGS84', 'PhotoUrl', 'HasFullSizePhoto', 'Type'];

export const TRAFIKVERKET_QUERY = [
  '<REQUEST>',
  '<LOGIN authenticationkey="{TRAFIKVERKET_KEY}" />',
  '<QUERY objecttype="Camera" namespace="road.infrastructure" schemaversion="1.1">',
  '<FILTER><EQ name="Active" value="true" /></FILTER>',
  ...FIELDS.map((f) => `<INCLUDE>${f}</INCLUDE>`),
  '</QUERY>',
  '</REQUEST>',
].join('');

export const trafikverketPack: CatalogPack = {
  id: 'trafikverket',
  registryId: 'trafikverket-cameras',
  request: {
    url: TRAFIKVERKET_URL,
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', Accept: 'application/json' },
    body: TRAFIKVERKET_QUERY,
    credential: { key: TRAFIKVERKET_CREDENTIAL, as: 'xml-body', name: 'TRAFIKVERKET_KEY' },
    maxBytes: 8 * 1024 * 1024,
  },
  frameHosts: TRAFIKVERKET_FRAME_PREFIXES,
  attribution: 'Trafikverket (Swedish Transport Administration), CC0 1.0',
  refreshSeconds: 60,
  normalize: normalizeTrafikverket,
};

interface TrvCamera {
  Id?: unknown;
  Name?: unknown;
  Description?: unknown;
  Direction?: unknown;
  Geometry?: { WGS84?: unknown } | null;
  PhotoUrl?: unknown;
  HasFullSizePhoto?: unknown;
  Type?: unknown;
  Deleted?: unknown;
  Active?: unknown;
}

/** `POINT (17.6388 59.8586)` → [lon, lat]. */
export function parseWktPoint(value: unknown): [number, number] | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^\s*POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)\s*$/i.exec(value);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export function normalizeTrafikverket(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  const result = (payload as { RESPONSE?: { RESULT?: unknown } } | null)?.RESPONSE?.RESULT;
  if (!Array.isArray(result))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not a Trafikverket RESPONSE' }], malformed: true };
  const error = result.find((r) => r && typeof r === 'object' && 'ERROR' in r) as
    { ERROR?: { MESSAGE?: unknown } } | undefined;
  if (error) {
    const message = typeof error.ERROR?.MESSAGE === 'string' ? error.ERROR.MESSAGE.slice(0, 120) : 'unknown';
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: `API error: ${message}` }], malformed: true };
  }
  const cameras: unknown[] = [];
  for (const r of result) {
    const list = (r as { Camera?: unknown } | null)?.Camera;
    if (Array.isArray(list)) cameras.push(...list);
  }
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  cameras.forEach((raw, index) => {
    const c = raw as TrvCamera;
    if (!c || typeof c !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    if (c.Deleted === true || c.Active === false) return;
    const id = typeof c.Id === 'string' ? c.Id.trim() : '';
    if (!CAMERA_ID_PATTERN.test(id)) {
      rejected.push({ index, reason: invalidIdReason(c.Id) });
      return;
    }
    const point = parseWktPoint(c.Geometry?.WGS84);
    if (!point || !isValidLatLon(point[1], point[0]) || !isLikelySweden(point[1], point[0])) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const photo = typeof c.PhotoUrl === 'string' ? c.PhotoUrl.trim().replace(/^http:\/\//i, 'https://') : '';
    if (!isOnHost(photo, trafikverketPack.frameHosts)) {
      rejected.push({ index, reason: offHostReason(photo) });
      return;
    }
    if (seen.has(id)) {
      rejected.push({ index, reason: `duplicate id ${id}` });
      return;
    }
    seen.add(id);
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const heading = normalizeHeading(typeof c.Direction === 'string' ? Number(c.Direction) : c.Direction);
    const frameUrl = c.HasFullSizePhoto === true && !photo.includes('?') ? `${photo}?type=fullsize` : photo;
    drafts.push(
      draftFromCamera(
        trafikverketPack,
        {
          pack: 'trafikverket',
          cameraId: id,
          name: text(c.Name, 120) || text(c.Description, 120) || `Trafikverket camera ${id}`,
          latitude: point[1],
          longitude: point[0],
          region: text(c.Type, 60) || 'Sweden',
          ...(heading !== undefined ? { headingDegrees: heading } : {}),
          frameUrl,
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: cameras.length, rejected };
}

function isLikelySweden(lat: number, lon: number): boolean {
  return lat >= 55 && lat <= 69.2 && lon >= 10.5 && lon <= 24.3;
}
