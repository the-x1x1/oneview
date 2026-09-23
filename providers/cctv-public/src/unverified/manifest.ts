import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * public-cameras-unverified — traffic camera catalogues whose images have no licence we
 * could confirm: Caltrans (California), the City of Austin, New York City DOT, Iowa DOT and
 * the NZ Transport Agency.
 *
 * The code is the public-cameras provider's; only the manifest differs. It is off by
 * default and marked for manual review, so nothing here reaches a fresh install: the
 * operator switches it on in Sources, knowing the licence is not confirmed. Its data
 * policy is the intersection of the pack records (`caltrans-cctv`, `city-of-austin-cctv`,
 * `nyc-dot-webcams`, `iowa-dot-cameras`, `nzta-traffic-cameras`), the most restrictive of the
 * camera records:
 * catalogue rows kept for at most a day, no raw payloads, no offline packs, no export,
 * no redistribution. Frames follow the global CCTV frame rule like every camera's —
 * fetched live by the camera gateway, never retained.
 *
 * Promoting a pack to `public-cameras` needs its record approved first
 * (docs/legal/DATA-SOURCE-LICENSES.md).
 */
export const PUBLIC_CAMERAS_UNVERIFIED_MANIFEST: ProviderManifest = {
  id: 'public-cameras-unverified',
  name: 'Public cameras (licence not confirmed)',
  version: '0.1.0',
  description:
    'Traffic cameras that agencies publish on their own sites but under no licence we could confirm: Caltrans (California), the City of Austin, New York City DOT, Iowa DOT and the NZ Transport Agency (New Zealand). Off by default; switching it on is your decision. Frames are shown as served; nothing is detected, recognised or retained.',
  objectTypes: ['camera'],
  categories: ['cameras'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 15 * 60_000,
    minIntervalMs: 5 * 60_000,
    timeoutMs: 30_000,
    maxRetries: 2,
    // Caltrans is twelve district files on one host, fetched one after another.
    maxRequestsPerMinute: 20,
    staleWhileErrorMs: 12 * 3600_000,
    freshness: { camera: { liveSeconds: 1800, recentSeconds: 6 * 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    maxRetentionSeconds: 86400,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: 'unknown',
    attributionRequired: true,
    attributionText:
      'Caltrans — cwwp2.dot.ca.gov (courtesy); City of Austin, TX — data.austintexas.gov (courtesy); NYC DOT — webcams.nyctmc.org (courtesy); Iowa DOT (courtesy); NZ Transport Agency Waka Kotahi (courtesy). Image licences not confirmed.',
  },
  attribution: {
    text: 'Caltrans — cwwp2.dot.ca.gov (courtesy); City of Austin, TX — data.austintexas.gov (courtesy); NYC DOT — webcams.nyctmc.org (courtesy); Iowa DOT (courtesy); NZ Transport Agency Waka Kotahi (courtesy). Image licences not confirmed.',
  },
  commercialReview: 'manual-review-required',
  enabledByDefault: false,
  // Catalogue hosts only; the camera gateway keeps the frame hosts.
  allowedHosts: [
    'cwwp2.dot.ca.gov',
    'data.austintexas.gov',
    'webcams.nyctmc.org',
    'services.arcgis.com',
    'www.journeys.nzta.govt.nz',
  ],
  settings: [
    {
      key: 'packs.caltrans',
      label: 'Caltrans (California)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'California state highway cameras, twelve district catalogues. Licence not confirmed.',
      helpUrl: 'https://cwwp2.dot.ca.gov/',
    },
    {
      key: 'packs.austin',
      label: 'City of Austin (Texas)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'Austin traffic cameras. The catalogue is open data; the images are not licensed.',
      helpUrl: 'https://data.austintexas.gov/Transportation-and-Mobility/Traffic-Cameras/b4k4-adkb',
    },
    {
      key: 'packs.nyc',
      label: 'New York City DOT',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'New York City traffic cameras. No published terms.',
      helpUrl: 'https://webcams.nyctmc.org/',
    },
    {
      key: 'packs.iowa',
      label: 'Iowa DOT',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'Iowa highway cameras. The catalogue is CC BY 4.0; the images are not named in the licence.',
      helpUrl: 'https://data.iowadot.gov/',
    },
    {
      key: 'packs.nzta',
      label: 'NZ Transport Agency (New Zealand)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'New Zealand state highway cameras from the Journey Planner. No reuse licence found for the images.',
      helpUrl: 'https://www.journeys.nzta.govt.nz/traffic-cameras',
    },
  ],
};
