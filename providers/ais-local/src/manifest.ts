import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * Ships heard by the user's own AIS receiver — AIS-catcher, rtl_ais, a dAISy or a marine AIS
 * transponder behind an NMEA multiplexer — read as NMEA 0183 AIVDM/AIVDO sentences over a
 * TCP connection WORLDVIEW opens to it (the receiver is the server; WORLDVIEW never
 * listens). 10110 is the port IANA registers for NMEA 0183 over IP ("nmea-0183").
 *
 * The receptions are the user's own: no third-party terms, never uploaded. Off by default;
 * with no host named it connects to loopback only.
 */
export const AIS_LOCAL_MANIFEST: ProviderManifest = {
  id: 'ais-local',
  name: 'Local AIS receiver (NMEA over TCP)',
  version: '0.1.0',
  description:
    "Ships decoded by the user's own AIS receiver, read as NMEA 0183 over a TCP connection to it (loopback, or the one host named). Nothing leaves the network.",
  objectTypes: ['vessel'],
  categories: ['maritime'],
  transport: 'hardware',
  capabilities: { live: true, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 0,
    minIntervalMs: 0,
    timeoutMs: 5_000,
    maxRetries: 0,
    maxRequestsPerMinute: 60,
    staleWhileErrorMs: 0,
    // Class A under way reports every 2–10 s, at anchor every 3 min; Class B every 30 s–3 min.
    freshness: { vessel: { liveSeconds: 360, recentSeconds: 1800, expireSeconds: 3 * 3600 } },
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
    attributionText: 'Local AIS receiver',
  },
  attribution: { text: 'Local AIS receiver', url: 'https://gpsd.gitlab.io/gpsd/AIVDM.html' },
  commercialReview: 'approved',
  enabledByDefault: false,
  allowedHosts: ['127.0.0.1', 'localhost'],
  trustedHostSetting: 'host',
  settings: [
    {
      key: 'host',
      label: 'Receiver on another machine',
      kind: 'string',
      placeholder: 'raspberrypi.local',
      defaultLabel: 'This computer (127.0.0.1)',
      description:
        'Where your AIS receiver serves NMEA over TCP, if not on this computer. Only this host is contacted; it is not discovered.',
    },
    {
      key: 'port',
      label: 'NMEA TCP port',
      kind: 'number',
      min: 1,
      max: 65535,
      step: 1,
      defaultLabel: '10110',
      description:
        'The port your receiver serves NMEA on (AIS-catcher: the port given to -S; many multiplexers use 10110).',
      helpUrl: 'https://gpsd.gitlab.io/gpsd/AIVDM.html',
    },
  ],
};

export const DEFAULT_NMEA_PORT = 10110;
/** Reconnect back-off after the receiver goes away: 5 s, doubling, at most a minute. */
export const RECONNECT_MIN_MS = 5_000;
export const RECONNECT_MAX_MS = 60_000;
