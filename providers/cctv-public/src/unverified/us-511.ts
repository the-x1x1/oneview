import { ibi511CamerasUrl, ibi511Request, normalizeIbi511, type Ibi511Site } from '../packs/ibi511.js';
import type { CatalogPack } from '../packs/types.js';

/**
 * US state 511 sites on the same platform as Ontario 511 (packs/ibi511.ts), each needing
 * the operator's own free developer key — in the `public-cameras-unverified` provider
 * because no licence covering the camera images was found:
 *
 *  - 511NY (New York State DOT): the Developer's Access Agreement
 *    (https://511ny.org/developers/daa, read 2026-09-27) lets a "Data Disseminator"
 *    "redistribute, enhance, repackage, or otherwise add value to the provided data" at no
 *    fee, provided the source data's integrity is preserved and "powered by 511NY" is shown;
 *    NYSDOT may end the service or the permission at any time. That is a revocable grant
 *    with a condition, not an open licence, and it does not name the images.
 *  - UDOT Traffic (Utah), AZ511 (Arizona), 511GA (Georgia), Idaho 511: the developer pages
 *    state a key requirement and a throttle (ten calls a minute) and no licence or terms.
 *
 * Each pack waits for its key (Sources → Credentials) rather than failing; nothing is
 * fetched from a site whose key is not stored. Endpoint shape and a still per site were
 * checked on 2026-09-27 against each site's `/help/endpoint/cameras` page and one
 * `/map/Cctv/<id>` image; the catalogues themselves were not fetched (they need a key).
 */
interface StateSite extends Ibi511Site {
  id: string;
  registryId: string;
  credential: string;
  attribution: string;
}

const STATES: readonly StateSite[] = [
  {
    id: 'ny511',
    registryId: 'ny511-cameras',
    credential: 'ny511.apiKey',
    frameHost: '511ny.org',
    viewHostAliases: ['www.511ny.org'],
    region: 'New York State',
    label: '511NY camera',
    bbox: { minLat: 40.4, maxLat: 45.1, minLon: -80, maxLon: -71.7 },
    attribution: 'Powered by 511NY (New York State DOT) — licence not confirmed',
  },
  {
    id: 'udot',
    registryId: 'udot-traffic-cameras',
    credential: 'udot.apiKey',
    frameHost: 'www.udottraffic.utah.gov',
    viewHostAliases: ['udottraffic.utah.gov'],
    region: 'Utah',
    label: 'UDOT camera',
    bbox: { minLat: 36.9, maxLat: 42.1, minLon: -114.1, maxLon: -108.9 },
    attribution: 'Utah Department of Transportation — UDOT Traffic (courtesy); licence not confirmed',
  },
  {
    id: 'az511',
    registryId: 'az511-cameras',
    credential: 'az511.apiKey',
    frameHost: 'az511.com',
    viewHostAliases: ['www.az511.com', 'az511.gov', 'www.az511.gov'],
    region: 'Arizona',
    label: 'AZ511 camera',
    bbox: { minLat: 31.2, maxLat: 37.1, minLon: -115, maxLon: -108.9 },
    attribution: 'Arizona Department of Transportation — AZ511 (courtesy); licence not confirmed',
  },
  {
    id: 'ga511',
    registryId: 'ga511-cameras',
    credential: 'ga511.apiKey',
    frameHost: '511ga.org',
    viewHostAliases: ['www.511ga.org'],
    region: 'Georgia',
    label: '511GA camera',
    bbox: { minLat: 30.3, maxLat: 35.1, minLon: -85.7, maxLon: -80.7 },
    attribution: 'Georgia Department of Transportation — 511GA (courtesy); licence not confirmed',
  },
  {
    id: 'idaho511',
    registryId: 'idaho511-cameras',
    credential: 'idaho511.apiKey',
    frameHost: '511.idaho.gov',
    region: 'Idaho',
    label: 'Idaho 511 camera',
    bbox: { minLat: 41.9, maxLat: 49.1, minLon: -117.3, maxLon: -110.9 },
    attribution: 'Idaho Transportation Department — Idaho 511 (courtesy); licence not confirmed',
  },
];

function statePack(site: StateSite): CatalogPack {
  const pack: CatalogPack = {
    id: site.id,
    registryId: site.registryId,
    request: ibi511Request(site.frameHost, site.credential),
    frameHosts: [site.frameHost],
    attribution: site.attribution,
    refreshSeconds: 120,
    normalize: (payload, opts) => normalizeIbi511(pack, site, payload, opts),
  };
  return pack;
}

export const US_511_PACKS: readonly CatalogPack[] = Object.freeze(STATES.map(statePack));
/** Catalogue URL per pack id (without the key, which the network layer appends). */
export const US_511_CAMERA_URLS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(STATES.map((s) => [s.id, ibi511CamerasUrl(s.frameHost)])),
);
/** The credential key per pack id (declared in the unverified manifest). */
export const US_511_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(STATES.map((s) => [s.id, s.credential])),
);
