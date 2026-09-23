import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { directionToHeading } from '../direction.js';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  isOnHost,
  offHostReason,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from '../packs/types.js';

/**
 * Caltrans CCTV (California), districts 1–12 — licence NOT confirmed (see the
 * `public-cameras-unverified` provider). Adapted from gods-eye-view
 * server/providers/cctv/sources.js (MIT), loadCaltransSourcesFromOpenData.
 *
 * One JSON file per district: `{ data: [ { cctv: { index, inService, location: {
 * locationName, nearbyPlace, latitude, longitude, direction, elevation (feet) }, imageData: {
 * static: { currentImageURL } } } } ] }`. Only in-service cameras with a still on
 * cwwp2.dot.ca.gov are kept; the camera code leading `locationName` ("TV102 -- …") with the
 * district is the id. `direction` is a dedicated field and becomes the heading.
 */
export const CALTRANS_DISTRICTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
export const caltransUrl = (d: number): string =>
  `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, '0')}.json`;
const CALTRANS_HOST = 'cwwp2.dot.ca.gov';

const part = (d: number) => ({
  url: caltransUrl(d),
  headers: { Accept: 'application/json' },
  maxBytes: 8 * 1024 * 1024,
});

export const caltransPack: CatalogPack = {
  id: 'caltrans',
  registryId: 'caltrans-cctv',
  request: part(CALTRANS_DISTRICTS[0]!),
  moreRequests: CALTRANS_DISTRICTS.slice(1).map(part),
  frameHosts: [CALTRANS_HOST],
  attribution: 'Caltrans (California Department of Transportation) — licence not confirmed',
  refreshSeconds: 120,
  normalize: normalizeCaltrans,
};

interface CctvRow {
  cctv?: {
    index?: unknown;
    inService?: unknown;
    location?: {
      district?: unknown;
      locationName?: unknown;
      nearbyPlace?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      direction?: unknown;
      elevation?: unknown;
    } | null;
    imageData?: { static?: { currentImageURL?: unknown } | null } | null;
  } | null;
}

/** `payload` is one district document or the array of them (moreRequests). */
export function normalizeCaltrans(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  const docs = Array.isArray(payload) ? payload : [payload];
  const rows: unknown[] = [];
  for (const doc of docs) {
    const data = (doc as { data?: unknown } | null)?.data;
    if (Array.isArray(data)) rows.push(...data);
  }
  if (rows.length === 0 && !docs.some((d) => Array.isArray((d as { data?: unknown } | null)?.data)))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'no district data' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    const c = (raw as CctvRow)?.cctv;
    if (!c || typeof c !== 'object') {
      rejected.push({ index, reason: 'no cctv record' });
      return;
    }
    if (String(c.inService ?? '').toLowerCase() !== 'true') return; // out of service: not a camera today
    const loc = c.location ?? {};
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (!isValidLatLon(lat, lon) || !isLikelyCalifornia(lat, lon)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const image =
      typeof c.imageData?.static?.currentImageURL === 'string' ? c.imageData.static.currentImageURL.trim() : '';
    if (!isOnHost(image, caltransPack.frameHosts)) {
      rejected.push({ index, reason: offHostReason(image) });
      return;
    }
    const locationName = typeof loc.locationName === 'string' ? loc.locationName.trim() : '';
    const code = /^([A-Za-z0-9_-]+)\s*--/.exec(locationName)?.[1];
    const district = Number(loc.district);
    const cameraId = `d${Number.isInteger(district) ? district : 0}-${(code ?? String(c.index ?? '')).toLowerCase()}`;
    if (!CAMERA_ID_PATTERN.test(cameraId) || cameraId.endsWith('-')) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const label = locationName.replace(/^[A-Za-z0-9_-]+\s*--\s*/, '').slice(0, 120);
    const place = typeof loc.nearbyPlace === 'string' ? loc.nearbyPlace.trim().slice(0, 60) : '';
    const direction = typeof loc.direction === 'string' ? loc.direction.trim().slice(0, 20) : '';
    const heading = directionToHeading(direction);
    const feet =
      typeof loc.elevation === 'number' || (typeof loc.elevation === 'string' && loc.elevation.trim() !== '')
        ? Number(loc.elevation)
        : NaN;
    drafts.push(
      draftFromCamera(
        caltransPack,
        {
          pack: 'caltrans',
          cameraId,
          name: (label || `Caltrans camera ${cameraId}`) + (place ? ` (${place})` : ''),
          latitude: lat,
          longitude: lon,
          ...(Number.isFinite(feet) ? { altitudeM: Math.max(-100, Math.min(4000, Math.round(feet * 0.3048))) } : {}),
          region: place || `Caltrans district ${district}`,
          ...(heading !== undefined ? { headingDegrees: heading, direction } : {}),
          frameUrl: image,
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: rows.length, rejected };
}

function isLikelyCalifornia(lat: number, lon: number): boolean {
  return lat >= 32 && lat <= 42.1 && lon >= -124.6 && lon <= -114;
}
