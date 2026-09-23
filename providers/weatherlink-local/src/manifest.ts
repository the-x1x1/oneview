import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * A Davis WeatherLink Live on the user's own network, read through its documented local API
 * (`GET http://<address>/v1/current_conditions`,
 * https://weatherlink.github.io/weatherlink-live-local-api/). The readings are the user's
 * own station's: no third-party terms, never uploaded — WORLDVIEW does not use Davis's cloud
 * API and needs no account or key.
 *
 * Off by default, and inert until the user names two things the device cannot tell us: its
 * address (the one LAN host this provider may reach — nothing is discovered, although the
 * device announces itself over mDNS) and where the station stands (the device knows no
 * position).
 */
export const WEATHERLINK_LOCAL_MANIFEST: ProviderManifest = {
  id: 'weatherlink-local',
  name: 'Local weather station (WeatherLink Live)',
  version: '0.1.0',
  description:
    "Current conditions from the user's own Davis WeatherLink Live, read from its local API on the address they name. Nothing leaves the network.",
  objectTypes: ['weather-station'],
  categories: ['weather'],
  transport: 'hardware',
  capabilities: { live: true, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    // Davis: "continuous requests as often as every 10 seconds"; weather moves slower.
    intervalMs: 60_000,
    minIntervalMs: 10_000,
    timeoutMs: 5_000,
    maxRetries: 0,
    maxRequestsPerMinute: 6,
    staleWhileErrorMs: 0,
    freshness: { 'weather-station': { liveSeconds: 300, recentSeconds: 1800, expireSeconds: 6 * 3600 } },
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
    attributionText: 'Local weather station (WeatherLink Live)',
  },
  attribution: {
    text: 'Local weather station (WeatherLink Live)',
    url: 'https://weatherlink.github.io/weatherlink-live-local-api/',
  },
  commercialReview: 'approved',
  enabledByDefault: false,
  // Nothing by default: the one host the user names is added by the runtime (ADR-003).
  allowedHosts: [],
  trustedHostSetting: 'host',
  settings: [
    {
      key: 'host',
      label: 'WeatherLink Live address',
      kind: 'string',
      placeholder: '192.168.1.50',
      defaultLabel: 'Not set',
      description:
        "The device's IP address or host name on your network (shown in the WeatherLink app under the device's settings). Only this address is contacted, over plain HTTP.",
      helpUrl: 'https://weatherlink.github.io/weatherlink-live-local-api/',
    },
    {
      key: 'latitude',
      label: 'Station latitude',
      kind: 'number',
      min: -90,
      max: 90,
      step: 0.0001,
      defaultLabel: 'Not set',
      description: 'Where the sensor suite stands, in decimal degrees (north positive). The device does not know.',
    },
    {
      key: 'longitude',
      label: 'Station longitude',
      kind: 'number',
      min: -180,
      max: 180,
      step: 0.0001,
      defaultLabel: 'Not set',
      description: 'Decimal degrees, east positive (west is negative).',
    },
    {
      key: 'name',
      label: 'Station name',
      kind: 'string',
      placeholder: 'Backyard',
      defaultLabel: 'Weather station',
      description: 'How the station is labelled on the map.',
    },
  ],
};

/** How long to wait before probing the device again after it did not answer. */
export const PROBE_BACKOFF_MS = 60_000;
