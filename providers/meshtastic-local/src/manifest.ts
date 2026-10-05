import type { ProviderManifest } from '@worldview/provider-sdk';
import { DEFAULT_MESHTASTIC_PORT } from './wire.js';

/**
 * The nodes of the user's own Meshtastic mesh (LoRa radios), read from one of the user's own
 * nodes over its client API on TCP — a node with Wi-Fi or Ethernet, or `meshtasticd` on this
 * computer — the connection WORLDVIEW opens to it (the node is the server; WORLDVIEW never
 * listens). The node is asked once for its node list, then streams what it hears.
 *
 * Positions, node info and telemetry only: text messages are never read. Off by default; with
 * no host named it connects to loopback only. Like the MQTT gateway preset, this is for the
 * operator's own mesh, and like it the data stays on the computer: no export, no packs, no
 * redistribution — other people's nodes may be on the mesh.
 */
export const MESHTASTIC_LOCAL_MANIFEST: ProviderManifest = {
  id: 'meshtastic-local',
  name: 'Meshtastic mesh (your node over TCP)',
  version: '0.1.0',
  description:
    "Nodes of the user's own Meshtastic mesh, read from one of their nodes over its TCP client API (loopback, or the one host named). Positions, node info and telemetry; text messages are never read. Nothing leaves the network.",
  objectTypes: ['sensor'],
  categories: ['infrastructure'],
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
    // Nodes broadcast their position every 15 minutes by default (less often when still), and
    // node info every three hours.
    freshness: { sensor: { liveSeconds: 1800, recentSeconds: 7200, expireSeconds: 172_800 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: false,
    attributionRequired: false,
    attributionText: 'Own Meshtastic node',
  },
  attribution: { text: 'Own Meshtastic node', url: 'https://meshtastic.org/docs/development/device/client-api/' },
  commercialReview: 'approved',
  enabledByDefault: false,
  allowedHosts: ['127.0.0.1', 'localhost'],
  trustedHostSetting: 'host',
  settings: [
    {
      key: 'host',
      label: 'Node on your network',
      kind: 'string',
      placeholder: 'meshtastic.local',
      defaultLabel: 'This computer (127.0.0.1, meshtasticd)',
      description:
        'The Meshtastic node to read from: one with Wi-Fi or Ethernet and its network API on, by name or address. Only this host is contacted; nothing is discovered.',
    },
    {
      key: 'port',
      label: 'TCP port',
      kind: 'number',
      min: 1,
      max: 65535,
      step: 1,
      defaultLabel: String(DEFAULT_MESHTASTIC_PORT),
      description: "The node's client API port (4403 unless you changed it).",
      helpUrl: 'https://meshtastic.org/docs/development/device/client-api/',
    },
  ],
  telemetry: {
    series: [
      { key: 'batteryPct', name: 'Battery', units: '%', format: 'percent', min: 0, max: 100 },
      { key: 'voltageV', name: 'Voltage', units: 'V', format: 'volts' },
      { key: 'temperatureC', name: 'Temperature', units: '°C', format: 'celsius' },
      { key: 'humidityPct', name: 'Humidity', units: '%', format: 'percent', min: 0, max: 100 },
      { key: 'pressureHpa', name: 'Pressure', units: 'hPa', format: 'hpa' },
      { key: 'snrDb', name: 'Signal-to-noise', units: 'dB', format: 'number:1' },
      { key: 'rssiDbm', name: 'Signal', units: 'dBm', format: 'dbm' },
      { key: 'channelUtilizationPct', name: 'Channel use', units: '%', format: 'percent', min: 0, max: 100 },
      { key: 'airUtilTxPct', name: 'Airtime (transmit)', units: '%', format: 'percent', min: 0, max: 100 },
    ],
  },
};

/** Reconnect back-off after the node goes away: 5 s, doubling, at most a minute. */
export const RECONNECT_MIN_MS = 5_000;
export const RECONNECT_MAX_MS = 60_000;
/** A heartbeat every five minutes keeps an otherwise quiet connection open. */
export const HEARTBEAT_MS = 5 * 60_000;
