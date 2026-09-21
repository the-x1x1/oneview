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
 * `fintraffic-weathercams` and `live-traffic-nsw` (both CC BY 4.0, both approved).
 */
export const PUBLIC_CAMERAS_MANIFEST: ProviderManifest = {
  id: 'public-cameras',
  name: 'Public cameras',
  version: '0.1.0',
  description: 'Publicly documented traffic and road-weather cameras from openly licensed catalogs: Fintraffic (Finland) and Live Traffic NSW (Australia). Frames are shown as served; nothing is detected, recognised or retained.',
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
    attributionText: 'Fintraffic / digitraffic.fi, license CC BY 4.0; Live Traffic NSW — Transport for NSW (CC BY 4.0)',
    termsUrl: 'https://www.digitraffic.fi/en/terms-of-service/',
  },
  attribution: { text: 'Fintraffic / digitraffic.fi, license CC BY 4.0; Live Traffic NSW — Transport for NSW (CC BY 4.0)', licenseId: 'CC-BY-4.0' },
  commercialReview: 'approved',
  enabledByDefault: true,
  // Catalog hosts only. Frame hosts are contacted by the camera gateway, which keeps its own allowlist.
  allowedHosts: ['tie.digitraffic.fi', 'data.livetraffic.com'],
  settings: [
    {
      key: 'packs.fintraffic', label: 'Fintraffic (Finland)', kind: 'boolean', defaultLabel: 'On',
      description: 'Finnish road-weather cameras, CC BY 4.0. Frames are fetched from digitraffic.fi when a camera is opened.',
      helpUrl: 'https://www.digitraffic.fi/en/road-traffic/',
    },
    {
      key: 'packs.nsw', label: 'Live Traffic NSW (Australia)', kind: 'boolean', defaultLabel: 'On',
      description: 'Transport for NSW traffic cameras, CC BY 4.0.',
      helpUrl: 'https://www.livetraffic.com/',
    },
  ],
};
