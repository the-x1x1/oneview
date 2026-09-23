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
 * Live Traffic NSW (Transport for NSW) cameras, CC BY 4.0.
 * Adapted from gods-eye-view server/providers/cctv/sources.js (MIT), nswCameraToSource.
 *
 * Keyless GeoJSON feed. Every feature carries `region`, `title`, `view` (a sentence),
 * a compass `direction` ("N", "N-E", …) and `href` (a still on the TfNSW webcam host).
 * The frame URL is taken from the feed but must be https on the pinned host, else the
 * camera is rejected.
 *
 * Frame access: the webcam host has been observed answering non-browser clients
 * with an HTML placeholder. WORLDVIEW sends its own User-Agent and marks the frame
 * unavailable if the host refuses; it does not impersonate a browser
 * (config/licenses/providers.json, live-traffic-nsw notes).
 */
export const NSW_CAMERAS_URL = 'https://data.livetraffic.com/cameras/traffic-cam.json';
export const NSW_FRAME_HOST = 'webcams.transport.nsw.gov.au';
/**
 * A few images are served from the catalogue's own host, under its cameras directory (one
 * on 2026-09-23, found through the off-host rejection in app.log): same publisher, same
 * dataset, so that directory — not the whole host — is pinned too.
 */
export const NSW_CATALOGUE_FRAME_PREFIX = 'data.livetraffic.com/cameras/';
const MAX_VIEW_LABEL = 140;

export const nswPack: CatalogPack = {
  id: 'nsw',
  registryId: 'live-traffic-nsw',
  request: { url: NSW_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 4 * 1024 * 1024 },
  frameHosts: [NSW_FRAME_HOST, NSW_CATALOGUE_FRAME_PREFIX],
  attribution: 'Live Traffic NSW — Transport for NSW (CC BY 4.0)',
  refreshSeconds: 60,
  normalize: normalizeNsw,
};

interface NswFeature {
  id?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: { region?: unknown; title?: unknown; view?: unknown; direction?: unknown; href?: unknown } | null;
}

export function normalizeNsw(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'FeatureCollection') {
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not a FeatureCollection' }], malformed: true };
  }
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'features is not an array' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  features.forEach((raw: unknown, index: number) => {
    const f = raw as NswFeature;
    const idRaw = f?.id;
    const cameraId =
      typeof idRaw === 'string'
        ? idRaw.trim()
        : typeof idRaw === 'number' && Number.isFinite(idRaw)
          ? String(idRaw)
          : '';
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    const p = f.properties;
    if (!p || typeof p !== 'object') {
      rejected.push({ index, reason: 'missing properties' });
      return;
    }
    const coords =
      f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates)
        ? (f.geometry.coordinates as unknown[])
        : undefined;
    const lon = coords?.[0];
    const lat = coords?.[1];
    if (!isValidLatLon(lat, lon) || !isLikelyNsw(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const href = typeof p.href === 'string' ? p.href.trim() : '';
    if (!isOnHost(href, nswPack.frameHosts)) {
      rejected.push({ index, reason: offHostReason(href) });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 120) : '';
    const view = typeof p.view === 'string' ? p.view.trim() : '';
    const name =
      view && view.length <= MAX_VIEW_LABEL && !/[\r\n]/.test(view) ? view : title || `NSW camera ${cameraId}`;
    const direction = typeof p.direction === 'string' ? p.direction.trim().toUpperCase().slice(0, 10) : '';
    const heading = directionToHeading(direction);
    const region =
      typeof p.region === 'string' && p.region.trim() ? p.region.trim().replace(/_/g, ' ').slice(0, 80) : undefined;
    const extra: Record<string, JsonValue> = {};
    if (title) extra['title'] = title;
    drafts.push(
      draftFromCamera(
        nswPack,
        {
          pack: 'nsw',
          cameraId,
          name,
          latitude: lat,
          longitude: lon as number,
          ...(region ? { region } : {}),
          ...(heading !== undefined ? { headingDegrees: heading } : {}),
          ...(direction ? { direction } : {}),
          frameUrl: href,
          extra,
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: features.length, rejected };
}

function isLikelyNsw(lat: number, lon: number): boolean {
  return lat >= -38 && lat <= -28 && lon >= 140.9 && lon <= 159.2;
}
