import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * WORLDVIEW seed airports — a bundled GeoJSON of major world airports authored in this
 * repository (MIT; curated public facts, coordinates to 0.01°). Read through the granted
 * resources directory, so it works offline and never touches the network.
 */
export const SEED_AIRPORTS_MANIFEST: ProviderManifest = {
  id: 'worldview-seed-airports',
  name: 'WORLDVIEW seed airports',
  version: '0.1.0',
  description:
    'Reference points for major world airports from the bundled seed dataset (ICAO/IATA codes, names, municipality, country).',
  objectTypes: ['airport'],
  categories: ['infrastructure', 'aviation'],
  transport: 'filesystem',
  capabilities: { live: false, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 24 * 3600_000,
    minIntervalMs: 3600_000,
    timeoutMs: 5000,
    maxRetries: 0,
    maxRequestsPerMinute: 1,
    staleWhileErrorMs: 0,
    freshness: { airport: { liveSeconds: 365 * 24 * 3600, recentSeconds: 3 * 365 * 24 * 3600 } },
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
    attributionText: 'Airports: WORLDVIEW seed dataset',
    termsUrl: 'https://opensource.org/license/mit',
  },
  attribution: { text: 'Airports: WORLDVIEW seed dataset', licenseId: 'MIT' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: [],
};

/** Granted-file path of the bundled dataset (the runtime grants the resources directory). */
export const SEED_AIRPORTS_FILE = 'airports.geojson';

/** Dataset date used when the file carries no `datasetDate`. */
export const SEED_AIRPORTS_DATASET_DATE = '2026-09-01T00:00:00.000Z';
