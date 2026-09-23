import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * public-cameras — openly licensed public camera catalogs, one pack per source.
 *
 * The provider fetches *catalogs* (camera positions, names, frame URLs). Frames are
 * never fetched here: the camera gateway resolves `public:<pack>:<cameraId>` media
 * refs against an allowlist built from these observations and fetches frames live,
 * without retention (global CCTV frame rule, docs/legal/DATA-SOURCE-LICENSES.md §1).
 *
 * Data policy equals the aggregate registry record `public-cameras`
 * (config/licenses/providers.json), which is the intersection of the pack records
 * `fintraffic-weathercams`, `live-traffic-nsw` (CC BY 4.0), `tfl-jamcams` (TfL Open Data),
 * `ontario-511`, `drivebc` and `open-calgary` (Open Government Licences) — every one
 * approved, every one permitting commercial use with attribution.
 */
export const PUBLIC_CAMERAS_MANIFEST: ProviderManifest = {
  id: 'public-cameras',
  name: 'Public cameras',
  version: '0.1.0',
  description:
    'Publicly documented traffic and road-weather cameras from openly licensed catalogs: Fintraffic (Finland), Live Traffic NSW (Australia), TfL JamCams (London), Ontario 511, DriveBC (British Columbia) and the City of Calgary. Frames are shown as served; nothing is detected, recognised or retained.',
  objectTypes: ['camera'],
  categories: ['cameras'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 15 * 60_000,
    minIntervalMs: 5 * 60_000,
    timeoutMs: 20_000,
    maxRetries: 2,
    maxRequestsPerMinute: 4,
    staleWhileErrorMs: 24 * 3600_000,
    // A catalog entry is "live" while the catalog was refreshed recently (refresh every 15 min).
    freshness: { camera: { liveSeconds: 1800, recentSeconds: 6 * 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: true,
    attributionText:
      'Fintraffic / digitraffic.fi, license CC BY 4.0; Live Traffic NSW — Transport for NSW (CC BY 4.0); Powered by TfL Open Data, contains OS data © Crown copyright and database rights; Contains information licensed under the Open Government Licence – Ontario (Ontario 511); DriveBC, Open Government Licence – British Columbia; Contains information licensed under the Open Government Licence – City of Calgary',
    termsUrl: 'https://www.digitraffic.fi/en/terms-of-service/',
  },
  attribution: {
    text: 'Fintraffic / digitraffic.fi, license CC BY 4.0; Live Traffic NSW — Transport for NSW (CC BY 4.0); Powered by TfL Open Data, contains OS data © Crown copyright and database rights; Contains information licensed under the Open Government Licence – Ontario (Ontario 511); DriveBC, Open Government Licence – British Columbia; Contains information licensed under the Open Government Licence – City of Calgary',
    // No single licence id: the packs are under five different licences. Each camera
    // carries its own pack's attribution, shown with its frame.
  },
  commercialReview: 'approved',
  enabledByDefault: true,
  // Catalog hosts only. Frame hosts are contacted by the camera gateway, which keeps its own allowlist.
  allowedHosts: [
    'tie.digitraffic.fi',
    'data.livetraffic.com',
    'api.tfl.gov.uk',
    '511on.ca',
    'www.drivebc.ca',
    'data.calgary.ca',
  ],
  settings: [
    {
      key: 'packs.fintraffic',
      label: 'Fintraffic (Finland)',
      kind: 'boolean',
      defaultLabel: 'On',
      description:
        'Finnish road-weather cameras, CC BY 4.0. Frames are fetched from digitraffic.fi when a camera is opened.',
      helpUrl: 'https://www.digitraffic.fi/en/road-traffic/',
    },
    {
      key: 'packs.nsw',
      label: 'Live Traffic NSW (Australia)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'Transport for NSW traffic cameras, CC BY 4.0.',
      helpUrl: 'https://www.livetraffic.com/',
    },
    {
      key: 'packs.tfl',
      label: 'TfL JamCams (London)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'Transport for London traffic cameras. Powered by TfL Open Data.',
      helpUrl: 'https://tfl.gov.uk/info-for/open-data-users/',
    },
    {
      key: 'packs.ontario',
      label: 'Ontario 511 (Canada)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'Ontario highway cameras, Open Government Licence – Ontario.',
      helpUrl: 'https://511on.ca/',
    },
    {
      key: 'packs.drivebc',
      label: 'DriveBC (British Columbia)',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'British Columbia highway cameras, Open Government Licence – British Columbia.',
      helpUrl: 'https://www.drivebc.ca/',
    },
    {
      key: 'packs.calgary',
      label: 'City of Calgary',
      kind: 'boolean',
      defaultLabel: 'On',
      description: 'Calgary traffic cameras, Open Government Licence – City of Calgary.',
      helpUrl: 'https://data.calgary.ca/',
    },
  ],
};
