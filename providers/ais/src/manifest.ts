import type { ProviderManifest } from '@worldview/provider-sdk';

/** Credential key under which the runtime stores the user's AISStream API key (never the value). */
export const AISSTREAM_CREDENTIAL_KEY = 'aisstream.apiKey';

export const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';

/** Message types requested in the subscription frame. */
export const AISSTREAM_MESSAGE_TYPES = ['PositionReport', 'ShipStaticData'] as const;

/**
 * AISStream.io — live AIS over websocket. No formal licence/ToS is published, so the data
 * policy below is WORLDVIEW's conservative default (no raw retention, 24 h normalized cap,
 * no export/redistribution) and the provider is off until a human reviews the terms.
 * The user supplies their own API key; direct browser connections are not permitted by
 * AISStream, so the socket is always opened by the main process through ProviderSockets.
 */
export const AISSTREAM_MANIFEST: ProviderManifest = {
  id: 'aisstream-io',
  name: 'AISStream.io',
  version: '0.1.0',
  description: 'Live AIS position reports and ship static data from AISStream.io over websocket, filtered to the viewport (user-supplied API key).',
  objectTypes: ['vessel'],
  categories: ['maritime'],
  transport: 'websocket',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: true },
  credentials: [{ key: AISSTREAM_CREDENTIAL_KEY, label: 'AISStream API key', required: true, kind: 'api-key', helpUrl: 'https://aisstream.io/authenticate' }],
  refreshPolicy: {
    intervalMs: 0,
    minIntervalMs: 0,
    timeoutMs: 15_000,
    maxRetries: 3,
    maxRequestsPerMinute: 4,
    staleWhileErrorMs: 0,
    freshness: { vessel: { liveSeconds: 180, recentSeconds: 900, expireSeconds: 3 * 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    maxRetentionSeconds: 86_400,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: 'unknown',
    attributionRequired: true,
    attributionText: 'Vessels: AISStream.io (courtesy)',
    termsUrl: 'https://aisstream.io/documentation',
  },
  attribution: { text: 'Vessels: AISStream.io (courtesy)', url: 'https://aisstream.io/' },
  commercialReview: 'manual-review-required',
  enabledByDefault: false,
  allowedHosts: ['stream.aisstream.io'],
};
