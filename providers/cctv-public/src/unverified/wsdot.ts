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
 * Washington State DOT cameras — licence NOT confirmed (the `public-cameras-unverified`
 * provider). WSDOT's GIS server publishes the camera layer of its travel map as a keyless
 * ArcGIS feature layer ("WSDOT camera locations along state routes, with images refreshed
 * approximately every 5 minutes"; copyright text "Washington State Department of
 * Transportation"; no licence on the item). WSDOT's Traveler Information API serves the
 * same cameras with an access code, under a page that states no terms of use either
 * (https://wsdot.wa.gov/traffic/api/, read 2026-09-27); the keyless layer is used so the
 * operator needs no code.
 *
 * Fields: `OBJECTID` (alias CameraID), `CameraTitle`, `ImageURL`, `CompassDirection` and a
 * WGS 84 point. 1,705 rows on 2026-09-27, under the layer's 2,000-row page, so one
 * request; `exceededTransferLimit` on a reply is reported rather than a short list
 * passing for the whole. WSDOT's own stills are on images.wsdot.wa.gov; partner cameras
 * on the same map (ODOT TripCheck on the Columbia bridges, cities) point at their owners'
 * hosts and are left out, since their owners' terms are not WSDOT's.
 */
export const WSDOT_CAMERAS_URL =
  'https://data.wsdot.wa.gov/arcgis/rest/services/TravelInformation/TravelInfoCamerasWeather/FeatureServer/0/query?where=1%3D1&outFields=OBJECTID,CameraTitle,ImageURL,CompassDirection&returnGeometry=true&outSR=4326&f=json';

export const wsdotPack: CatalogPack = {
  id: 'wsdot',
  registryId: 'wsdot-cameras',
  request: { url: WSDOT_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 },
  frameHosts: ['images.wsdot.wa.gov'],
  attribution: 'Washington State Department of Transportation — licence not confirmed',
  refreshSeconds: 300,
  normalize: normalizeWsdot,
};

interface WsdotFeature {
  attributes?: {
    OBJECTID?: unknown;
    CameraTitle?: unknown;
    ImageURL?: unknown;
    CompassDirection?: unknown;
  } | null;
  geometry?: { x?: unknown; y?: unknown } | null;
}

export function normalizeWsdot(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  const p = payload as { features?: unknown; exceededTransferLimit?: unknown; error?: { message?: unknown } } | null;
  if (!Array.isArray(p?.features)) {
    const why =
      typeof p?.error?.message === 'string' ? `ArcGIS error: ${p.error.message.slice(0, 100)}` : 'no features';
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: why }], malformed: true };
  }
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  (p.features as Array<WsdotFeature | null>).forEach((f, index) => {
    const a = f?.attributes ?? {};
    const cameraId =
      typeof a.OBJECTID === 'number' && Number.isSafeInteger(a.OBJECTID) && a.OBJECTID > 0 ? String(a.OBJECTID) : '';
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    const lat = f?.geometry?.y;
    const lon = f?.geometry?.x;
    if (!isValidLatLon(lat, lon) || !isLikelyWashington(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const frameUrl = (typeof a.ImageURL === 'string' ? a.ImageURL.trim() : '').replace(/^http:\/\//i, 'https://');
    if (!isOnHost(frameUrl, wsdotPack.frameHosts)) {
      rejected.push({ index, reason: offHostReason(frameUrl) });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const direction = typeof a.CompassDirection === 'string' ? a.CompassDirection.trim().slice(0, 5) : '';
    const heading = directionToHeading(direction);
    const title = typeof a.CameraTitle === 'string' ? a.CameraTitle.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
    drafts.push(
      draftFromCamera(
        wsdotPack,
        {
          pack: 'wsdot',
          cameraId,
          name: title || `WSDOT camera ${cameraId}`,
          latitude: lat,
          longitude: lon as number,
          region: 'Washington State',
          ...(heading !== undefined ? { headingDegrees: heading, direction } : {}),
          frameUrl,
        },
        opts,
        (f ?? null) as unknown as JsonValue,
      ),
    );
  });
  if (p.exceededTransferLimit === true)
    rejected.push({ index: -1, reason: 'list truncated by the server (exceededTransferLimit)' });
  return { drafts, total: p.features.length, rejected };
}

function isLikelyWashington(lat: number, lon: number): boolean {
  return lat >= 45.4 && lat <= 49.1 && lon >= -124.9 && lon <= -116.8;
}
