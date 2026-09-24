import type { IsoTimestamp, JsonValue, Observation } from '@worldview/world-model';
import {
  ProviderError,
  stringSetting,
  type CredentialState,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderMqttHandle,
  type ProviderMqttOptions,
  type ProviderSettingDefinition,
  type ProviderStatus,
  type ProviderSubscription,
  type Unsubscribe,
  type WorldProvider,
} from '@worldview/provider-sdk';
import {
  compileMapping,
  definitionToManifest,
  extractRecords,
  mapRecord,
  mapRecords,
  type CompiledMapping,
  type Condition,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
  type Field,
  type MappingSpec,
  type PositionSpec,
} from '@worldview/connector-sdk';
import { DEFAULT_MQTT_FLUSH_MS, mqttSpecOf, type MqttSpec } from './contract.js';
import { createPreset, type PayloadPreset } from './presets.js';
import { matchesAny, topicLevels } from './topics.js';

/**
 * MQTT: topics on a broker on this computer, or on the one host the operator names, as a
 * live source (ADR-003 amendment 2026-09-23 for the transport; `contract.ts` for the
 * definition's `mqtt` block). The provider subscribes through `ProviderContext.mqtt` — the
 * runtime's own MQTT 3.1.1 client, which resolves the password from the credential store
 * and never hands it over — and maps every message:
 *
 *   - the payload is JSON records (`mqtt.itemsPath`, `mqtt.filter`), read by a preset when
 *     the definition names one (`presets.ts`); anything that is not a JSON object or array is
 *     one record `{ raw, topic }` (and skipped under a preset, which expects JSON);
 *   - every record carries `_topic` (the topic name) and `_topicLevels`; a mapping may write
 *     `_topic[n]` for the n-th level, which the connector reads as `_topicLevels[n]` (the path
 *     grammar indexes arrays only);
 *   - a record without a position of its own is placed from `mqtt.positions` (by the external
 *     id the mapping gives it), else from the operator's `position.fixed` setting; one that
 *     has neither is counted and named in Source Health, not silently dropped;
 *   - a retained message is taken once: the broker sends it again on every reconnect, and
 *     the same payload on the same topic is not mapped twice;
 *   - observations are coalesced by external id and emitted every `mqtt.flushMs`.
 *
 * A dropped connection is reopened with a back-off from 2 s to a minute; a changed
 * `brokerHost` reconnects at once. Nothing is ever published.
 */
export const MQTT_CONNECTOR_ID = 'mqtt';
/** The manifest's `trustedHostSetting`: the one host on the network the broker may be on. */
export const BROKER_HOST_SETTING = 'brokerHost';
/** `lat, lon` for a stationary sensor whose messages carry no position. */
export const FIXED_POSITION_SETTING = 'position.fixed';
/** The broker when the operator names none: this computer, by address (Windows resolves `localhost` to ::1 first). */
export const LOOPBACK_BROKER = '127.0.0.1';
export const MQTT_ALLOWED_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost']);
export const MAX_RECORDS_PER_MESSAGE = 1000;
/** On an observation placed from `mqtt.positions` or `position.fixed`: the operator's position, not the device's. */
export const CONFIGURED_POSITION_FLAG = 'configured-position';
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RETAINED_TOPICS = 4096;
const MAX_UNPLACED_NAMED = 5;
const MAX_IDS = 100_000;

export interface MqttTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: MqttTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h !== null && 'unref' in h) (h as { unref(): void }).unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface MqttProviderOptions {
  flushIntervalMs?: number;
  timers?: MqttTimers;
}

// ── the definition, as the connector reads it ─────────────────────────────────

/** `_topic[`, in each spelling the path grammar allows: `_topic[1]`, `$._topic[1]`, `["_topic"][1]`, `$["_topic"][1]`. */
const TOPIC_INDEX = /^(?:\$\.)?_topic\[|^\$?\["_topic"\]\[/;
const rewritePath = (p: string): string => (TOPIC_INDEX.test(p) ? p.replace(TOPIC_INDEX, '_topicLevels[') : p);

function rewriteField(f: Field): Field {
  if (typeof f === 'string') return rewritePath(f);
  const out = { ...f };
  if (out.path !== undefined) out.path = rewritePath(out.path);
  if (out.fallback !== undefined)
    out.fallback = Array.isArray(out.fallback) ? out.fallback.map(rewritePath) : rewritePath(out.fallback);
  return out;
}
const rewriteFields = (m: Record<string, Field> | undefined) =>
  m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, rewriteField(v)])) : undefined;
const rewriteConditions = (c: Condition[] | undefined) => c?.map((x) => ({ ...x, path: rewritePath(x.path) }));

function rewritePosition(p: PositionSpec): PositionSpec {
  if ('lat' in p)
    return { ...p, lat: rewriteField(p.lat), lon: rewriteField(p.lon), ...(p.alt ? { alt: rewriteField(p.alt) } : {}) };
  if ('geometry' in p) return { ...p, geometry: rewriteField(p.geometry) };
  if ('lonLat' in p) return { ...p, lonLat: rewriteField(p.lonLat) };
  return { ...p, latLon: rewriteField(p.latLon) };
}

/** The definition's mapping with `_topic[n]` read as `_topicLevels[n]`. */
export function topicMapping(m: MappingSpec): MappingSpec {
  const out: MappingSpec = { ...m, externalId: rewriteField(m.externalId) };
  if (m.observedAt) out.observedAt = rewriteField(m.observedAt);
  if (m.position) out.position = rewritePosition(m.position);
  if (m.geometry) out.geometry = rewriteField(m.geometry);
  if (m.labels) out.labels = rewriteFields(m.labels)!;
  if (m.properties) out.properties = rewriteFields(m.properties)!;
  if (m.motion) out.motion = rewriteFields(m.motion as Record<string, Field>) as NonNullable<MappingSpec['motion']>;
  if (m.filter) out.filter = rewriteConditions(m.filter)!;
  return out;
}

/** The same mapping for a record placed by the connector: its position is `_position`. */
export function placedMapping(m: MappingSpec): MappingSpec {
  const { geometry: _geometry, ...rest } = m;
  return { ...rest, position: { lat: '_position.lat', lon: '_position.lon' } };
}

/** `lat, lon` (comma or whitespace between) → a position, or undefined. */
export function parseFixedPosition(v: unknown): { lat: number; lon: number } | undefined {
  if (typeof v !== 'string') return undefined;
  const parts = v
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (parts.length !== 2) return undefined;
  const [lat, lon] = parts.map(Number) as [number, number];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

export const MQTT_SETTINGS: readonly ProviderSettingDefinition[] = Object.freeze([
  {
    key: BROKER_HOST_SETTING,
    label: 'Broker address',
    description:
      'The computer on your network that runs the MQTT broker (an IP address or a host name). Leave empty for a broker on this computer. Only this host is contacted.',
    kind: 'string',
    defaultLabel: 'This computer (127.0.0.1)',
    placeholder: '192.168.1.20',
  },
  {
    key: FIXED_POSITION_SETTING,
    label: 'Fixed position (lat, lon)',
    description:
      'Where a sensor that does not send its position is, as latitude and longitude in degrees. Used for every device of this source that has no position of its own or in the definition.',
    kind: 'string',
    placeholder: '21.3069, -157.8583',
  },
]);

/** The manifest: a local-process source reaching loopback, or the host the operator names. */
export function mqttManifest(d: ConnectorProviderDefinition): ProviderManifest {
  const m = definitionToManifest(d, 'MQTT');
  m.transport = 'local-process';
  m.capabilities = { live: true, historical: false, offline: false, boundsQuery: false };
  m.allowedHosts = [...MQTT_ALLOWED_HOSTS];
  m.trustedHostSetting = BROKER_HOST_SETTING;
  const own = new Set(MQTT_SETTINGS.map((s) => s.key));
  m.settings = [...MQTT_SETTINGS, ...(d.settings ?? []).filter((s) => !own.has(s.key))].slice(0, 24);
  return m;
}

// ── the provider ────────────────────────────────────────────────────────────

interface Session {
  emit: ObservationEmitter;
  /** The current connection attempt's own signal (one per connection, so none outlives it). */
  connAbort: AbortController | undefined;
  handle: ProviderMqttHandle | undefined;
  pending: Map<string, Observation>;
  flushTimer: unknown;
  retryTimer: unknown;
  retryMs: number;
  closed: boolean;
  generation: number;
  /** Where the current connection goes, for sourceRef and the reconnect on a changed setting. */
  host: string;
  port: number;
}

export interface MqttStats {
  messages: number;
  records: number;
  observations: number;
  rejected: number;
  filtered: number;
  malformed: number;
  skipped: number;
  offTopic: number;
  retainedRepeats: number;
  unplaced: number;
  reconnects: number;
}

export class MqttProvider implements WorldProvider {
  readonly manifest: ProviderManifest;
  readonly spec: MqttSpec;
  private context!: ProviderContext;
  private readonly mapping: CompiledMapping;
  private readonly placed: CompiledMapping;
  /** `mqtt.filter` through the mapping's own condition semantics. */
  private readonly messageFilter: CompiledMapping | undefined;
  private readonly preset: PayloadPreset | undefined;
  private readonly filters: string[];
  /** The mapping reads no position of its own: every device is placed by the table or position.fixed. */
  private readonly stationary: boolean;
  private readonly flushIntervalMs: number;
  private readonly timers: MqttTimers;
  private session: Session | undefined;
  private running = false;
  private connected = false;
  private settings: Record<string, JsonValue> = {};
  private settingsUnsub: Unsubscribe | undefined;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private droppedBefore = 0;
  private readonly ids = new Set<string>();
  /** The last payload's hash per topic, live or retained: a retained copy of it is not mapped again. */
  private readonly lastPayload = new Map<string, string>();
  private readonly unplacedIds = new Set<string>();
  readonly stats: MqttStats = {
    messages: 0,
    records: 0,
    observations: 0,
    rejected: 0,
    filtered: 0,
    malformed: 0,
    skipped: 0,
    offTopic: 0,
    retainedRepeats: 0,
    unplaced: 0,
    reconnects: 0,
  };

  constructor(
    readonly definition: ConnectorProviderDefinition,
    options: MqttProviderOptions = {},
  ) {
    const spec = mqttSpecOf(definition);
    if (!spec) throw new Error(`${definition.id}: the MQTT connector needs an mqtt block`);
    this.spec = spec;
    this.manifest = mqttManifest(definition);
    const mapping = topicMapping(definition.mapping);
    this.mapping = compileMapping(mapping);
    this.placed = compileMapping(placedMapping(mapping));
    this.messageFilter = spec.filter?.length
      ? compileMapping({ externalId: { literal: 'message' }, filter: rewriteConditions(spec.filter)! })
      : undefined;
    this.preset = spec.preset ? createPreset(spec.preset) : undefined;
    this.filters = spec.topics.map((t) => t.topic);
    this.stationary = !definition.mapping.position && !definition.mapping.geometry;
    this.flushIntervalMs = options.flushIntervalMs ?? spec.flushMs ?? DEFAULT_MQTT_FLUSH_MS;
    this.timers = options.timers ?? realTimers;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
    this.settings = await context.settings.get();
  }
  async start(): Promise<void> {
    this.running = true;
    this.settingsUnsub ??= this.context.settings.onChange((next) => this.onSettings(next));
  }
  async stop(): Promise<void> {
    this.running = false;
    this.settingsUnsub?.();
    this.settingsUnsub = undefined;
    if (this.session) this.closeSession(this.session);
  }

  /** The broker this source connects to: the operator's host, else this computer. */
  brokerHost(settings: Record<string, JsonValue> = this.settings): string {
    return stringSetting(settings, BROKER_HOST_SETTING, { host: true }) ?? LOOPBACK_BROKER;
  }
  get brokerPort(): number {
    return this.spec.port ?? (this.spec.tls ? 8883 : 1883);
  }
  private get credentialKey(): string | undefined {
    const c = this.spec.credential;
    return c ? this.definition.credentials?.[c.name]?.secretRef : undefined;
  }

  private onSettings(next: Record<string, JsonValue>): void {
    const hostChanged = this.brokerHost(next) !== this.brokerHost();
    this.settings = next;
    const session = this.session;
    if (!hostChanged || !session || session.closed || !this.running) return;
    // The operator moved the broker: drop this connection and go to the new host now.
    this.context.logger.info('broker address changed; reconnecting', { host: this.brokerHost() });
    this.invalidate(session);
    this.scheduleReconnect(session, 0);
  }

  async subscribe(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe> {
    if (this.session) this.closeSession(this.session);
    const session: Session = {
      emit,
      connAbort: undefined,
      handle: undefined,
      pending: new Map(),
      flushTimer: undefined,
      retryTimer: undefined,
      retryMs: RECONNECT_MIN_MS,
      closed: false,
      generation: 0,
      host: this.brokerHost(),
      port: this.brokerPort,
    };
    this.session = session;
    request.signal.addEventListener('abort', () => this.closeSession(session), { once: true });
    if (request.signal.aborted) {
      this.closeSession(session);
      throw new ProviderError('CANCELLED', 'cancelled before the broker was contacted');
    }
    try {
      await this.connect(session);
    } catch (err) {
      this.closeSession(session);
      throw err;
    }
    if (session.closed) throw new ProviderError('CANCELLED', 'cancelled while the broker was contacted');
    return () => this.closeSession(session);
  }

  /**
   * One connection attempt. It throws only for a failure that is still current: an attempt
   * that a newer one (a changed broker address) or a closed session has overtaken resolves
   * quietly, so it can neither schedule a reconnect of its own nor overwrite `lastError` —
   * and one overtaken by closing the session throws CANCELLED.
   */
  private async connect(session: Session): Promise<void> {
    const mqtt = this.context.mqtt;
    if (!mqtt)
      throw this.fail(
        new ProviderError('UNSUPPORTED', 'this build has no MQTT transport, so the source cannot connect', {
          retryable: false,
        }),
      );
    const key = this.credentialKey;
    if (key && !(await this.context.credentials.has(key)))
      throw this.fail(new ProviderError('AUTH', `credential ${key} not configured`, { retryable: false }));
    if (session.closed) throw new ProviderError('CANCELLED', 'cancelled before the broker was contacted');
    const generation = ++session.generation;
    // Whatever an earlier attempt left open is closed and forgotten here, not by its own
    // callbacks (they belong to an old generation now): its drops counted, the source not
    // LIVE again until this attempt opens.
    session.connAbort?.abort();
    if (session.handle) {
      this.droppedBefore += session.handle.dropped;
      session.handle.close();
      session.handle = undefined;
    }
    this.connected = false;
    const conn = new AbortController();
    session.connAbort = conn;
    session.host = this.brokerHost();
    session.port = this.brokerPort;
    this.lastAttempt = this.nowIso();
    const current = () => session.generation === generation && !session.closed;
    const spec = this.spec;
    const opts: ProviderMqttOptions = {
      host: session.host,
      port: session.port,
      subscriptions: spec.topics.map((t) => ({ topic: t.topic, qos: t.qos ?? 0 })),
      signal: conn.signal,
      ...(spec.tls ? { tls: true } : {}),
      ...(spec.username !== undefined ? { username: spec.username } : {}),
      ...(key ? { credential: { key } } : {}),
      ...(spec.clientId !== undefined ? { clientId: spec.clientId } : {}),
      ...(spec.maxPayloadBytes !== undefined ? { maxPayloadBytes: spec.maxPayloadBytes } : {}),
      ...(spec.maxMessagesPerSecond !== undefined ? { maxMessagesPerSecond: spec.maxMessagesPerSecond } : {}),
      ...(spec.keepAliveSeconds !== undefined ? { keepAliveSeconds: spec.keepAliveSeconds } : {}),
    };
    let handle: ProviderMqttHandle;
    try {
      handle = await mqtt.connect(opts, {
        // The runtime calls onOpen (and may deliver retained messages) before this await
        // resumes, so the callbacks go by the generation, never by `session.handle`.
        onOpen: () => {
          if (!current()) return;
          this.connected = true;
          this.lastError = undefined;
          this.lastSuccess = this.nowIso();
          session.retryMs = RECONNECT_MIN_MS;
          session.emit([], { snapshot: false });
        },
        onMessage: (topic, payload, meta) => {
          if (current()) this.onMessage(session, topic, payload, meta.retained);
        },
        onClose: (reason) => {
          if (current())
            this.onDrop(
              session,
              new ProviderError(
                'OFFLINE',
                `the broker connection closed${reason && !/^(connection )?closed$/.test(reason) ? `: ${reason}` : ''}`,
              ),
            );
        },
        onError: (error) => {
          if (current()) this.onDrop(session, error);
        },
      });
    } catch (err) {
      if (session.closed) throw new ProviderError('CANCELLED', 'cancelled while the broker was contacted');
      if (!current()) return; // overtaken by a newer attempt, which reports for itself
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('NETWORK', err instanceof Error ? err.message : String(err));
      throw this.fail(pe);
    }
    if (!current()) {
      handle.close();
      return;
    }
    session.handle = handle;
  }

  private onMessage(session: Session, topic: string, payload: Uint8Array, retained: boolean): void {
    this.stats.messages++;
    if (!matchesAny(this.filters, topic)) {
      this.stats.offTopic++;
      return;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch {
      this.stats.malformed++;
      return;
    }
    // The broker re-sends a topic's retained message on every (re)connect. A retained copy of
    // the payload last seen on the topic — retained or live, since a live delivery of a
    // retained publish arrives without the flag — is not mapped again.
    const hash = this.context.hash.sha256Hex(text);
    const repeat = this.lastPayload.get(topic) === hash;
    this.lastPayload.delete(topic);
    this.lastPayload.set(topic, hash);
    if (this.lastPayload.size > MAX_RETAINED_TOPICS) this.lastPayload.delete(this.lastPayload.keys().next().value!);
    if (retained && repeat) {
      this.stats.retainedRepeats++;
      return;
    }
    const levels = topicLevels(topic);
    let body: unknown;
    let json = true;
    try {
      body = JSON.parse(text);
    } catch {
      json = false;
    }
    const structured = json && typeof body === 'object' && body !== null;
    let records: unknown[];
    if (!structured) {
      // Not a JSON object or array: under a preset that is not a message it reads; without
      // one it is a record of its own, `{ raw, topic }`, for a mapping that wants it.
      if (this.preset) {
        this.stats.malformed++;
        return;
      }
      records = [{ raw: text, topic }];
    } else {
      if (this.messageFilter) {
        // An array message is probed as `_items`, so `_topic[n]` conditions work on it too.
        const probe = Array.isArray(body)
          ? { _items: body as JsonValue, _topic: topic, _topicLevels: levels }
          : { ...(body as object), _topic: topic, _topicLevels: levels };
        const r = mapRecord(probe, this.messageFilter);
        if (!r.ok) {
          this.stats.filtered++;
          return;
        }
      }
      if (this.preset) {
        const at = this.spec.itemsPath ? extractRecords(body, { itemsPath: this.spec.itemsPath }) : { records: [body] };
        if ('malformed' in at) {
          this.stats.malformed++;
          return;
        }
        records = [];
        for (const item of at.records) {
          const read = this.preset.read(item, topic, levels);
          if ('skipped' in read) this.stats.skipped++;
          else records.push(...read.records);
        }
      } else {
        const found = extractRecords(body, this.spec.itemsPath ? { itemsPath: this.spec.itemsPath } : undefined);
        if ('malformed' in found) {
          this.stats.malformed++;
          return;
        }
        records = found.records;
      }
    }
    if (records.length > MAX_RECORDS_PER_MESSAGE) {
      this.stats.rejected += records.length - MAX_RECORDS_PER_MESSAGE;
      records = records.slice(0, MAX_RECORDS_PER_MESSAGE);
    }
    this.mapAndQueue(session, topic, levels, records, retained);
  }

  private mapAndQueue(session: Session, topic: string, levels: string[], records: unknown[], retained: boolean): void {
    const own: unknown[] = [];
    const placed: unknown[] = [];
    // position.fixed is for a stationary source (a mapping with no position of its own); a
    // device that normally reports where it is and has not yet is never put at a fixed point.
    const fixed = this.stationary ? parseFixedPosition(this.settings[FIXED_POSITION_SETTING]) : undefined;
    for (const raw of records) {
      const record =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>), _topic: topic, _topicLevels: levels }
          : { value: raw as JsonValue, _topic: topic, _topicLevels: levels };
      const r = mapRecord(record, this.mapping);
      if (!r.ok || r.record.position || r.record.geometry) {
        own.push(record); // mapped as is: rejections and filtering are counted by mapRecords
        continue;
      }
      const externalId = r.record.externalId;
      const positions = this.spec.positions;
      const table = positions && Object.hasOwn(positions, externalId) ? positions[externalId] : undefined;
      const at = table ? { lat: table[0], lon: table[1] } : fixed;
      if (!at) {
        this.stats.unplaced++;
        this.unplacedIds.delete(externalId);
        this.unplacedIds.add(externalId);
        if (this.unplacedIds.size > 1000) this.unplacedIds.delete(this.unplacedIds.values().next().value!);
        continue;
      }
      this.unplacedIds.delete(externalId);
      placed.push({ ...record, _position: at });
    }
    const receivedAt = this.nowIso();
    const opts = {
      manifest: this.manifest,
      definition: this.definition,
      receivedAt,
      origin: retained ? ('cached' as const) : ('live' as const),
      sourceRef: `mqtt://${session.host}:${session.port}/${topic}`,
      hash: (s: string) => this.context.hash.sha256Hex(s),
    };
    for (const [batch, mapping] of [
      [own, this.mapping],
      [placed, this.placed],
    ] as const) {
      if (!batch.length) continue;
      const mapped = mapRecords(batch, { ...opts, mapping });
      this.stats.records += mapped.total;
      this.stats.rejected += mapped.rejected.length;
      this.stats.filtered += mapped.filtered;
      for (const raw of mapped.observations) {
        // A position the operator configured, not one the device reported, says so.
        const o =
          mapping === this.placed
            ? { ...raw, quality: { ...raw.quality, flags: [...(raw.quality.flags ?? []), CONFIGURED_POSITION_FLAG] } }
            : raw;
        const key = o.externalId ?? o.id;
        this.ids.add(key);
        if (this.ids.size > MAX_IDS) this.ids.delete(this.ids.values().next().value!);
        session.pending.set(key, o);
      }
    }
    if (session.pending.size === 0) return;
    if (this.flushIntervalMs <= 0) this.flush(session);
    else if (session.flushTimer === undefined)
      session.flushTimer = this.timers.setTimeout(() => {
        session.flushTimer = undefined;
        this.flush(session);
      }, this.flushIntervalMs);
  }

  private flush(session: Session): void {
    if (session.closed || session.pending.size === 0) return;
    const batch = [...session.pending.values()];
    session.pending.clear();
    this.stats.observations += batch.length;
    this.lastObservation = this.nowIso();
    this.lastSuccess = this.lastObservation;
    session.emit(batch, { snapshot: false });
  }

  /** End the current connection's callbacks and close it; the session stays open for a reconnect. */
  private invalidate(session: Session): void {
    session.generation++;
    session.connAbort?.abort(); // an attempt still connecting stops; its listener goes with its signal
    session.connAbort = undefined;
    if (session.handle) this.droppedBefore += session.handle.dropped;
    const handle = session.handle;
    session.handle = undefined;
    this.connected = false;
    handle?.close();
  }

  private onDrop(session: Session, error: ProviderError): void {
    if (session.closed) return;
    this.invalidate(session);
    this.fail(error);
    this.context.logger.warn('broker connection lost', { code: error.code, message: error.message });
    session.emit([], { snapshot: false });
    this.scheduleReconnect(session, session.retryMs);
    session.retryMs = Math.min(RECONNECT_MAX_MS, session.retryMs * 2);
  }

  private scheduleReconnect(session: Session, ms: number): void {
    if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
    session.retryTimer = this.timers.setTimeout(() => {
      session.retryTimer = undefined;
      if (session.closed || !this.running) return;
      // An attempt already under way reached the broker at the address now set: keep it.
      if (this.connected && session.host === this.brokerHost()) return;
      this.stats.reconnects++;
      this.connect(session).catch(() => {
        if (session.closed) return;
        session.emit([], { snapshot: false });
        this.scheduleReconnect(session, session.retryMs);
        session.retryMs = Math.min(RECONNECT_MAX_MS, session.retryMs * 2);
      });
    }, ms);
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    for (const t of [session.flushTimer, session.retryTimer]) if (t !== undefined) this.timers.clearTimeout(t);
    if (session.handle) this.droppedBefore += session.handle.dropped;
    session.handle?.close();
    session.handle = undefined;
    session.connAbort?.abort();
    session.connAbort = undefined;
    this.connected = false;
    if (this.session === session) this.session = undefined;
  }

  /** Messages the runtime dropped for size, rate or QoS 2, over every connection so far. */
  get dropped(): number {
    return this.droppedBefore + (this.session?.handle?.dropped ?? 0);
  }

  private fail(err: ProviderError): ProviderError {
    this.lastError = err;
    this.lastErrorAt = this.nowIso();
    return err;
  }
  private nowIso(): IsoTimestamp {
    return new Date(this.context.clock.now()).toISOString();
  }

  /** What Source Health says beside the status when nothing is wrong with the connection. */
  notes(): string[] {
    const notes: string[] = [];
    const raw = this.settings[FIXED_POSITION_SETTING];
    if (typeof raw === 'string' && raw.trim() && !parseFixedPosition(raw))
      notes.push(`${FIXED_POSITION_SETTING} "${raw.trim().slice(0, 40)}" is not "lat, lon" and is ignored`);
    if (this.unplacedIds.size) {
      const names = [...this.unplacedIds].reverse().slice(0, MAX_UNPLACED_NAMED);
      const more = this.unplacedIds.size > names.length ? ` and ${this.unplacedIds.size - names.length} more` : '';
      const list = `${names.join(', ')}${more}`;
      notes.push(
        this.stationary
          ? `${this.unplacedIds.size} device(s) send no position — set ${FIXED_POSITION_SETTING} or add them to mqtt.positions: ${list}`
          : `${this.unplacedIds.size} device(s) have not reported a position yet (not shown until they do): ${list}`,
      );
    }
    if (this.dropped) notes.push(`${this.dropped} message(s) dropped by the connection's size or rate cap`);
    if (this.stats.rejected) notes.push(`${this.stats.rejected} record(s) rejected by the mapping`);
    if (this.stats.malformed) notes.push(`${this.stats.malformed} message(s) unreadable`);
    if (this.stats.offTopic) notes.push(`${this.stats.offTopic} message(s) on topics not subscribed to`);
    return notes;
  }

  async health(): Promise<ProviderHealth> {
    let status: ProviderStatus;
    let message: string | undefined;
    const key = this.credentialKey;
    const credentialState: CredentialState = !key
      ? 'not-required'
      : this.context && (await this.context.credentials.has(key))
        ? 'present'
        : 'missing';
    if (!this.running) status = 'DISABLED';
    else if (this.context && !this.context.mqtt) {
      status = 'ERROR';
      message = 'UNSUPPORTED: this build has no MQTT transport, so the source cannot connect';
    } else if (credentialState === 'missing') {
      status = 'AUTH_REQUIRED';
      message = `credential ${key} not configured`;
    } else if (this.connected) status = 'LIVE';
    else if (this.lastError) {
      const code = this.lastError.code;
      status =
        code === 'AUTH'
          ? 'AUTH_REQUIRED'
          : code === 'OFFLINE' || code === 'TIMEOUT' || code === 'NETWORK' || code === 'DNS'
            ? 'OFFLINE'
            : 'ERROR';
      message =
        code === 'HOST_NOT_ALLOWED'
          ? `${this.lastError.message} — name it in ${BROKER_HOST_SETTING}`
          : this.lastError.message;
    } else status = 'STARTING';
    const h: ProviderHealth = {
      providerId: this.manifest.id,
      status,
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState,
      objectCount: this.ids.size,
    };
    const notes = this.context ? this.notes() : [];
    if (message) h.message = message;
    else if (notes.length) h.message = notes.join('; ');
    if (this.lastAttempt) h.lastAttempt = this.lastAttempt;
    if (this.lastSuccess) h.lastSuccess = this.lastSuccess;
    if (this.lastObservation) h.lastObservation = this.lastObservation;
    if (this.lastError && this.lastErrorAt) h.lastError = this.lastError.toInfo(this.lastErrorAt);
    return h;
  }
}

// ── the connector ───────────────────────────────────────────────────────────

export function validateMqtt(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const spec = mqttSpecOf(d);
  if (!spec)
    return {
      ok: false,
      errors: ['mqtt is required: a broker source names its topics in an mqtt block'],
      warnings,
    };
  if (d.endpoint) errors.push('endpoint does not apply: an MQTT source is the broker named by brokerHost');
  if (d.websocket) errors.push('websocket does not apply to an MQTT source');
  if (d.file) errors.push('file does not apply to an MQTT source');
  if (d.pagination) warnings.push('pagination is ignored by this connector');
  if (d.response) warnings.push('response is ignored: an MQTT source reads mqtt.itemsPath');
  if (d.boundsQuery) errors.push('boundsQuery does not apply: a broker sends what it sends, not a view');
  if (spec.credential && !d.credentials?.[spec.credential.name])
    errors.push(`mqtt.credential names "${spec.credential.name}", which credentials does not declare`);
  if (spec.credential && spec.username === undefined)
    warnings.push('mqtt.credential without mqtt.username: MQTT 3.1.1 sends a password only with a username');
  if (spec.tls && spec.port === 1883) warnings.push('mqtt.tls on port 1883: brokers usually take TLS on 8883');
  for (const s of d.settings ?? [])
    if (MQTT_SETTINGS.some((own) => own.key === s.key))
      warnings.push(`settings.${s.key} is the connector's own setting; the definition's entry is ignored`);
  const levelsUsed = JSON.stringify(d.mapping).match(/_topic\[(-?\d+)\]/g) ?? [];
  if (levelsUsed.length && spec.topics.some((t) => t.topic.includes('#')))
    warnings.push('the mapping reads _topic[n] and a topic ends in #: levels past the filter may be missing');
  if (!d.mapping.position && !d.mapping.geometry && !spec.positions)
    warnings.push(
      `the mapping has no position and mqtt.positions is empty: every device needs the ${FIXED_POSITION_SETTING} setting`,
    );
  if (spec.preset === 'owntracks' && !spec.topics.every((t) => t.topic.startsWith('owntracks/')))
    warnings.push('the owntracks preset takes the device from owntracks/<user>/<device>; other topics use the topic');
  if (!d.mapping.observedAt) warnings.push('mapping.observedAt is unset: every observation carries the arrival time');
  if (errors.length === 0)
    try {
      compileMapping(topicMapping(d.mapping));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  return { ok: errors.length === 0, errors, warnings };
}

export const mqttConnector: Connector = {
  metadata: {
    id: MQTT_CONNECTOR_ID,
    name: 'MQTT',
    description:
      'Subscribe to topics on an MQTT broker on this computer or on one host you name; map each JSON message (rtl_433, OwnTracks and Meshtastic presets).',
    uses: ['mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateMqtt,
  createProvider: (d) => new MqttProvider(d),
};
