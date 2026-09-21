import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * CelesTrak — GP element sets (TLE / OMM JSON) for the public satellite catalog.
 *
 * Etiquette (celestrak.org): fetch a group at most once every 2 hours and identify
 * the client. The provider therefore caches each group's catalog for 2 h
 * (ProviderCache, keyed by group) and only re-propagates positions on every poll.
 *
 * Observation semantics: `observedAt` is the element-set epoch (the source's
 * measurement); the position is WORLDVIEW-derived state propagated to
 * `payload.propagatedAt`. Freshness therefore describes element-set age, which is
 * what actually bounds position accuracy — the manifest overrides the world-model
 * default (which assumes observedAt = propagation time).
 *
 * Legal: no licence text exists; citation requested; commercial review "conditional"
 * (config/licenses/providers.json). TLE copies are not redistributable.
 */
export const CELESTRAK_MANIFEST: ProviderManifest = {
  id: 'celestrak',
  name: 'CelesTrak satellites',
  version: '0.1.0',
  description: 'Satellite positions propagated (SGP4) from CelesTrak GP element sets. Catalog groups refreshed at most every 2 hours; positions re-propagated every 15 s from the cached catalog.',
  objectTypes: ['satellite'],
  categories: ['space'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 15_000,
    minIntervalMs: 15_000,
    timeoutMs: 30_000,
    maxRetries: 2,
    maxRequestsPerMinute: 8,
    staleWhileErrorMs: 24 * 3600_000,
    freshness: { satellite: { liveSeconds: 24 * 3600, recentSeconds: 3 * 24 * 3600, expireSeconds: 7 * 24 * 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: true,
    commercialUseAllowed: 'conditional',
    attributionRequired: true,
    attributionText: 'Satellite element sets: CelesTrak (celestrak.org), Dr. T.S. Kelso',
    termsUrl: 'https://celestrak.org/',
  },
  attribution: { text: 'Satellite element sets: CelesTrak (celestrak.org), Dr. T.S. Kelso', url: 'https://celestrak.org/' },
  commercialReview: 'conditional',
  enabledByDefault: true,
  allowedHosts: ['celestrak.org'],
  settings: [
    {
      key: 'groups', label: 'Catalogue groups', kind: 'multi-enum', defaultLabel: 'Stations and visual satellites',
      description: 'Which CelesTrak element groups to fetch. More groups means more objects and a longer poll.',
      options: [
        { value: 'active', label: 'All active satellites' },
        { value: 'stations', label: 'Space stations' },
        { value: 'visual', label: 'Brightest / visual' },
        { value: 'starlink', label: 'Starlink' },
        { value: 'gps-ops', label: 'GPS operational' },
        { value: 'weather', label: 'Weather satellites' },
        { value: 'science', label: 'Science satellites' },
        { value: 'geo', label: 'Geostationary' },
      ],
      helpUrl: 'https://celestrak.org/NORAD/elements/',
    },
    { key: 'maxObjects', label: 'Maximum objects', kind: 'number', min: 1, max: 20000, step: 100, description: 'Upper bound on propagated satellites, whatever the groups return.' },
    {
      key: 'format', label: 'Element format', kind: 'enum', defaultLabel: 'JSON',
      options: [{ value: 'json', label: 'JSON (OMM)' }, { value: 'tle', label: 'TLE text' }],
    },
  ],
};

/** Catalog groups this provider accepts (subset of CelesTrak's GROUP values). */
export const CELESTRAK_GROUPS = ['active', 'stations', 'visual', 'starlink', 'gps-ops', 'weather', 'science', 'geo'] as const;
export type CelestrakGroup = (typeof CELESTRAK_GROUPS)[number];
export type CelestrakFormat = 'json' | 'tle';

export const CELESTRAK_GP_BASE = 'https://celestrak.org/NORAD/elements/gp.php';

/** Minimum interval between catalog fetches for one group (CelesTrak etiquette). */
export const CATALOG_MAX_AGE_MS = 2 * 3600_000;
/** An element set is considered valid for propagation for this long after its epoch. */
export const ELEMENT_VALIDITY_MS = 7 * 24 * 3600_000;

export function isCelestrakGroup(value: unknown): value is CelestrakGroup {
  return typeof value === 'string' && (CELESTRAK_GROUPS as readonly string[]).includes(value);
}

export function gpUrl(group: CelestrakGroup, format: CelestrakFormat): string {
  return `${CELESTRAK_GP_BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=${format}`;
}
