import type { SourceHealthEntry, ConnectionSnapshot } from '@worldview/source-health';
import type { ProviderStatus } from '@worldview/provider-sdk';
import { DEMO_PROVIDERS } from './world.js';

/**
 * Demo source registry: a mix of states so every Source Health row type is exercised —
 * LIVE, STALE, AUTH_REQUIRED (FIRMS without a key), OFFLINE (AISStream unreachable),
 * DISABLED (OpenSky, default-off pending review) and RATE_LIMITED.
 */
export function buildDemoSources(nowMs: number): SourceHealthEntry[] {
  const iso = (offsetMs: number) => new Date(nowMs - offsetMs).toISOString();
  const entry = (
    p: { id: string; name: string; attribution: string },
    categories: string[],
    locality: SourceHealthEntry['locality'],
    status: ProviderStatus,
    extra: Partial<SourceHealthEntry['health']>,
    meta: Partial<SourceHealthEntry['meta']>,
    transitions: SourceHealthEntry['transitions'] = [],
  ): SourceHealthEntry => ({
    providerId: p.id,
    name: p.name,
    categories,
    locality,
    enabled: status !== 'DISABLED',
    health: {
      providerId: p.id,
      status,
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
      ...extra,
    },
    transitions,
    meta: {
      attribution: p.attribution,
      refreshIntervalMs: 60_000,
      cacheAllowed: true,
      credentialsRequired: [],
      commercialReview: 'approved',
      ...meta,
    },
  });
  return [
    entry(
      DEMO_PROVIDERS.usgs,
      ['earth'],
      'remote',
      'LIVE',
      {
        lastAttempt: iso(20_000),
        lastSuccess: iso(20_000),
        lastObservation: iso(10 * 60_000),
        latencyMs: 412,
        objectCount: 8,
        cacheAgeMs: 0,
      },
      {
        termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
        refreshIntervalMs: 60_000,
      },
      [{ from: 'STARTING', to: 'LIVE', at: iso(8 * 60_000) }],
    ),
    entry(
      DEMO_PROVIDERS.aircraft,
      ['aviation'],
      'local',
      'LIVE',
      { lastAttempt: iso(1000), lastSuccess: iso(1000), lastObservation: iso(2000), latencyMs: 8, objectCount: 12 },
      { refreshIntervalMs: 1000, cacheAllowed: false, commercialReview: 'approved' },
      [{ from: 'STARTING', to: 'LIVE', at: iso(9 * 60_000) }],
    ),
    entry(
      DEMO_PROVIDERS.celestrak,
      ['space'],
      'remote',
      'STALE',
      {
        lastAttempt: iso(3 * 3600_000),
        lastSuccess: iso(3 * 3600_000),
        lastObservation: iso(6 * 3600_000),
        latencyMs: 950,
        objectCount: 1,
        cacheAgeMs: 3 * 3600_000,
        message: 'Serving cached elements; next refresh in 57 min',
      },
      { termsUrl: 'https://celestrak.org/webmaster.php', refreshIntervalMs: 4 * 3600_000 },
      [
        { from: 'LIVE', to: 'STALE', at: iso(2 * 3600_000) },
        { from: 'STARTING', to: 'LIVE', at: iso(9 * 60_000) },
      ],
    ),
    entry(
      DEMO_PROVIDERS.firms,
      ['fire'],
      'remote',
      'AUTH_REQUIRED',
      { credentialState: 'missing', message: 'A NASA FIRMS MAP_KEY is required', objectCount: 1 },
      {
        termsUrl: 'https://firms.modaps.eosdis.nasa.gov/api/',
        refreshIntervalMs: 10 * 60_000,
        credentialsRequired: ['firms.mapKey'],
        commercialReview: 'conditional',
      },
      [{ from: 'STARTING', to: 'AUTH_REQUIRED', at: iso(9 * 60_000) }],
    ),
    entry(
      DEMO_PROVIDERS.ais,
      ['maritime'],
      'remote',
      'OFFLINE',
      {
        lastAttempt: iso(30_000),
        lastSuccess: iso(25 * 60_000),
        errorRate: 1,
        credentialState: 'present',
        objectCount: 2,
        cacheAgeMs: 25 * 60_000,
        lastError: { code: 'NETWORK', message: 'websocket closed: ECONNRESET', at: iso(30_000) },
        message: 'Reconnecting with backoff (next attempt in 60 s)',
      },
      {
        termsUrl: 'https://aisstream.io/documentation',
        refreshIntervalMs: 0,
        credentialsRequired: ['aisstream.apiKey'],
        commercialReview: 'conditional',
      },
      [
        { from: 'LIVE', to: 'OFFLINE', at: iso(25 * 60_000) },
        { from: 'STARTING', to: 'LIVE', at: iso(9 * 60_000) },
      ],
    ),
    entry(
      DEMO_PROVIDERS.nws,
      ['weather'],
      'remote',
      'RATE_LIMITED',
      {
        lastAttempt: iso(15_000),
        lastSuccess: iso(40 * 60_000),
        rateLimitState: { limited: true, resetAt: new Date(nowMs + 45_000).toISOString() },
        objectCount: 1,
        message: 'Upstream returned 429; honouring Retry-After',
      },
      { termsUrl: 'https://www.weather.gov/disclaimer', refreshIntervalMs: 2 * 60_000 },
      [{ from: 'LIVE', to: 'RATE_LIMITED', at: iso(15_000) }],
    ),
    entry(
      DEMO_PROVIDERS.cameras,
      ['cameras'],
      'remote',
      'LIVE',
      {
        lastAttempt: iso(90_000),
        lastSuccess: iso(90_000),
        lastObservation: iso(90_000),
        latencyMs: 120,
        objectCount: 1,
      },
      { refreshIntervalMs: 120_000, commercialReview: 'manual-review-required' },
      [{ from: 'STARTING', to: 'LIVE', at: iso(9 * 60_000) }],
    ),
    entry(
      { id: 'opensky-network', name: 'OpenSky Network', attribution: 'The OpenSky Network (non-commercial)' },
      ['aviation'],
      'remote',
      'DISABLED',
      { credentialState: 'missing' },
      {
        termsUrl: 'https://opensky-network.org/about/terms-of-use',
        refreshIntervalMs: 10_000,
        credentialsRequired: ['opensky.username', 'opensky.password'],
        commercialReview: 'excluded',
      },
    ),
  ];
}

export function connectionFrom(entries: SourceHealthEntry[], nowMs: number, networkOnline = true): ConnectionSnapshot {
  const liveLike = new Set<ProviderStatus>(['LIVE', 'DEGRADED', 'STALE', 'RATE_LIMITED']);
  let remoteLive = 0,
    remoteTotal = 0,
    localLive = 0;
  for (const e of entries) {
    if (!e.enabled) continue;
    if (e.locality === 'remote') {
      remoteTotal++;
      if (liveLike.has(e.health.status)) remoteLive++;
    } else if (liveLike.has(e.health.status)) localLive++;
  }
  const state = !networkOnline
    ? 'OFFLINE'
    : remoteTotal === 0
      ? 'CONNECTED'
      : remoteLive === 0
        ? 'OFFLINE'
        : remoteLive < remoteTotal
          ? 'DEGRADED'
          : 'CONNECTED';
  return { state, networkOnline, remoteLive, remoteTotal, localLive, at: new Date(nowMs).toISOString() };
}
