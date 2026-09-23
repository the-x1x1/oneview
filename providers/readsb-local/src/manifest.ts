import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * readsb / dump1090 running on the user's own machine (or an explicitly trusted host).
 * The data is the user's own receiver output: no third-party terms, never uploaded.
 * readsb itself is GPL-3.0 and is not distributed by WORLDVIEW; this provider only reads
 * its `aircraft.json` over HTTP. Detection is conservative: exactly one configured endpoint
 * is probed, never other ports or hosts.
 */
export const READSB_LOCAL_MANIFEST: ProviderManifest = {
  id: 'readsb-local',
  name: 'Local ADS-B receiver (readsb)',
  version: '0.1.0',
  description:
    "Aircraft decoded by the user's own readsb/dump1090 receiver, read from its aircraft.json over loopback (or an explicitly trusted host). Nothing leaves the machine.",
  objectTypes: ['aircraft'],
  categories: ['aviation'],
  transport: 'local-process',
  capabilities: { live: true, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 1000,
    minIntervalMs: 500,
    timeoutMs: 2000,
    maxRetries: 0,
    maxRequestsPerMinute: 120,
    staleWhileErrorMs: 0,
    freshness: { aircraft: { liveSeconds: 30, recentSeconds: 90, expireSeconds: 600 } },
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
    attributionText: 'Local receiver (readsb)',
  },
  attribution: { text: 'Local ADS-B receiver (readsb)', url: 'https://github.com/wiedehopf/readsb' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: ['127.0.0.1', 'localhost'],
  // The one LAN host the user names is added to this provider's allowlist by the runtime.
  trustedHostSetting: 'trustedHost',
  settings: [
    {
      key: 'endpoint',
      label: 'Receiver endpoint',
      kind: 'string',
      placeholder: 'http://127.0.0.1:8080/data/aircraft.json',
      defaultLabel: 'http://127.0.0.1:8080/data/aircraft.json',
      description:
        'The one URL WORLDVIEW probes for your readsb or dump1090 JSON. Nothing else on your network is contacted.',
      helpUrl: 'https://github.com/wiedehopf/readsb',
    },
    {
      key: 'trustedHost',
      label: 'Receiver on another machine',
      kind: 'string',
      placeholder: 'raspberrypi.local',
      defaultLabel: 'Loopback only',
      description:
        'Plain HTTP is allowed to loopback and to one host you name here. Name it deliberately; it is not discovered.',
    },
  ],
};

export const DEFAULT_READSB_ENDPOINT = 'http://127.0.0.1:8080/data/aircraft.json';

/** How long to wait before probing the endpoint again after it was not detected. */
export const PROBE_BACKOFF_MS = 30_000;
