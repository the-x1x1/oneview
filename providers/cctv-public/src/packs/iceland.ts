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
 * Icelandic Road and Coastal Administration (IRCA / Vegagerðin) road webcams — IRCA
 * Terms and Conditions: a perpetual, free licence to copy, publish, distribute and adapt,
 * commercially included, with the attribution "Based on information provided by the
 * Icelandic Road and Coastal Administration (IRCA)".
 *
 * One keyless JSON list. Each row is one image: `Maelist_nr` (the station — shared by its
 * cameras, so not an id), `Myndavel` (camera name), `Vegheiti`/`NrVegur` (road), `Skyring`
 * (a description that usually says which way it looks, in Icelandic), `Slod` (the image
 * URL), `Breidd`/`Lengd` (latitude/longitude). The image's file name is the stable id. The
 * frame must be on IRCA's host under /vgdata/vefmyndavelar/. New images arrive several
 * times an hour. No compass heading is published.
 */
export const ICELAND_CAMERAS_URL = 'https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1';
export const ICELAND_FRAME_PREFIX = 'www.vegagerdin.is/vgdata/vefmyndavelar/';

export const icelandPack: CatalogPack = {
  id: 'iceland',
  registryId: 'irca-iceland-webcams',
  request: { url: ICELAND_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 2 * 1024 * 1024 },
  frameHosts: [ICELAND_FRAME_PREFIX],
  attribution: 'Based on information provided by the Icelandic Road and Coastal Administration (IRCA)',
  refreshSeconds: 600,
  normalize: normalizeIceland,
};

interface IcelandRow {
  Maelist_nr?: unknown;
  Myndavel?: unknown;
  Vegheiti?: unknown;
  NrVegur?: unknown;
  Skyring?: unknown;
  Slod?: unknown;
  Breidd?: unknown;
  Lengd?: unknown;
}

export function normalizeIceland(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!Array.isArray(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of cameras' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  payload.forEach((raw: unknown, index: number) => {
    const row = raw as IcelandRow;
    if (!row || typeof row !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const lat = typeof row.Breidd === 'string' ? Number(row.Breidd) : row.Breidd;
    const lon = typeof row.Lengd === 'string' ? Number(row.Lengd) : row.Lengd;
    if (!isValidLatLon(lat, lon) || !isLikelyIceland(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const url = typeof row.Slod === 'string' ? row.Slod.trim().replace(/^http:\/\//i, 'https://') : '';
    if (!isOnHost(url, icelandPack.frameHosts) || !/\.jpe?g$/i.test(new URL(url).pathname)) {
      rejected.push({ index, reason: offHostReason(url) });
      return;
    }
    const cameraId = new URL(url).pathname
      .split('/')
      .pop()!
      .replace(/\.jpe?g$/i, '');
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const description = text(row.Skyring, 140);
    const camera = text(row.Myndavel, 80);
    const road = text(row.Vegheiti, 80);
    drafts.push(
      draftFromCamera(
        icelandPack,
        {
          pack: 'iceland',
          cameraId,
          name: description || camera || `Iceland camera ${cameraId}`,
          latitude: lat,
          longitude: lon as number,
          region: road
            ? `${road}${typeof row.NrVegur === 'string' && row.NrVegur ? ` (${row.NrVegur})` : ''}`
            : 'Iceland',
          frameUrl: url,
          ...(camera ? { extra: { station: camera } } : {}),
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: payload.length, rejected };
}

function isLikelyIceland(lat: number, lon: number): boolean {
  return lat >= 63 && lat <= 67 && lon >= -25 && lon <= -13;
}
