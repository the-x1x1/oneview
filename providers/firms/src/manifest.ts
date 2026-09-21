import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * NASA FIRMS — Fire Information for Resource Management System, area CSV API.
 *
 * Requires a free per-user MAP_KEY (never shipped with the app). Quota: 5000
 * transactions per 10-minute interval per key; sources are fetched sequentially
 * and the default cadence (10 min, 3 sources) uses a fraction of that.
 *
 * Legal: US Government / NASA Earthdata open data; the acknowledgement text in
 * dataPolicy.attributionText must be shown wherever detections are visible and
 * stamped on exports (config/licenses/providers.json).
 */
export const FIRMS_MANIFEST: ProviderManifest = {
  id: 'nasa-firms',
  name: 'NASA FIRMS active fires',
  version: '0.1.0',
  description: 'Near-real-time active fire detections from VIIRS (Suomi NPP, NOAA-20, NOAA-21) and MODIS via the NASA FIRMS area CSV API. Requires a personal MAP_KEY.',
  objectTypes: ['fire-detection'],
  categories: ['fire'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: true },
  credentials: [
    { key: 'firms.mapKey', label: 'NASA FIRMS MAP_KEY', required: true, helpUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/', kind: 'api-key' },
  ],
  refreshPolicy: {
    intervalMs: 10 * 60_000,
    minIntervalMs: 5 * 60_000,
    timeoutMs: 45_000,
    maxRetries: 2,
    maxRequestsPerMinute: 6,
    staleWhileErrorMs: 6 * 3600_000,
    freshness: { 'fire-detection': { liveSeconds: 3 * 3600, recentSeconds: 24 * 3600, expireSeconds: 7 * 24 * 3600 } },
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
    attributionText: "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Observing System Data and Information System (EOSDIS).",
    termsUrl: 'https://firms.modaps.eosdis.nasa.gov/api/area/',
  },
  attribution: { text: 'NASA FIRMS', url: 'https://earthdata.nasa.gov/firms', onScreen: true },
  commercialReview: 'approved',
  /** Registry plannedStatus "auth-required": enabled, but idle (AUTH_REQUIRED) until the user enters a MAP_KEY. */
  enabledByDefault: true,
  allowedHosts: ['firms.modaps.eosdis.nasa.gov'],
  settings: [
    {
      key: 'sources', label: 'Satellite sources', kind: 'multi-enum',
      defaultLabel: 'The three VIIRS instruments',
      description: 'Which FIRMS instruments to request. Each is a separate request against your key quota.',
      options: [
        { value: 'VIIRS_SNPP_NRT', label: 'VIIRS (Suomi NPP)' },
        { value: 'VIIRS_NOAA20_NRT', label: 'VIIRS (NOAA-20)' },
        { value: 'VIIRS_NOAA21_NRT', label: 'VIIRS (NOAA-21)' },
        { value: 'MODIS_NRT', label: 'MODIS' },
      ],
      helpUrl: 'https://firms.modaps.eosdis.nasa.gov/api/area/',
    },
    { key: 'dayRange', label: 'Days of detections', kind: 'number', min: 1, max: 10, step: 1, defaultLabel: '1 day', description: 'How far back each request reaches. FIRMS allows up to 10 days.' },
  ],
};

export const FIRMS_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'] as const;
export type FirmsSource = (typeof FIRMS_SOURCES)[number];
export const DEFAULT_FIRMS_SOURCES: FirmsSource[] = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

export function isFirmsSource(value: unknown): value is FirmsSource {
  return typeof value === 'string' && (FIRMS_SOURCES as readonly string[]).includes(value);
}
