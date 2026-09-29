import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { directionToHeading } from '../direction.js';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  invalidIdReason,
  isOnHost,
  offHostReason,
  type CatalogPack,
  type CatalogRequest,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * Illinois Department of Transportation — "Illinois Gateway Traffic Cameras", the camera
 * snapshots of the Gateway Traveler Information system (travelmidwest.com), published by
 * IDOT on its ArcGIS open data hub. The item states: "This work is licensed under a
 * Creative Commons Attribution-ShareAlike 2.0 Generic License"
 * (https://www.arcgis.com/home/item.html?id=8a885da23dfb46caaa1827ad920fb5b1, read 2026-09-27).
 * Share-alike attaches only to adaptations WORLDVIEW would publish (an exported catalogue);
 * frames are never redistributed (the global CCTV frame rule).
 *
 * The layer (`TrafficCamerasTM_Public`, 1,749 rows on 2026-09-27) has one row per camera
 * *view*: `CameraLocation`, `CameraDirection` (N/E/S/W or NONE), `x`/`y` and `SnapShot`, a
 * still under `https://cctv.travelmidwest.com/snapshots/`. `ImgPath` is the Gateway viewer
 * link, `https://travelmidwest.com/showCamera?id=<device>&direction=<dir>`; the device id and
 * direction are the camera id (OBJECTID changes whenever the hosted layer is reloaded).
 *
 * The layer answers at most 1,000 rows a request, so the catalogue is read in pages ordered
 * by OBJECTID (checked: offset 1700 answered the last 44 rows on 2026-09-27; by 2026-09-29
 * three pages were full). Six pages leave room for growth; a page past the end answers no rows. If the last page still says
 * `exceededTransferLimit`, that is reported rather than a short list passing for the whole.
 */
const LAYER =
  'https://services2.arcgis.com/aIrBD8yn1TDTEXoz/arcgis/rest/services/TrafficCamerasTM_Public/FeatureServer/0/query';
export const ILLINOIS_PAGE_SIZE = 1000;
export const illinoisCamerasUrl = (offset: number): string =>
  `${LAYER}?where=1%3D1&outFields=ImgPath,CameraLocation,CameraDirection,SnapShot&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=${offset}&resultRecordCount=${ILLINOIS_PAGE_SIZE}&f=json`;
export const ILLINOIS_CAMERAS_URL = illinoisCamerasUrl(0);
export const ILLINOIS_FRAME_PREFIX = 'cctv.travelmidwest.com/snapshots/';
/**
 * Partner agencies whose cameras the Gateway layer lists with images on their own hosts. The
 * layer's CC BY-SA 2.0 is IDOT's; these hosts publish no terms of their own (checked
 * 2026-09-28), so their rows are left out — licences fail closed — and reported as excluded,
 * not as rejected data.
 */
export const ILLINOIS_PARTNER_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  'www.lakecountypassage.com/snapshots/': 'Lake County PASSAGE (no licence on record)',
});

const page = (offset: number): CatalogRequest => ({
  url: illinoisCamerasUrl(offset),
  headers: { Accept: 'application/json' },
  maxBytes: 8 * 1024 * 1024,
});

export const illinoisPack: CatalogPack = {
  id: 'illinois',
  registryId: 'idot-gateway-cameras',
  request: page(0),
  // Six pages: the layer held 1,749 rows on 2026-09-27 and filled all three pages first given
  // (3,000+) by 2026-09-29. A page past the end answers no rows, cheaply.
  moreRequests: [1, 2, 3, 4, 5].map((n) => page(n * ILLINOIS_PAGE_SIZE)),
  frameHosts: [ILLINOIS_FRAME_PREFIX],
  attribution: 'Illinois Department of Transportation — Gateway Traveler Information, CC BY-SA 2.0',
  refreshSeconds: 300,
  normalize: normalizeIllinois,
};

interface ArcgisPage {
  features?: unknown;
  exceededTransferLimit?: unknown;
  error?: { message?: unknown };
}

interface IllinoisRow {
  ImgPath?: unknown;
  CameraLocation?: unknown;
  CameraDirection?: unknown;
  SnapShot?: unknown;
  x?: unknown;
  y?: unknown;
}

/** `payload` is one page or the array of pages (moreRequests). */
export function normalizeIllinois(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  const pages = (Array.isArray(payload) ? payload : [payload]) as Array<ArcgisPage | null>;
  if (!pages.some((p) => Array.isArray(p?.features))) {
    const err = pages.find((p) => typeof p?.error?.message === 'string')?.error?.message as string | undefined;
    const why = err ? `ArcGIS error: ${err.slice(0, 100)}` : 'no features';
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: why }], malformed: true };
  }
  const rows: Array<{ attributes: IllinoisRow; geometry: { x?: unknown; y?: unknown } | undefined }> = [];
  for (const p of pages)
    if (Array.isArray(p?.features))
      for (const f of p.features as Array<{ attributes?: unknown; geometry?: unknown } | null>)
        rows.push({
          attributes: (f?.attributes ?? {}) as IllinoisRow,
          geometry: (f?.geometry ?? undefined) as { x?: unknown; y?: unknown } | undefined,
        });
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const excluded: Record<string, number> = {};
  const seen = new Set<string>();
  rows.forEach(({ attributes: a, geometry: g }, index) => {
    const viewer = parseViewer(a.ImgPath);
    const direction = text(a.CameraDirection, 8).toUpperCase();
    const facing = direction && direction !== 'NONE' ? direction : '';
    const cameraId = viewer ? (facing ? `${viewer}.${facing}` : viewer) : '';
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: invalidIdReason(viewer ?? a.ImgPath) });
      return;
    }
    const lat = num(g?.y ?? a.y);
    const lon = num(g?.x ?? a.x);
    if (!isValidLatLon(lat, lon) || !isLikelyGatewayArea(lat, lon)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const frameUrl = text(a.SnapShot, 300).replace(/^http:\/\//i, 'https://');
    if (!isOnHost(frameUrl, illinoisPack.frameHosts)) {
      const partner = Object.entries(ILLINOIS_PARTNER_HOSTS).find(([host]) => isOnHost(frameUrl, [host]));
      if (partner) {
        excluded[partner[1]] = (excluded[partner[1]] ?? 0) + 1;
        return;
      }
      rejected.push({ index, reason: offHostReason(frameUrl) });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const heading = facing ? directionToHeading(facing) : undefined;
    const location = text(a.CameraLocation, 120);
    drafts.push(
      draftFromCamera(
        illinoisPack,
        {
          pack: 'illinois',
          cameraId,
          name: (location || `Illinois camera ${viewer}`) + (facing ? ` — facing ${facing}` : ''),
          latitude: lat,
          longitude: lon,
          region: 'Illinois',
          ...(heading !== undefined ? { headingDegrees: heading, direction: facing } : {}),
          frameUrl,
          extra: { device: viewer! },
        },
        opts,
        { attributes: a, geometry: g ?? null } as unknown as JsonValue,
      ),
    );
  });
  const last = pages[pages.length - 1];
  if (last?.exceededTransferLimit === true)
    rejected.push({ index: -1, reason: 'list truncated by the server (exceededTransferLimit on the last page)' });
  return { drafts, total: rows.length, rejected, ...(Object.keys(excluded).length ? { excluded } : {}) };
}

/** `https://travelmidwest.com/showCamera?id=<device>&direction=…` → `<device>`. */
function parseViewer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (!/(^|\.)travelmidwest\.com$/i.test(u.hostname)) return undefined;
  const id = u.searchParams.get('id')?.trim() ?? '';
  return /^[A-Za-z0-9_-]{1,56}$/.test(id) ? id : undefined;
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
}

/** Illinois and the Gateway's edges in Indiana, Wisconsin and Missouri. */
function isLikelyGatewayArea(lat: number, lon: number): boolean {
  return lat >= 36.8 && lat <= 43.2 && lon >= -91.8 && lon <= -86.2;
}
