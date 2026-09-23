import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  invalidIdReason,
  isOnHost,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * Singapore traffic images (Land Transport Authority, via data.gov.sg) — Singapore Open
 * Data Licence v1.0: worldwide, royalty-free, commercial use included, with the notice
 * "Contains information from {dataset} accessed on {date} from {source} which is made
 * available under the terms of the Singapore Open Data Licence version 1.0".
 *
 * About ninety cameras. The catalogue is also the frame list: every camera's `image` is the
 * URL of its latest picture and changes with each capture (every minute or so), so this
 * pack runs in its own provider polled every minute (singapore/manifest.ts) — in the
 * fifteen-minute camera provider every frame would be up to fifteen minutes old.
 *
 * `{ items: [ { timestamp, cameras: [ { timestamp, image, location: { latitude, longitude },
 * camera_id, image_metadata } ] } ] }`. The catalogue gives no names or facing.
 */
export const SINGAPORE_TRAFFIC_IMAGES_URL = 'https://api.data.gov.sg/v1/transport/traffic-images';
export const SINGAPORE_FRAME_PREFIX = 'images.data.gov.sg/api/traffic-images/';

export const singaporePack: CatalogPack = {
  id: 'singapore',
  registryId: 'datagovsg-traffic-images',
  request: { url: SINGAPORE_TRAFFIC_IMAGES_URL, headers: { Accept: 'application/json' }, maxBytes: 2 * 1024 * 1024 },
  frameHosts: [SINGAPORE_FRAME_PREFIX],
  attribution:
    'Contains information from Traffic Images from data.gov.sg (Land Transport Authority), made available under the terms of the Singapore Open Data Licence version 1.0',
  refreshSeconds: 60,
  normalize: normalizeSingapore,
};

interface SgCamera {
  timestamp?: unknown;
  image?: unknown;
  location?: { latitude?: unknown; longitude?: unknown } | null;
  camera_id?: unknown;
}

export function normalizeSingapore(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'no items' }], malformed: true };
  const cameras: unknown[] = [];
  for (const item of items) {
    const list = (item as { cameras?: unknown } | null)?.cameras;
    if (Array.isArray(list)) cameras.push(...list);
  }
  // The licence's notice names the date the data was accessed: the catalogue fetch's.
  const accessed = opts.observedAt.slice(0, 10);
  const attribution = `Contains information from Traffic Images accessed on ${accessed} from data.gov.sg (Land Transport Authority), made available under the terms of the Singapore Open Data Licence version 1.0`;
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  cameras.forEach((raw, index) => {
    const c = raw as SgCamera;
    if (!c || typeof c !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const id =
      typeof c.camera_id === 'string' ? c.camera_id.trim() : typeof c.camera_id === 'number' ? String(c.camera_id) : '';
    if (!CAMERA_ID_PATTERN.test(id)) {
      rejected.push({ index, reason: invalidIdReason(c.camera_id) });
      return;
    }
    const lat = c.location?.latitude;
    const lon = c.location?.longitude;
    if (!isValidLatLon(lat, lon) || !isLikelySingapore(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const image = typeof c.image === 'string' ? c.image.trim() : '';
    if (!isOnHost(image, singaporePack.frameHosts)) {
      rejected.push({ index, reason: 'frame url not on the pinned host' });
      return;
    }
    if (seen.has(id)) {
      rejected.push({ index, reason: `duplicate id ${id}` });
      return;
    }
    seen.add(id);
    const captured =
      typeof c.timestamp === 'string' && Number.isFinite(Date.parse(c.timestamp)) ? c.timestamp : undefined;
    drafts.push(
      draftFromCamera(
        singaporePack,
        {
          pack: 'singapore',
          cameraId: id,
          name: `Singapore traffic camera ${id}`,
          latitude: lat,
          longitude: lon as number,
          region: 'Singapore',
          frameUrl: image,
          extra: { attribution, ...(captured ? { frameCapturedAt: new Date(captured).toISOString() } : {}) },
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: cameras.length, rejected };
}

function isLikelySingapore(lat: number, lon: number): boolean {
  return lat >= 1.1 && lat <= 1.5 && lon >= 103.5 && lon <= 104.1;
}
