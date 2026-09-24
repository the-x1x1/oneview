import { s, type Schema } from '@worldview/world-model';
import { parseDefinition, type Condition, type ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { checkTopicFilter } from './topics.js';

/**
 * The `mqtt` block of a connector definition — the shape amendment request M1 in
 * `docs/roadmap/phases/mqtt.md` asks the definition schema to carry (ADR-013), written here
 * exactly as requested so it can move into `@worldview/connector-sdk` unchanged. Until it
 * lands, `definitionSchema` (whose root object is not strict) drops the block, so a
 * definition passed through `ConnectorRegistry.validate` reaches the connector without it;
 * `parseMqttDefinition` reads a document with the block for the phase's own tests.
 *
 * What a definition may say about a broker: the port, TLS, a username, the password by
 * credential reference, a client id, the topics (filters with `+`/`#`, QoS 0 or 1), a
 * payload preset, where the records are in a message, message filters, batching, the
 * transport's caps and a table of fixed positions per device. What it may not say: the
 * broker's host. That is the operator's `brokerHost` setting (the manifest's
 * `trustedHostSetting`), and without it the broker is on this computer (127.0.0.1) — the
 * local-endpoint policy of ADR-003, enforced again by the runtime's client.
 */
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

/** A definition that runs on the `mqtt` connector: the same type with the block M1 adds. */
export type MqttConnectorDefinition = ConnectorProviderDefinition & { mqtt?: MqttSpec };

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
 * The refine M1 adds to `definitionSchema` for a definition with an `mqtt` block: the
 * credential it names is declared, and it is not also an HTTP, socket or file source.
 */
export function checkMqttDefinition(d: MqttConnectorDefinition): string | undefined {
  const m = d.mqtt;
  if (!m) return undefined;
  if (m.credential && !Object.keys(d.credentials ?? {}).includes(m.credential.name))
    return `mqtt.credential names "${m.credential.name}", which credentials does not declare`;
  if (d.endpoint || d.websocket || d.file) return 'a definition with mqtt has no endpoint, websocket or file';
  return undefined;
}

/**
 * A definition document read as M1 would read it: the frozen schema, then the `mqtt` block
 * with `mqttSpecSchema` and `checkMqttDefinition`. Issues are human-readable, as
 * `parseDefinition`'s are.
 */
export function parseMqttDefinition(
  doc: unknown,
): { ok: true; definition: MqttConnectorDefinition } | { ok: false; issues: string[] } {
  const base = parseDefinition(doc);
  if (!base.ok) return base;
  const raw = doc && typeof doc === 'object' ? (doc as Record<string, unknown>)['mqtt'] : undefined;
  if (raw === undefined) return { ok: true, definition: base.definition };
  const r = mqttSpecSchema.parse(raw, 'mqtt');
  if (!r.ok) return { ok: false, issues: r.issues.map((i) => `${i.path || 'mqtt'}: ${i.message}`) };
  const definition: MqttConnectorDefinition = { ...base.definition, mqtt: r.value };
  const bad = checkMqttDefinition(definition);
  return bad ? { ok: false, issues: [`$: ${bad}`] } : { ok: true, definition };
}

/** The `mqtt` block of a definition, when it reached the connector. */
export function mqttSpecOf(d: ConnectorProviderDefinition): MqttSpec | undefined {
  return (d as MqttConnectorDefinition).mqtt;
}
