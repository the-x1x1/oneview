import type { ProviderManifest } from '@worldview/provider-sdk';
import { DEFAULT_YD_RAW_PORT } from './wire.js';

/**
 * The user's own boat's NMEA 2000 network, read through a gateway that serves it in Yacht
 * Devices' RAW text format over TCP (YDWG-02, YDEN-02, and others that offer "YD RAW"): the boat itself — GNSS position, course and speed, heading, depth, wind, water and air
 * temperature, pressure — and the ships its AIS receiver hears. WORLDVIEW connects to the
 * gateway (the gateway is the server; WORLDVIEW never listens) and only reads: nothing is sent
 * onto the bus.
 *
 * Off by default; with no host named it connects to loopback only. The boat's own track is
 * the operator's, so like the other local sources nothing is uploaded; it may be exported.
 */
export const NMEA2000_LOCAL_MANIFEST: ProviderManifest = {
  id: 'nmea2000-local',
  name: 'Your boat (NMEA 2000 gateway)',
  version: '0.1.0',
  description:
    "The user's own boat and the ships its AIS hears, read from the boat's NMEA 2000 network through a gateway serving Yacht Devices RAW over TCP (loopback, or the one host named). Read only; nothing is sent onto the bus and nothing leaves the network.",
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
    // The boat's own position arrives several times a second; AIS class A under way every
    // 2–10 s, at anchor every 3 min, class B every 30 s – 3 min.
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
    attributionText: 'Own NMEA 2000 network',
  },
  attribution: { text: 'Own NMEA 2000 network', url: 'https://www.yachtd.com/downloads/ydwg02.pdf' },
  commercialReview: 'approved',
  enabledByDefault: false,
  allowedHosts: ['127.0.0.1', 'localhost'],
  trustedHostSetting: 'host',
  settings: [
    {
      key: 'host',
      label: 'Gateway on your network',
      kind: 'string',
      placeholder: '192.168.4.1',
      defaultLabel: 'This computer (127.0.0.1)',
      description:
        "The NMEA 2000 gateway to read from, by name or address — one with a TCP server set to the RAW protocol. Only this host is contacted; nothing is discovered, and nothing is sent onto the boat's network.",
    },
    {
      key: 'port',
      label: 'RAW server TCP port',
      kind: 'number',
      min: 1,
      max: 65535,
      step: 1,
      defaultLabel: String(DEFAULT_YD_RAW_PORT),
      description:
        "The port of the gateway's TCP server set to the RAW protocol. On a Yacht Devices gateway, set one of its servers to TCP and RAW on its web page and give that server's port here.",
      helpUrl: 'https://www.yachtd.com/downloads/ydwg02.pdf',
    },
    {
      key: 'mmsi',
      label: "Your boat's MMSI",
      kind: 'string',
      placeholder: '366123456',
      defaultLabel: 'None',
      description:
        "Optional. With it, your boat is the same object as when another AIS source hears it, and its flag is shown; your own AIS transponder's reports are then not drawn as a second ship.",
    },
    {
      key: 'name',
      label: "Your boat's name",
      kind: 'string',
      placeholder: 'Own vessel',
      defaultLabel: 'Own vessel',
      description: 'What the map and the panel call your boat.',
    },
  ],
  telemetry: {
    series: [
      { key: 'depthM', name: 'Depth (below transducer)', units: 'm', format: 'number:1', min: 0 },
      { key: 'speedMps', name: 'Speed over ground', units: 'm/s', format: 'mps', min: 0 },
      { key: 'speedThroughWaterMps', name: 'Speed through water', units: 'm/s', format: 'mps', min: 0 },
      { key: 'windSpeedMps', name: 'True wind speed', units: 'm/s', format: 'mps', min: 0 },
      { key: 'apparentWindSpeedMps', name: 'Apparent wind speed', units: 'm/s', format: 'mps', min: 0 },
      { key: 'waterTemperatureC', name: 'Water temperature', units: '°C', format: 'celsius' },
      { key: 'temperatureC', name: 'Air temperature', units: '°C', format: 'celsius' },
      { key: 'pressureHpa', name: 'Pressure', units: 'hPa', format: 'hpa' },
    ],
  },
};

/** Reconnect back-off after the gateway goes away: 5 s, doubling, at most a minute. */
export const RECONNECT_MIN_MS = 5_000;
export const RECONNECT_MAX_MS = 60_000;
/** The boat and the ships it hears are sent on at most once a second. */
export const FLUSH_INTERVAL_MS = 1_000;
