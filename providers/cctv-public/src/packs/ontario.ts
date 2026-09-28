import { normalizeIbi511, type Ibi511Site } from './ibi511.js';
import type { CatalogPack, PackNormalizeOptions, PackNormalizeResult } from './types.js';

/**
 * Ontario 511 highway cameras — Open Government Licence – Ontario.
 * Adapted from gods-eye-view server/providers/cctv/sources.js (MIT), loadOntarioSourcesFromOpenData.
 *
 * The keyless 511 API returns one row per camera site with `Latitude`, `Longitude`,
 * `Location`, `Roadway`, `Direction` and `Views[]`, each view a still at
 * `https://511on.ca/map/Cctv/<viewId>` with a `Status`. Ontario runs the same 511 platform
 * as 511NY, UDOT and others, so the rows are read by the shared `normalizeIbi511` (ibi511.ts),
 * which says how a site becomes one camera and why the frame URL is rebuilt, not taken.
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

const ONTARIO_SITE: Ibi511Site = {
  frameHost: '511on.ca',
  // The 511 vendor's own host serves the same stills under the same path.
  viewHostSuffixes: ['.traveliq.co'],
  region: 'Ontario',
  label: 'Ontario 511 camera',
  bbox: { minLat: 41, maxLat: 57.5, minLon: -95.6, maxLon: -74 },
};

export function normalizeOntario(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  return normalizeIbi511(ontarioPack, ONTARIO_SITE, payload, opts);
}
