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
 * The 511 traveller-information platform that many road agencies run from one vendor
 * (Ontario 511, 511NY, UDOT Traffic, AZ511, 511GA, Idaho 511 …) publishes its cameras
 * the same way: `GET https://<site>/api/v2/get/cameras?key=<developer key>&format=json`
 * answers an array of camera *sites*, each with `Id`, `Latitude`, `Longitude`, `Location`,
 * `Roadway`, `Direction` and `Views[]`, and each view a still at
 * `https://<site>/map/Cctv/<viewId>` with a `Status`. The documentation pages are
 * `https://<site>/help/endpoint/cameras`; every one read (2026-09-27) shows this shape and
 * the same throttle, ten calls a minute per key — one catalogue call per poll is far inside it.
 *
 * One site is one camera, using its first enabled view (preferring one whose description
 * does not say it is down). The frame URL is rebuilt from the validated view id on the
 * site's own host — never taken as given — so the frame host is pinned by construction.
 * `Direction` is a dedicated field ("Northbound", "E" …) and becomes the heading when it
 * reads as one; otherwise the camera is flagged `heading-unknown`.
 *
 * The operator-side scrape OSIRIS uses for these sites (`/List/GetData/Cameras`, the web
 * map's paged table) is deliberately not used: the developer API is the documented,
 * keyed route the agencies offer for reuse.
 */
export interface Ibi511Site {
  /** Host whose `/map/Cctv/<id>` serves the stills (and the catalogue). */
  frameHost: string;
  /** Other hosts a view URL may name for the same stills (vendor or bare-domain aliases). */
  viewHostAliases?: readonly string[];
  /** Host suffixes a view URL may name (Ontario's vendor host `*.traveliq.co`). */
  viewHostSuffixes?: readonly string[];
  /** Region label on every camera. */
  region: string;
  /** Fallback name prefix ("Ontario 511 camera 4101"). */
  label: string;
  /** Plausible bounds; a row outside them is refused as mis-geocoded. */
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

/** The keyed catalogue request for a site (the key goes in the `key` query parameter). */
export function ibi511Request(host: string, credentialKey: string): CatalogPack['request'] {
  return {
    url: ibi511CamerasUrl(host),
    headers: { Accept: 'application/json' },
    credential: { key: credentialKey, as: 'query', name: 'key' },
    maxBytes: 16 * 1024 * 1024,
  };
}

export const ibi511CamerasUrl = (host: string): string => `https://${host}/api/v2/get/cameras?format=json&lang=en`;

const VIEW_ID = /^[A-Za-z0-9_.-]{1,64}$/;

interface Ibi511Row {
  Id?: unknown;
  Latitude?: unknown;
  Longitude?: unknown;
  Location?: unknown;
  Roadway?: unknown;
  Direction?: unknown;
  Views?: unknown;
}

interface Ibi511View {
  Id?: unknown;
  Url?: unknown;
  Status?: unknown;
  Description?: unknown;
}

export function normalizeIbi511(
  pack: CatalogPack,
  site: Ibi511Site,
  payload: unknown,
  opts: PackNormalizeOptions,
): PackNormalizeResult {
  if (!Array.isArray(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of cameras' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  const { bbox } = site;
  payload.forEach((raw: unknown, index: number) => {
    const row = raw as Ibi511Row;
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
    if (
      !isValidLatLon(lat, lon) ||
      lat < bbox.minLat ||
      lat > bbox.maxLat ||
      (lon as number) < bbox.minLon ||
      (lon as number) > bbox.maxLon
    ) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const view = pickView(row.Views, site);
    if (!view) return; // no enabled still today: not a camera the map can open
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const location = text(row.Location, 120);
    const roadway = text(row.Roadway, 80);
    const viewLabel = view.description && !/\bdown\b/i.test(view.description) ? view.description : '';
    const name = [location || roadway || `${site.label} ${cameraId}`, viewLabel].filter(Boolean).join(' — ');
    const direction = text(row.Direction, 20);
    const heading = directionToHeading(direction);
    drafts.push(
      draftFromCamera(
        pack,
        {
          pack: pack.id,
          cameraId,
          name: name.slice(0, 160),
          latitude: lat,
          longitude: lon as number,
          region: site.region,
          ...(heading !== undefined ? { headingDegrees: heading, direction } : {}),
          frameUrl: `https://${site.frameHost}/map/Cctv/${encodeURIComponent(view.id)}`,
          ...(roadway ? { extra: { roadway } } : {}),
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: payload.length, rejected };
}

/** The first enabled view whose URL is one of the site's stills; one not described as down wins. */
function pickView(views: unknown, site: Ibi511Site): { id: string; description: string } | undefined {
  if (!Array.isArray(views)) return undefined;
  const usable: Array<{ id: string; description: string }> = [];
  for (const v of views as Ibi511View[]) {
    if (
      String(v?.Status ?? '')
        .trim()
        .toLowerCase() !== 'enabled'
    )
      continue;
    const id = viewIdFromUrl(v?.Url, site);
    if (!id) continue;
    usable.push({ id, description: text(v?.Description, 80) });
  }
  return usable.find((v) => !/\bdown\b/i.test(v.description)) ?? usable[0];
}

/** `https://<site>/map/Cctv/<id>` (or the same path on an alias host) → `<id>`. */
function viewIdFromUrl(value: unknown, site: Ibi511Site): string | undefined {
  if (typeof value !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  const known =
    host === site.frameHost ||
    (site.viewHostAliases ?? []).includes(host) ||
    (site.viewHostSuffixes ?? []).some((s) => host.endsWith(s));
  // http is accepted here because the still is rebuilt on https on the pinned host anyway;
  // some sites list their views with the scheme they were configured with years ago.
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !known) return undefined;
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
