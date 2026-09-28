import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * public-cameras-unverified — traffic camera catalogues whose images have no licence we
 * could confirm: Caltrans (California), the City of Austin, New York City DOT, Iowa DOT,
 * the NZ Transport Agency, Washington State DOT, Lithuania's eismoinfo.lt, and the 511
 * sites of New York State, Utah, Arizona, Georgia and Idaho (those five with the
 * operator's own developer key; 511NY's access agreement is a revocable grant with a
 * condition, recorded as such).
 *
 * The code is the public-cameras provider's; only the manifest differs. It is off by
 * default and marked for manual review, so nothing here reaches a fresh install: the
 * operator switches it on in Sources, knowing the licence is not confirmed. Its data
 * policy is the intersection of the pack records (`caltrans-cctv`, `city-of-austin-cctv`,
 * `nyc-dot-webcams`, `iowa-dot-cameras`, `nzta-traffic-cameras`, `wsdot-cameras`,
 * `eismoinfo-lt-cameras`, `ny511-cameras`, `udot-traffic-cameras`, `az511-cameras`,
 * `ga511-cameras`, `idaho511-cameras`), the most restrictive of the camera records:
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
    'Traffic cameras agencies publish on their own sites under no licence we could confirm: Caltrans, Austin, New York City, Iowa, NZ Transport Agency, Washington State DOT, Lithuania (eismoinfo.lt), and with your own free developer keys 511NY, UDOT (Utah), AZ511, 511GA and Idaho 511. Off by default; switching it on is your decision. Frames are shown as served; nothing is detected, recognised or retained.',
  objectTypes: ['camera'],
  categories: ['cameras'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  // The five 511 sites need the operator's own developer key each (query parameter `key`);
  // a pack whose key is not stored waits instead of failing.
  credentials: [
    {
      key: 'ny511.apiKey',
      label: '511NY developer key — New York State cameras',
      required: false,
      kind: 'api-key',
      helpUrl: 'https://511ny.org/developers/doc',
    },
    {
      key: 'udot.apiKey',
      label: 'UDOT Traffic developer key — Utah cameras',
      required: false,
      kind: 'api-key',
      helpUrl: 'https://udottraffic.utah.gov/developers/doc',
    },
    {
      key: 'az511.apiKey',
      label: 'AZ511 developer key — Arizona cameras',
      required: false,
      kind: 'api-key',
      helpUrl: 'https://www.az511.gov/developers/doc',
    },
    {
      key: 'ga511.apiKey',
      label: '511GA developer key — Georgia cameras',
      required: false,
      kind: 'api-key',
      helpUrl: 'https://511ga.org/developers/doc',
    },
    {
      key: 'idaho511.apiKey',
      label: 'Idaho 511 developer key — Idaho cameras',
      required: false,
      kind: 'api-key',
      helpUrl: 'https://511.idaho.gov/developers/doc',
    },
  ],
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
      'Caltrans — cwwp2.dot.ca.gov (courtesy); City of Austin, TX — data.austintexas.gov (courtesy); NYC DOT — webcams.nyctmc.org (courtesy); Iowa DOT (courtesy); NZ Transport Agency Waka Kotahi (courtesy); Washington State DOT (courtesy); Lietuvos automobilių kelių direkcija — eismoinfo.lt (courtesy); Powered by 511NY; UDOT, ADOT (AZ511), GDOT (511GA), ITD (Idaho 511) (courtesy). Image licences not confirmed.',
  },
  attribution: {
    text: 'Caltrans — cwwp2.dot.ca.gov (courtesy); City of Austin, TX — data.austintexas.gov (courtesy); NYC DOT — webcams.nyctmc.org (courtesy); Iowa DOT (courtesy); NZ Transport Agency Waka Kotahi (courtesy); Washington State DOT (courtesy); Lietuvos automobilių kelių direkcija — eismoinfo.lt (courtesy); Powered by 511NY; UDOT, ADOT (AZ511), GDOT (511GA), ITD (Idaho 511) (courtesy). Image licences not confirmed.',
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
    'data.wsdot.wa.gov',
    'eismoinfo.lt',
    '511ny.org',
    'www.udottraffic.utah.gov',
    'az511.com',
    '511ga.org',
    '511.idaho.gov',
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
    {
      key: 'packs.wsdot',
      label: 'Washington State DOT',
      kind: 'boolean',
      defaultLabel: 'On',
      description:
        "Washington State highway cameras from WSDOT's travel map layer. No licence stated for the images; partner cameras on other hosts are left out.",
      helpUrl: 'https://wsdot.wa.gov/traffic/api/',
    },
    {
      key: 'packs.lithuania',
      label: 'eismoinfo.lt (Lithuania)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: "Lithuanian road cameras from the Road Administration's traffic site. No terms published.",
      helpUrl: 'https://eismoinfo.lt/',
    },
    {
      key: 'packs.ny511',
      label: '511NY (New York State)',
      kind: 'boolean',
      defaultLabel: 'On once a key is stored',
      description:
        "New York State cameras. Needs your own free 511NY developer key; its access agreement allows redistribution with 'powered by 511NY' and can be withdrawn.",
      helpUrl: 'https://511ny.org/developers/doc',
    },
    {
      key: 'packs.udot',
      label: 'UDOT Traffic (Utah)',
      kind: 'boolean',
      defaultLabel: 'On once a key is stored',
      description: 'Utah cameras. Needs your own free UDOT Traffic developer key. No licence stated.',
      helpUrl: 'https://udottraffic.utah.gov/developers/doc',
    },
    {
      key: 'packs.az511',
      label: 'AZ511 (Arizona)',
      kind: 'boolean',
      defaultLabel: 'On once a key is stored',
      description: 'Arizona cameras. Needs your own free AZ511 developer key. No licence stated.',
      helpUrl: 'https://www.az511.gov/developers/doc',
    },
    {
      key: 'packs.ga511',
      label: '511GA (Georgia)',
      kind: 'boolean',
      defaultLabel: 'On once a key is stored',
      description: 'Georgia cameras. Needs your own free 511GA developer key. No licence stated.',
      helpUrl: 'https://511ga.org/developers/doc',
    },
    {
      key: 'packs.idaho511',
      label: 'Idaho 511',
      kind: 'boolean',
      defaultLabel: 'On once a key is stored',
      description: 'Idaho cameras. Needs your own free Idaho 511 developer key. No licence stated.',
      helpUrl: 'https://511.idaho.gov/developers/doc',
    },
  ],
};
