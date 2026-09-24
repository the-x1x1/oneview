import { s, type Schema } from '@worldview/world-model';
import type { Condition } from './mapping.js';

/**
 * The `mqtt` block of a connector definition (ADR-013 amendment 2026-09-24, request M1 of
 * phase `mqtt`): what a definition may say about a broker — the port, TLS, a username, the
 * password by credential reference, a client id, the topics (filters with `+`/`#`, QoS 0 or
 * 1), a payload preset, where the records are in a message, message filters, batching, the
 * transport's caps and a table of fixed positions per device. What it may not say: the
 * broker's host. That is the operator's `brokerHost` setting (the manifest's
 * `trustedHostSetting`), and without it the broker is on this computer (127.0.0.1) — the
 * local-endpoint policy of ADR-003, enforced again by the runtime's client.
 */
export const MAX_TOPIC_LENGTH = 256;

/** Why `filter` is not a topic filter this connector subscribes with, or undefined. */
export function checkTopicFilter(filter: string): string | undefined {
  if (!filter) return 'is empty';
  if (filter.length > MAX_TOPIC_LENGTH) return `is longer than ${MAX_TOPIC_LENGTH} characters`;
  // NUL is forbidden by the protocol; the other control characters are refused here too.
  for (let i = 0; i < filter.length; i++) if (filter.charCodeAt(i) < 0x20) return 'contains a control character';
  const levels = filter.split('/');
  for (const [i, level] of levels.entries()) {
    if (level.includes('#') && (level !== '#' || i !== levels.length - 1))
      return '"#" must be a whole level and the last one';
    if (level.includes('+') && level !== '+') return '"+" must be a whole level';
  }
  return undefined;
}

export const MQTT_PRESETS = ['rtl_433', 'owntracks', 'meshtastic'] as const;
export type MqttPreset = (typeof MQTT_PRESETS)[number];

export const MAX_MQTT_TOPICS = 16;
export const MAX_POSITION_TABLE = 1024;
export const DEFAULT_MQTT_FLUSH_MS = 500;
/** The runtime's default is 256 KiB; a definition may ask for less, or up to 1 MiB. */
export const MAX_MQTT_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_MQTT_MESSAGES_PER_SECOND = 2000;

export interface MqttTopicSpec {
  /** A topic filter: levels separated by `/`, `+` for one level, `#` (last) for the rest. */
  topic: string;
  /** 0 (default) or 1; the runtime never subscribes at 2. */
  qos?: 0 | 1;
}

export interface MqttSpec {
  topics: MqttTopicSpec[];
  /** Default 1883, or 8883 with `tls`. */
  port?: number;
  tls?: boolean;
  /** Sent as the MQTT username; not a secret. */
  username?: string;
  /** The credential (a key of `credentials`) whose secret is the MQTT password. */
  credential?: { name: string };
  /** Default: `worldview-` and random hex, from the runtime. */
  clientId?: string;
  /** A named payload reader (`presets.ts`); absent: the payload is JSON records as they are. */
  preset?: MqttPreset;
  /** Path in each message to the record(s); default: the message itself. */
  itemsPath?: string;
  /** Messages are kept only when every condition holds (same conditions as mapping.filter). */
  filter?: Condition[];
  /** Coalesce observations for this long before emitting a batch (default 500 ms; 0 emits per message). */
  flushMs?: number;
  maxPayloadBytes?: number;
  maxMessagesPerSecond?: number;
  keepAliveSeconds?: number;
  /** Fixed `[lat, lon]` per device, by the external id the mapping gives it (stationary sensors). */
  positions?: Record<string, [number, number]>;
}

const conditionSchema = s.object({
  path: s.string({ min: 1, max: 256 }),
  equals: s.optional(s.json({ maxDepth: 2 })),
  notEquals: s.optional(s.json({ maxDepth: 2 })),
  in: s.optional(s.array(s.json({ maxDepth: 2 }), { max: 64 })),
  exists: s.optional(s.boolean()),
  min: s.optional(s.number()),
  max: s.optional(s.number()),
});

export const mqttSpecSchema: Schema<MqttSpec> = s.refine(
  s.object({
    topics: s.array(
      s.object({
        topic: s.string({ min: 1, max: 256 }),
        qos: s.optional(s.enum([0, 1] as const)),
      }),
      { min: 1, max: MAX_MQTT_TOPICS },
    ),
    port: s.optional(s.number({ min: 1, max: 65_535, integer: true })),
    tls: s.optional(s.boolean()),
    username: s.optional(s.string({ min: 1, max: 128, pattern: /^[\x21-\x7e][\x20-\x7e]*$/ })),
    credential: s.optional(s.object({ name: s.string({ min: 1, max: 64 }) })),
    clientId: s.optional(s.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ })),
    preset: s.optional(s.enum(MQTT_PRESETS)),
    itemsPath: s.optional(s.string({ min: 1, max: 256 })),
    filter: s.optional(s.array(conditionSchema, { max: 16 })),
    flushMs: s.optional(s.number({ min: 0, max: 5000 })),
    maxPayloadBytes: s.optional(s.number({ min: 256, max: MAX_MQTT_PAYLOAD_BYTES, integer: true })),
    maxMessagesPerSecond: s.optional(s.number({ min: 1, max: MAX_MQTT_MESSAGES_PER_SECOND, integer: true })),
    keepAliveSeconds: s.optional(s.number({ min: 5, max: 3600, integer: true })),
    positions: s.optional(
      s.record(s.tuple([s.number({ min: -90, max: 90 }), s.number({ min: -180, max: 180 })] as const), {
        keyPattern: /^\S(?:.{0,254}\S)?$/,
        max: MAX_POSITION_TABLE,
      }),
    ),
  }),
  (m) => {
    for (const t of m.topics) {
      const bad = checkTopicFilter(t.topic);
      if (bad) return `topic "${t.topic}": ${bad}`;
    }
    const seen = new Set<string>();
    for (const t of m.topics) {
      if (seen.has(t.topic)) return `topic "${t.topic}" is listed twice`;
      seen.add(t.topic);
    }
    return undefined;
  },
) as Schema<MqttSpec>;

/**
 * The part of `definitionSchema`'s refine for a definition with an `mqtt` block: the
 * credential it names is declared, and it is not also an HTTP, socket or file source.
 */
export function checkMqttDefinition(d: {
  mqtt?: MqttSpec;
  credentials?: Record<string, unknown>;
  endpoint?: unknown;
  websocket?: unknown;
  file?: unknown;
}): string | undefined {
  const m = d.mqtt;
  if (!m) return undefined;
  if (m.credential && !Object.keys(d.credentials ?? {}).includes(m.credential.name))
    return `mqtt.credential names "${m.credential.name}", which credentials does not declare`;
  if (d.endpoint || d.websocket || d.file) return 'a definition with mqtt has no endpoint, websocket or file';
  return undefined;
}
