import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  invalidIdReason,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from '../packs/types.js';

/**
 * Lithuanian road cameras (eismoinfo.lt, the traffic site of the Lithuanian Road
 * Administration) — licence NOT confirmed (the `public-cameras-unverified` provider): the
 * site states no terms, and the administration's open-data pages could not be read from
 * the build machine.
 *
 * The camera table the site's own map loads, keyless:
 * `[ { id, name, roadName, roadNr, km, date, image, x, y } ]` — 448 rows on 2026-09-27.
 * `x`/`y` are LKS94 (EPSG:3346, Transverse Mercator on GRS80, central meridian 24° E,
 * scale 0.9998, false easting 500 000 m) easting and northing, converted here to WGS 84
 * (the GRS80/WGS 84 difference is well under a metre). The still is
 * `https://eismoinfo.lt/eismoinfo-backend/image-provider/camera/last?id=<id>` (checked
 * 2026-09-27: it answers as an image); it is rebuilt from the validated numeric id, never
 * taken from the row. No facing is published.
 */
export const LITHUANIA_CAMERAS_URL = 'https://eismoinfo.lt/eismoinfo-backend/camera-info-table';
export const LITHUANIA_FRAME_PREFIX = 'eismoinfo.lt/eismoinfo-backend/image-provider/camera/';

export const lithuaniaPack: CatalogPack = {
  id: 'lithuania',
  registryId: 'eismoinfo-lt-cameras',
  request: { url: LITHUANIA_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 4 * 1024 * 1024 },
  frameHosts: [LITHUANIA_FRAME_PREFIX],
  attribution: 'Lietuvos automobilių kelių direkcija — eismoinfo.lt (courtesy); licence not confirmed',
  refreshSeconds: 300,
  normalize: normalizeLithuania,
};

interface LtRow {
  id?: unknown;
  name?: unknown;
  roadName?: unknown;
  roadNr?: unknown;
  km?: unknown;
  x?: unknown;
  y?: unknown;
}

export function normalizeLithuania(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!Array.isArray(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of cameras' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  payload.forEach((raw: unknown, index: number) => {
    const row = raw as LtRow;
    if (!row || typeof row !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const id = row.id;
    const cameraId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : '';
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: invalidIdReason(id) });
      return;
    }
    const pos = typeof row.x === 'number' && typeof row.y === 'number' ? lks94ToWgs84(row.x, row.y) : undefined;
    if (!pos || !isValidLatLon(pos.latitude, pos.longitude) || !isLikelyLithuania(pos.latitude, pos.longitude)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const name = text(row.name, 120);
    const roadName = text(row.roadName, 80);
    const roadNr = text(row.roadNr, 12);
    drafts.push(
      draftFromCamera(
        lithuaniaPack,
        {
          pack: 'lithuania',
          cameraId,
          name: name || `Lithuanian road camera ${cameraId}`,
          latitude: pos.latitude,
          longitude: pos.longitude,
          region: [roadNr, roadName].filter(Boolean).join(' ') || 'Lithuania',
          frameUrl: `https://${LITHUANIA_FRAME_PREFIX}last?id=${cameraId}`,
          ...(roadNr ? { extra: { roadway: roadNr } } : {}),
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: payload.length, rejected };
}

// GRS80, as LKS94 defines it.
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9998;
const LON0 = (24 * Math.PI) / 180;
const FALSE_EASTING = 500000;

/**
 * LKS94 (EPSG:3346) easting/northing in metres → latitude/longitude in degrees, by the
 * standard inverse Transverse Mercator series (Snyder, "Map Projections — A Working
 * Manual", USGS Professional Paper 1395), far below a metre's error over Lithuania's few
 * degrees of longitude. Undefined for inputs that are not finite.
 */
export function lks94ToWgs84(easting: number, northing: number): { latitude: number; longitude: number } | undefined {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return undefined;
  const m = northing / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const tan = Math.tan(phi1);
  const c1 = EP2 * cos * cos;
  const t1 = tan * tan;
  const n1 = A / Math.sqrt(1 - E2 * sin * sin);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin * sin) ** 1.5;
  const d = (easting - FALSE_EASTING) / (n1 * K0);
  const lat =
    phi1 -
    ((n1 * tan) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720);
  const lon =
    LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
      cos;
  return { latitude: (lat * 180) / Math.PI, longitude: (lon * 180) / Math.PI };
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function isLikelyLithuania(lat: number, lon: number): boolean {
  return lat >= 53.8 && lat <= 56.5 && lon >= 20.8 && lon <= 26.9;
}
