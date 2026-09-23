import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  isOnHost,
  offHostReason,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * Transport for London JamCams — TfL Open Data terms (commercial use permitted with the
 * attribution "Powered by TfL Open Data"; contains OS data © Crown copyright).
 * Adapted from gods-eye-view server/providers/cctv/sources.js (MIT), loadTflSourcesFromOpenData.
 *
 * One keyless list of `Place` records. Each carries `lat`/`lon`, `commonName` and an
 * `additionalProperties` key/value list with `available` and `imageUrl`. Only
 * `available: "true"` cameras are kept, and only when `imageUrl` is a JPEG in TfL's own
 * bucket: the S3 host is shared by every bucket in the region, so the pin is the host and
 * the `/jamcams.tfl.gov.uk/` path together (`frameHosts`). The JamCam list carries no
 * facing, so every camera is `heading-unknown`. `videoUrl` is deliberately not used: stills
 * only, like every other pack.
 */
export const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
export const TFL_FRAME_PREFIX = 's3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';

export const tflPack: CatalogPack = {
  id: 'tfl',
  registryId: 'tfl-jamcams',
  request: { url: TFL_JAMCAM_URL, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 },
  frameHosts: [TFL_FRAME_PREFIX],
  attribution: 'Powered by TfL Open Data. Contains OS data © Crown copyright and database rights',
  refreshSeconds: 300,
  normalize: normalizeTfl,
};

interface TflPlace {
  id?: unknown;
  commonName?: unknown;
  lat?: unknown;
  lon?: unknown;
  additionalProperties?: unknown;
}

const FRAME_FILE = /^\/jamcams\.tfl\.gov\.uk\/[A-Za-z0-9._-]{1,64}\.jpg$/;

export function normalizeTfl(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!Array.isArray(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of places' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  payload.forEach((raw: unknown, index: number) => {
    const place = raw as TflPlace;
    if (!place || typeof place !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const props = keyValues(place.additionalProperties);
    if (String(props['available'] ?? '').toLowerCase() !== 'true') return; // switched off upstream: not a camera today
    const cameraId = typeof place.id === 'string' ? place.id.trim().replace(/^JamCams_/, '') : '';
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    const lat = place.lat;
    const lon = place.lon;
    if (!isValidLatLon(lat, lon) || !isLikelyLondon(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const imageUrl = typeof props['imageUrl'] === 'string' ? props['imageUrl'].trim() : '';
    if (!isOnHost(imageUrl, tflPack.frameHosts) || !FRAME_FILE.test(new URL(imageUrl).pathname)) {
      rejected.push({ index, reason: offHostReason(imageUrl) });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const commonName = typeof place.commonName === 'string' ? place.commonName.trim().slice(0, 120) : '';
    drafts.push(
      draftFromCamera(
        tflPack,
        {
          pack: 'tfl',
          cameraId,
          name: commonName || `JamCam ${cameraId}`,
          latitude: lat,
          longitude: lon as number,
          region: 'London',
          frameUrl: imageUrl,
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: payload.length, rejected };
}

/** `[{ key, value }, …]` → `{ key: value }` (strings only). */
function keyValues(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const k = (item as { key?: unknown })?.key;
    const v = (item as { value?: unknown })?.value;
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Greater London with a margin for the cameras on the approaches. */
function isLikelyLondon(lat: number, lon: number): boolean {
  return lat >= 51.2 && lat <= 51.8 && lon >= -0.6 && lon <= 0.4;
}
