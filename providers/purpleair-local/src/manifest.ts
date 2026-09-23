import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * A PurpleAir air-quality sensor on the user's own network, read from the JSON the sensor
 * itself serves (`GET http://<address>/json` — two-minute averages; field reference:
 * https://community.purpleair.com/t/sensor-json-documentation/6917). The readings are the
 * user's own device's: WORLDVIEW does not use PurpleAir's cloud API, its map or its data
 * licence, needs no key, and uploads nothing.
 *
 * Off by default and inert until the user names the sensor's address — the one LAN host this
 * provider may reach (nothing is discovered). The sensor reports roughly where it is
 * registered; a position the user sets takes precedence.
 */
export const PURPLEAIR_LOCAL_MANIFEST: ProviderManifest = {
  id: 'purpleair-local',
  name: 'Local air-quality sensor (PurpleAir)',
  version: '0.1.0',
  description:
    "PM2.5, PM10 and the US EPA AQI from the user's own PurpleAir sensor, read from its local JSON on the address they name. Nothing leaves the network.",
  objectTypes: ['sensor'],
  categories: ['environment'],
  transport: 'hardware',
  capabilities: { live: true, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    // The sensor averages over two minutes; PurpleAir asks for at least 10 s between requests.
    intervalMs: 120_000,
    minIntervalMs: 10_000,
    timeoutMs: 5_000,
    maxRetries: 0,
    maxRequestsPerMinute: 6,
    staleWhileErrorMs: 0,
    freshness: { sensor: { liveSeconds: 600, recentSeconds: 1800, expireSeconds: 6 * 3600 } },
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
    attributionText: 'Local air-quality sensor (PurpleAir)',
  },
  attribution: {
    text: 'Local air-quality sensor (PurpleAir)',
    url: 'https://community.purpleair.com/t/sensor-json-documentation/6917',
  },
  commercialReview: 'approved',
  enabledByDefault: false,
  allowedHosts: [],
  trustedHostSetting: 'host',
  settings: [
    {
      key: 'host',
      label: 'Sensor address',
      kind: 'string',
      placeholder: '192.168.1.60',
      defaultLabel: 'Not set',
      description:
        "The sensor's IP address or host name on your network. Only this address is contacted, over plain HTTP.",
      helpUrl: 'https://community.purpleair.com/t/view-sensor-data-locally-over-wifi-json-data/5513',
    },
    {
      key: 'latitude',
      label: 'Sensor latitude',
      kind: 'number',
      min: -90,
      max: 90,
      step: 0.0001,
      defaultLabel: 'As the sensor reports it',
      description: 'Only if the position the sensor reports is wrong: decimal degrees, north positive.',
    },
    {
      key: 'longitude',
      label: 'Sensor longitude',
      kind: 'number',
      min: -180,
      max: 180,
      step: 0.0001,
      defaultLabel: 'As the sensor reports it',
      description: 'Decimal degrees, east positive (west is negative).',
    },
    {
      key: 'name',
      label: 'Sensor name',
      kind: 'string',
      placeholder: 'Porch',
      defaultLabel: 'Air-quality sensor',
      description: 'How the sensor is labelled on the map.',
    },
  ],
};

export const PROBE_BACKOFF_MS = 60_000;
