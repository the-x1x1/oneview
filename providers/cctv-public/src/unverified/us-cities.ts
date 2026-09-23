import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { directionToHeading } from '../direction.js';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  invalidIdReason,
  isOnHost,
  type CatalogPack,
  type PackCameraDraft,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from '../packs/types.js';

/**
 * Three US catalogues whose camera IMAGES carry no reuse licence we could find (the
 * `public-cameras-unverified` provider, off by default):
 *
 *  - City of Austin (Socrata b4k4-adkb): the dataset is marked Public Domain; the frames on
 *    cctv.austinmobility.io are not separately licensed.
 *  - NYC DOT (webcams.nyctmc.org): no terms found at all.
 *  - Iowa DOT (ArcGIS Traffic_Cameras_View): the catalogue is CC BY 4.0, but Iowa DOT's
 *    general terms reserve other content, and the images are not named in the licence.
 */
type Row = Record<string, unknown>;

function normalizeRows(
  pack: CatalogPack,
  rows: unknown[],
  opts: PackNormalizeOptions,
  pick: (row: Row) => (Omit<PackCameraDraft, 'pack'> & { skip?: boolean }) | string,
  bbox: (lat: number, lon: number) => boolean,
): PackNormalizeResult {
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const cam = pick(raw as Row);
    if (typeof cam === 'string') {
      rejected.push({ index, reason: cam });
      return;
    }
    if (cam.skip) return;
    if (!CAMERA_ID_PATTERN.test(cam.cameraId)) {
      rejected.push({ index, reason: invalidIdReason(cam.cameraId) });
      return;
    }
    if (!isValidLatLon(cam.latitude, cam.longitude) || !bbox(cam.latitude, cam.longitude)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    if (!isOnHost(cam.frameUrl, pack.frameHosts)) {
      rejected.push({ index, reason: 'frame url not on the pinned host' });
      return;
    }
    if (seen.has(cam.cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cam.cameraId}` });
      return;
    }
    seen.add(cam.cameraId);
    drafts.push(draftFromCamera(pack, { ...cam, pack: pack.id }, opts, raw as JsonValue));
  });
  return { drafts, total: rows.length, rejected };
}

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

// ── Austin ────────────────────────────────────────────────────────────────────
export const AUSTIN_CAMERAS_URL = 'https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=2000';
export const austinPack: CatalogPack = {
  id: 'austin',
  registryId: 'city-of-austin-cctv',
  request: { url: AUSTIN_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 },
  frameHosts: ['cctv.austinmobility.io'],
  attribution: 'City of Austin, Texas — data.austintexas.gov (images: licence not confirmed)',
  refreshSeconds: 120,
  normalize: (payload, opts) =>
    Array.isArray(payload)
      ? normalizeRows(
          austinPack,
          payload,
          opts,
          (r) => {
            if (str(r['camera_status']) !== 'TURNED_ON') return { skip: true } as never;
            const coords = (r['location'] as { coordinates?: unknown } | undefined)?.coordinates;
            const [lon, lat] = Array.isArray(coords) ? coords.map(num) : [NaN, NaN];
            const id = str(r['camera_id'], 20);
            return {
              cameraId: id,
              name: str(r['location_name']) || `Austin camera ${id}`,
              latitude: lat!,
              longitude: lon!,
              region: 'Austin, Texas',
              frameUrl: str(r['screenshot_address'], 300),
            };
          },
          (lat, lon) => lat >= 29.9 && lat <= 30.7 && lon >= -98.2 && lon <= -97.3,
        )
      : { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of rows' }], malformed: true },
};

// ── New York City ─────────────────────────────────────────────────────────────
export const NYC_CAMERAS_URL = 'https://webcams.nyctmc.org/api/cameras';
export const nycPack: CatalogPack = {
  id: 'nyc',
  registryId: 'nyc-dot-webcams',
  request: { url: NYC_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 },
  frameHosts: ['webcams.nyctmc.org'],
  attribution: 'NYC Department of Transportation — licence not confirmed',
  refreshSeconds: 60,
  normalize: (payload, opts) =>
    Array.isArray(payload)
      ? normalizeRows(
          nycPack,
          payload,
          opts,
          (r) => {
            if (r['isOnline'] === false || String(r['isOnline']).toLowerCase() === 'false')
              return { skip: true } as never;
            const id = str(r['id'], 64);
            return {
              cameraId: id,
              name: str(r['name']) || `NYC camera ${id}`,
              latitude: num(r['latitude']),
              longitude: num(r['longitude']),
              region: str(r['area'], 40) || 'New York City',
              frameUrl: str(r['imageUrl'], 300),
            };
          },
          (lat, lon) => lat >= 40.4 && lat <= 41.0 && lon >= -74.35 && lon <= -73.6,
        )
      : { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of cameras' }], malformed: true },
};

// ── Iowa ──────────────────────────────────────────────────────────────────────
/**
 * One row per camera *view*: a device with two directions is two rows with the same
 * `device_id`, so the image's file name is the id. One request: the hosted layer refused
 * paged queries (resultOffset + orderByFields) on the operator's machine, and answers the
 * whole list in one page; if it ever stops doing so it says `exceededTransferLimit`, and
 * that is reported rather than a short list passing for the whole one.
 */
export const IOWA_CAMERAS_URL =
  'https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1%3D1&outFields=device_id,ImageName,ImageURL,latitude,longitude,REGION,Route&returnGeometry=false&f=json';
export const iowaPack: CatalogPack = {
  id: 'iowa',
  registryId: 'iowa-dot-cameras',
  request: { url: IOWA_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 },
  frameHosts: ['atmsqf.iowadot.gov'],
  attribution: 'Iowa Department of Transportation (catalogue CC BY 4.0; images: licence not confirmed)',
  refreshSeconds: 120,
  normalize: (payload, opts) => {
    const p = payload as { features?: unknown; error?: { message?: unknown }; exceededTransferLimit?: unknown } | null;
    if (!Array.isArray(p?.features)) {
      const why =
        typeof p?.error?.message === 'string' ? `ArcGIS error: ${p.error.message.slice(0, 100)}` : 'no features';
      return { drafts: [], total: 0, rejected: [{ index: -1, reason: why }], malformed: true };
    }
    const result = normalizeRows(
      iowaPack,
      p.features.map((f) => (f as { attributes?: unknown } | null)?.attributes ?? f),
      opts,
      (r) => {
        const device = String(r['device_id'] ?? '').trim();
        const image = str(r['ImageURL'], 300);
        const file = /\/([A-Za-z0-9._-]{1,60})\.(?:jpe?g|png)$/i.exec(image)?.[1];
        const id = file ?? device;
        return {
          cameraId: id,
          name: str(r['ImageName']) || `Iowa camera ${id}`,
          latitude: num(r['latitude']),
          longitude: num(r['longitude']),
          region: [str(r['Route'], 30), str(r['REGION'], 40)].filter(Boolean).join(', ') || 'Iowa',
          frameUrl: image,
          ...(device ? { extra: { device } } : {}),
        };
      },
      (lat, lon) => lat >= 40.3 && lat <= 43.6 && lon >= -96.7 && lon <= -90.1,
    );
    if (p.exceededTransferLimit === true)
      result.rejected.push({ index: -1, reason: 'list truncated by the server (exceededTransferLimit)' });
    return result;
  },
};

// ── New Zealand ───────────────────────────────────────────────────────────────
/**
 * NZ Transport Agency Waka Kotahi — the Journey Planner's camera list (GeoJSON, keyless).
 * The Journey Planner says "© NZ Transport Agency Waka Kotahi, all rights reserved"; NZTA
 * publishes much of its data under CC BY 4.0, but no statement covering these images was
 * found, so the pack is here rather than in the default source. Frames live under
 * www.trafficnz.info/camera/.
 */
export const NZTA_CAMERAS_URL = 'https://www.journeys.nzta.govt.nz/assets/map-data-cache/cameras.json';
export const nztaPack: CatalogPack = {
  id: 'nzta',
  registryId: 'nzta-traffic-cameras',
  request: { url: NZTA_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 4 * 1024 * 1024 },
  frameHosts: ['www.trafficnz.info/camera/'],
  attribution: 'NZ Transport Agency Waka Kotahi — licence not confirmed',
  refreshSeconds: 120,
  normalize: (payload, opts) => {
    const features = (payload as { type?: unknown; features?: unknown } | null)?.features;
    if (!Array.isArray(features))
      return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not a FeatureCollection' }], malformed: true };
    return normalizeRows(
      nztaPack,
      features.map((f) => {
        const p = (f as { properties?: unknown } | null)?.properties;
        const coords = (f as { geometry?: { coordinates?: unknown } } | null)?.geometry?.coordinates;
        return p && typeof p === 'object' ? { ...(p as Row), __coords: coords } : f;
      }),
      opts,
      (r) => {
        const id = typeof r['ExternalId'] === 'number' ? String(r['ExternalId']) : str(r['ExternalId'], 20);
        const coords = Array.isArray(r['__coords']) ? (r['__coords'] as unknown[]) : [];
        const lon = coords.length === 2 ? num(coords[0]) : num(r['Longitude']);
        const lat = coords.length === 2 ? num(coords[1]) : num(r['Latitude']);
        const direction = str(r['Direction'], 20);
        const heading = directionToHeading(direction);
        return {
          cameraId: id,
          name: str(r['Name']) || `NZTA camera ${id}`,
          latitude: lat,
          longitude: lon,
          region: str(r['Description'], 80) || 'New Zealand',
          ...(heading !== undefined ? { headingDegrees: heading, direction } : {}),
          frameUrl: str(r['ImageUrl'], 300).replace(/^http:\/\//i, 'https://'),
        };
      },
      (lat, lon) => lat >= -47.5 && lat <= -34 && lon >= 166 && lon <= 179,
    );
  },
};
