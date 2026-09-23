import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * public-cameras-singapore — Singapore's traffic images (LTA via data.gov.sg), in a provider
 * of their own because the catalogue *is* the frame list: each camera's image URL changes
 * with every capture, about once a minute. Polled every minute (the camera provider's
 * fifteen would show frames up to fifteen minutes old), one small request each time.
 *
 * The licence (Singapore Open Data Licence v1.0) permits keeping and redistributing the
 * data; WORLDVIEW does not keep these rows: from one minute to the next only the image URLs
 * change, and history would gain ~130,000 rows a day of nothing else. Frames follow the
 * global CCTV frame rule — fetched live, never retained. Policy equals the registry records
 * `datagovsg-traffic-images` and `public-cameras-singapore`.
 */
export const PUBLIC_CAMERAS_SINGAPORE_MANIFEST: ProviderManifest = {
  id: 'public-cameras-singapore',
  name: 'Public cameras — Singapore',
  version: '0.1.0',
  description:
    'Singapore traffic cameras from the Land Transport Authority via data.gov.sg (Singapore Open Data Licence). Refreshed every minute, because each camera’s picture has a new address every minute. Frames are shown as served; nothing is detected, recognised or retained.',
  objectTypes: ['camera'],
  categories: ['cameras'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 60_000,
    minIntervalMs: 30_000,
    timeoutMs: 15_000,
    maxRetries: 2,
    maxRequestsPerMinute: 4,
    staleWhileErrorMs: 10 * 60_000,
    freshness: { camera: { liveSeconds: 300, recentSeconds: 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: false,
    redistributionAllowed: true,
    offlinePackAllowed: false,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: true,
    attributionText:
      'Contains information from Traffic Images from data.gov.sg (Land Transport Authority), made available under the terms of the Singapore Open Data Licence version 1.0',
    termsUrl: 'https://data.gov.sg/open-data-licence',
  },
  attribution: {
    text: 'Contains information from Traffic Images from data.gov.sg (Land Transport Authority), made available under the terms of the Singapore Open Data Licence version 1.0',
    url: 'https://data.gov.sg/open-data-licence',
  },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: ['api.data.gov.sg'],
};
