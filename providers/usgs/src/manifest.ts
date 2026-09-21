import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * USGS Earthquake Hazards Program — GeoJSON summary feeds.
 * Data: U.S. Government work, public domain. Attribution courtesy.
 * Feed etiquette: poll summary feeds at most once per minute (feeds update every minute).
 */
export const USGS_MANIFEST: ProviderManifest = {
  id: 'usgs-earthquakes',
  name: 'USGS Earthquakes',
  version: '0.1.0',
  description: 'Global earthquakes from the USGS Earthquake Hazards Program real-time GeoJSON feeds (all magnitudes, past day), with FDSN event-query backfill for history.',
  objectTypes: ['earthquake'],
  categories: ['earth', 'disasters'],
  transport: 'http',
  capabilities: { live: true, historical: true, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 60_000,
    minIntervalMs: 60_000,
    timeoutMs: 15_000,
    maxRetries: 2,
    maxRequestsPerMinute: 4,
    staleWhileErrorMs: 6 * 3600_000,
    freshness: { earthquake: { liveSeconds: 3600, recentSeconds: 24 * 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: false,
    attributionText: 'Data courtesy of the U.S. Geological Survey',
    termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
  },
  attribution: { text: 'Data courtesy of the U.S. Geological Survey', url: 'https://earthquake.usgs.gov/', licenseId: 'US-PD' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: ['earthquake.usgs.gov'],
  settings: [
    {
      key: 'feed', label: 'Feed window', kind: 'enum', defaultLabel: 'Past day',
      description: 'Which USGS summary feed to poll. A longer window returns more events per request.',
      options: [
        { value: 'hour', label: 'Past hour' },
        { value: 'day', label: 'Past day' },
        { value: 'week', label: 'Past 7 days' },
        { value: 'month', label: 'Past 30 days' },
      ],
      helpUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
    },
    {
      key: 'minMagnitude', label: 'Minimum magnitude', kind: 'number', min: -5, max: 10, step: 0.1,
      defaultLabel: 'Everything in the feed',
      description: 'Events below this magnitude are skipped by policy — they are counted, not treated as errors.',
    },
  ],
};

export type UsgsFeedWindow = 'hour' | 'day' | 'week' | 'month';

export const USGS_FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
export const USGS_FDSN_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

export function feedUrl(window: UsgsFeedWindow): string {
  return `${USGS_FEED_BASE}/all_${window}.geojson`;
}
