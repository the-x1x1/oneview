import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * City of Calgary traffic cameras — Open Government Licence – City of Calgary (Open
 * Calgary Socrata dataset `k7p9-kppz`, keyless). Adapted from gods-eye-view
 * server/providers/cctv/sources.js (MIT), calgaryCameraToSource.
 *
 * Rows carry `camera_location` (the intersection), `quadrant`, `camera_url.url` and a
 * GeoJSON `point`. The dataset has no id column: the frame's file name (`loc142.jpg`) is
 * the stable token the city keys on. It publishes `http://` frame URLs; the host serves
 * HTTPS, so the URL is upgraded and then pinned to trafficcam.calgary.ca.
 *
 * No heading is derived. `quadrant` and the "SW" ending `camera_location` are Calgary's
 * address grid — which quarter of the city the intersection is in — not a facing, and
 * reading either as a bearing would give every camera a confident wrong one.
 */
export const CALGARY_CAMERAS_URL = 'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=1000';
export const CALGARY_FRAME_HOST = 'trafficcam.calgary.ca';

export const calgaryPack: CatalogPack = {
  id: 'calgary',
  registryId: 'open-calgary',
  request: { url: CALGARY_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 4 * 1024 * 1024 },
  frameHosts: [CALGARY_FRAME_HOST],
  attribution: 'Contains information licensed under the Open Government Licence – City of Calgary',
  refreshSeconds: 120,
  normalize: normalizeCalgary,
};

interface CalgaryRow {
  camera_location?: unknown;
  quadrant?: unknown;
  camera_url?: { url?: unknown; description?: unknown } | null;
  point?: { type?: unknown; coordinates?: unknown } | null;
}

export function normalizeCalgary(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!Array.isArray(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of rows' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  payload.forEach((raw: unknown, index: number) => {
    const row = raw as CalgaryRow;
    if (!row || typeof row !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const coords = Array.isArray(row.point?.coordinates) ? (row.point.coordinates as unknown[]) : undefined;
    const lon = typeof coords?.[0] === 'string' ? Number(coords[0]) : coords?.[0];
    const lat = typeof coords?.[1] === 'string' ? Number(coords[1]) : coords?.[1];
    if (!isValidLatLon(lat, lon) || !isLikelyCalgary(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const frameUrl = pinnedFrameUrl(row.camera_url?.url);
    if (!frameUrl) {
      rejected.push({ index, reason: 'frame url not on the pinned host' });
      return;
    }
    const cameraId = cameraIdFromFrame(frameUrl);
    if (!cameraId) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const location = typeof row.camera_location === 'string' ? row.camera_location.trim().slice(0, 120) : '';
    const described =
      typeof row.camera_url?.description === 'string' ? row.camera_url.description.trim().slice(0, 80) : '';
    const quadrant = typeof row.quadrant === 'string' ? row.quadrant.trim().slice(0, 10) : '';
    drafts.push(
      draftFromCamera(
        calgaryPack,
        {
          pack: 'calgary',
          cameraId,
          name: location || described || `Calgary camera ${cameraId}`,
          latitude: lat,
          longitude: lon as number,
          region: 'Calgary',
          frameUrl,
          ...(quadrant ? { extra: { quadrant } } : {}),
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: payload.length, rejected };
}

/** The dataset's frame URL on https and on the city's camera host, or undefined. */
export function pinnedFrameUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined;
  if (u.hostname.toLowerCase() !== CALGARY_FRAME_HOST || u.port) return undefined;
  if (!/^\/[A-Za-z0-9._-]{1,64}\.(jpg|jpeg)$/i.test(u.pathname) || u.search) return undefined;
  return `https://${CALGARY_FRAME_HOST}${u.pathname}`;
}

/** `…/loc142.jpg` → `loc142`: the file name is the only stable per-camera token. */
function cameraIdFromFrame(url: string): string | undefined {
  const file = new URL(url).pathname.slice(1).replace(/\.(jpg|jpeg)$/i, '');
  return CAMERA_ID_PATTERN.test(file) ? file : undefined;
}

function isLikelyCalgary(lat: number, lon: number): boolean {
  return lat >= 50.8 && lat <= 51.25 && lon >= -114.4 && lon <= -113.8;
}
