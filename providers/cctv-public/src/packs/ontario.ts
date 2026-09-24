import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { directionToHeading } from '../direction.js';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * Ontario 511 highway cameras — Open Government Licence – Ontario.
 * Adapted from gods-eye-view server/providers/cctv/sources.js (MIT), loadOntarioSourcesFromOpenData.
 *
 * The keyless 511 API returns one row per camera site with `Latitude`, `Longitude`,
 * `Location`, `Roadway`, `Direction` and `Views[]`, each view a still at
 * `https://511on.ca/map/Cctv/<viewId>` with a `Status`. One site is one camera, using its
 * first enabled view (preferring one whose description does not say it is down). The
 * frame URL is rebuilt from the validated view id on 511on.ca — never taken as given — so
 * the frame host is pinned by construction. `Direction` is a dedicated field ("Northbound",
 * "E" …) and becomes the heading when it reads as one; otherwise `heading-unknown`.
 *
 * The registry record asks for one thing to be confirmed at release: that the 511 terms
 * cover the camera images as well as the catalogue.
 */
export const ONTARIO_511_CAMERAS_URL = 'https://511on.ca/api/v2/get/cameras?format=json&lang=en';
/**
 * Ontario 511 now answers 400 without a developer key (`key` in the query; 2026-09-24,
 * https://511on.ca/help/endpoint/cameras). The key is the operator's own, free from
 * 511on.ca/developers; without it the pack waits for the key instead of failing.
 */
export const ONTARIO_511_CREDENTIAL = 'ontario511.apiKey';
export const ONTARIO_511_FRAME_ORIGIN = 'https://511on.ca/map/Cctv/';

const VIEW_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export const ontarioPack: CatalogPack = {
  id: 'ontario',
  registryId: 'ontario-511',
  request: {
    url: ONTARIO_511_CAMERAS_URL,
    headers: { Accept: 'application/json' },
    credential: { key: ONTARIO_511_CREDENTIAL, as: 'query', name: 'key' },
    maxBytes: 8 * 1024 * 1024,
  },
  frameHosts: ['511on.ca'],
  attribution: 'Contains information licensed under the Open Government Licence – Ontario (Ontario 511)',
  refreshSeconds: 120,
  normalize: normalizeOntario,
};

interface OntarioRow {
  Id?: unknown;
  Latitude?: unknown;
  Longitude?: unknown;
  Location?: unknown;
  Roadway?: unknown;
  Direction?: unknown;
  Views?: unknown;
}

interface OntarioView {
  Id?: unknown;
  Url?: unknown;
  Status?: unknown;
  Description?: unknown;
}

export function normalizeOntario(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!Array.isArray(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of cameras' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  payload.forEach((raw: unknown, index: number) => {
    const row = raw as OntarioRow;
    if (!row || typeof row !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const idRaw = row.Id;
    const cameraId =
      typeof idRaw === 'number' && Number.isSafeInteger(idRaw)
        ? String(idRaw)
        : typeof idRaw === 'string'
          ? idRaw.trim()
          : '';
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    const lat = row.Latitude;
    const lon = row.Longitude;
    if (!isValidLatLon(lat, lon) || !isLikelyOntario(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const view = pickView(row.Views);
    if (!view) return; // no enabled still today: not a camera the map can open
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const location = text(row.Location, 120);
    const roadway = text(row.Roadway, 80);
    const viewLabel = view.description && !/\bdown\b/i.test(view.description) ? view.description : '';
    const name = [location || roadway || `Ontario 511 camera ${cameraId}`, viewLabel].filter(Boolean).join(' — ');
    const direction = text(row.Direction, 20);
    const heading = directionToHeading(direction);
    drafts.push(
      draftFromCamera(
        ontarioPack,
        {
          pack: 'ontario',
          cameraId,
          name: name.slice(0, 160),
          latitude: lat,
          longitude: lon as number,
          region: 'Ontario',
          ...(heading !== undefined ? { headingDegrees: heading, direction } : {}),
          frameUrl: `${ONTARIO_511_FRAME_ORIGIN}${encodeURIComponent(view.id)}`,
          ...(roadway ? { extra: { roadway } } : {}),
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: payload.length, rejected };
}

/** The first enabled view whose URL is a 511 still; one not described as down wins. */
function pickView(views: unknown): { id: string; description: string } | undefined {
  if (!Array.isArray(views)) return undefined;
  const usable: Array<{ id: string; description: string }> = [];
  for (const v of views as OntarioView[]) {
    if (
      String(v?.Status ?? '')
        .trim()
        .toLowerCase() !== 'enabled'
    )
      continue;
    const id = viewIdFromUrl(v?.Url);
    if (!id) continue;
    usable.push({ id, description: text(v?.Description, 80) });
  }
  return usable.find((v) => !/\bdown\b/i.test(v.description)) ?? usable[0];
}

/** `https://511on.ca/map/Cctv/<id>` (or the same path on the 511 vendor host) → `<id>`. */
function viewIdFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || (host !== '511on.ca' && !host.endsWith('.traveliq.co'))) return undefined;
  const m = /^\/map\/Cctv\/([^/?#]+)$/.exec(u.pathname);
  if (!m) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  return VIEW_ID.test(id) ? id : undefined;
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function isLikelyOntario(lat: number, lon: number): boolean {
  return lat >= 41 && lat <= 57.5 && lon >= -95.6 && lon <= -74;
}
