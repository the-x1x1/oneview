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
} from './types.js';

/**
 * QLDTraffic webcams (Queensland Department of Transport and Main Roads) — the QLDTraffic
 * API specification (v1.10, §2.1): "Use of the data must be in accordance with the
 * Creative Commons Attribution 4.0 Australia (CC BY 4.0 AU) license."
 *
 * The API takes a key. QLDTraffic publishes a shared public key for developers who do not
 * register (limited to 100 requests a minute across everyone who uses it); that key is
 * below. It is the service's published anonymous key, not a credential of the operator's.
 *
 * GeoJSON features with `id`, `description`, `direction` ("NorthEast"), `district`,
 * `locality`, `image_url` and `image_sourced_from`. The feed says some material is owned by
 * "other entities which provide material … by arrangement": a camera whose image is
 * sourced from someone else (`image_sourced_from` set) is left out, because the CC BY
 * statement cannot be assumed to cover it. Coordinates are GDA2020, within about 2 m of WGS84.
 */
export const QLD_PUBLIC_API_KEY = '3e83add325cbb69ac4d8e5bf433d770b';
export const QLD_WEBCAMS_URL = `https://api.qldtraffic.qld.gov.au/v1/webcams?apikey=${QLD_PUBLIC_API_KEY}`;
export const QLD_FRAME_HOST = 'cameras.qldtraffic.qld.gov.au';

/** The operator's own QLDTraffic key (issued on request by qldtraffic@tmr.qld.gov.au), when stored. */
export const QLD_CREDENTIAL = 'qldtraffic.apiKey';

export const queenslandPack: CatalogPack = {
  id: 'queensland',
  registryId: 'qldtraffic-webcams',
  request: { url: QLD_WEBCAMS_URL, headers: { Accept: 'application/json' }, maxBytes: 4 * 1024 * 1024 },
  // The shared public key is limited to 100 requests a minute across everyone who uses it,
  // and answers 429 much of the day; a personal key has its own limit.
  keyedRequest: {
    url: 'https://api.qldtraffic.qld.gov.au/v1/webcams',
    headers: { Accept: 'application/json' },
    maxBytes: 4 * 1024 * 1024,
    credential: { key: QLD_CREDENTIAL, as: 'query', name: 'apikey' },
  },
  sourceRef: 'https://api.qldtraffic.qld.gov.au/v1/webcams',
  frameHosts: [QLD_FRAME_HOST],
  attribution: 'QLDTraffic — State of Queensland (Department of Transport and Main Roads), CC BY 4.0 AU',
  refreshSeconds: 120,
  normalize: normalizeQueensland,
};

interface QldFeature {
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: {
    id?: unknown;
    description?: unknown;
    direction?: unknown;
    district?: unknown;
    locality?: unknown;
    image_url?: unknown;
    image_sourced_from?: unknown;
  } | null;
}

export function normalizeQueensland(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'FeatureCollection')
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not a FeatureCollection' }], malformed: true };
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'features is not an array' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  features.forEach((raw: unknown, index: number) => {
    const f = raw as QldFeature;
    const p = f?.properties;
    if (!p || typeof p !== 'object') {
      rejected.push({ index, reason: 'missing properties' });
      return;
    }
    if (p.image_sourced_from !== null && p.image_sourced_from !== undefined && p.image_sourced_from !== '') return; // third-party image
    const cameraId =
      typeof p.id === 'number' && Number.isSafeInteger(p.id)
        ? String(p.id)
        : typeof p.id === 'string'
          ? p.id.trim()
          : '';
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    const coords =
      f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates)
        ? (f.geometry.coordinates as unknown[])
        : undefined;
    const lon = coords?.[0];
    const lat = coords?.[1];
    if (!isValidLatLon(lat, lon) || !isLikelyQueensland(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    // The specification's examples are http; the live feed is https. Either way, https on the pinned host.
    const image = typeof p.image_url === 'string' ? p.image_url.trim().replace(/^http:\/\//i, 'https://') : '';
    if (!isOnHost(image, queenslandPack.frameHosts)) {
      rejected.push({ index, reason: offHostReason(image) });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const direction = text(p.direction, 20);
    const heading = directionToHeading(direction);
    const locality = text(p.locality, 60);
    const district = text(p.district, 60);
    drafts.push(
      draftFromCamera(
        queenslandPack,
        {
          pack: 'queensland',
          cameraId,
          name: text(p.description, 140) || `QLDTraffic camera ${cameraId}`,
          latitude: lat,
          longitude: lon as number,
          region: [locality, district].filter(Boolean).join(', ') || 'Queensland',
          ...(heading !== undefined ? { headingDegrees: heading, direction } : {}),
          frameUrl: image,
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: features.length, rejected };
}

function isLikelyQueensland(lat: number, lon: number): boolean {
  return lat >= -29.5 && lat <= -9 && lon >= 137.5 && lon <= 154;
}
