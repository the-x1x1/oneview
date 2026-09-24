import { readFileSync } from 'node:fs';
import path from 'node:path';
import { observationSchema, type JsonValue, type Observation } from '@worldview/world-model';
import { ProviderError, testing } from '@worldview/provider-sdk';
import { compileMapping, mapRecord, requestsPerPoll } from '@worldview/connector-sdk';
import type { SuiteCheck, SuiteFixtures, SuiteResult } from '../../../testing/suite.js';
import { parseMqttDefinition, type MqttConnectorDefinition } from '../contract.js';
import { BROKER_HOST_SETTING, LOOPBACK_BROKER, MqttProvider, mqttConnector, topicMapping } from '../mqtt.js';
import { sampleTopic } from '../topics.js';

/**
 * The shared connector suite's MQTT mode — the reference for amendment request M2 in
 * `docs/roadmap/phases/mqtt.md`, which asks `runConnectorSuite` to drive a definition with
 * an `mqtt` block through `testing.FixtureMqtt` the way it drives a `websocket` one through
 * `FixtureSockets`. The fixtures and the sidecar are the ones every connector uses
 * (`SuiteFixtures`, `<name>.test.json`); each body is one MQTT message or a recorded run of
 * them:
 *
 *   { "topic": "rtl_433/pi/events", "payload": { … } | "…", "retained": false }
 *   [ { "topic": …, "payload": … }, … ]
 *
 * and a body that is neither is delivered as the payload on the definition's first topic
 * (wildcards filled in, `sampleTopic`). The checks are the socket mode's (parse, empty,
 * malformed ignored with the source still LIVE, cancellation, reconnect) and the HTTP checks'
 * broker equivalents: _Timeout_ is a broker that cannot be reached (OFFLINE), _Auth failure_
 * a refused CONNACK (AUTH → AUTH_REQUIRED), _Oversized payload_ the runtime's size cap passed
 * on and its drops reported; plus the local-endpoint policy (the broker is 127.0.0.1 unless
 * the operator names a host) and a host without the transport (UNSUPPORTED). Missing fields,
 * attribution, data policy and rate policy are the shared suite's checks unchanged.
 */
export interface MqttSuiteMessage {
  topic: string;
  payload: string;
  retained: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function envelope(v: unknown): MqttSuiteMessage | undefined {
  if (!isObject(v) || typeof v['topic'] !== 'string' || !('payload' in v)) return undefined;
  const p = v['payload'];
  return {
    topic: v['topic'],
    payload: typeof p === 'string' ? p : JSON.stringify(p),
    retained: v['retained'] === true,
  };
}

/** The messages one fixture body stands for. */
export function messagesOf(body: string, defaultTopic: string): MqttSuiteMessage[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return [{ topic: defaultTopic, payload: body, retained: false }];
  }
  const one = envelope(doc);
  if (one) return [one];
  if (Array.isArray(doc) && doc.length > 0) {
    const all = doc.map(envelope);
    if (all.every((m): m is MqttSuiteMessage => m !== undefined)) return all;
  }
  return [{ topic: defaultTopic, payload: body, retained: false }];
}

const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runMqttSuite(doc: unknown, fixtures: SuiteFixtures): Promise<SuiteResult> {
  const checks: SuiteCheck[] = [];
  const check = (name: string, fn: () => Promise<string | undefined> | string | undefined) =>
    Promise.resolve()
      .then(fn)
      .then(
        (detail) => checks.push({ name, passed: detail === undefined, detail: detail ?? 'ok' }),
        (err) => checks.push({ name, passed: false, detail: err instanceof Error ? err.message : String(err) }),
      );

  const parsed = parseMqttDefinition(doc);
  const verdict = parsed.ok ? mqttConnector.validate(parsed.definition) : undefined;
  await check('Config validation', () =>
    !parsed.ok ? parsed.issues.join('; ') : verdict!.ok ? undefined : verdict!.errors.join('; '),
  );
  if (!parsed.ok || !verdict?.ok)
    return {
      definitionId: String((doc as { id?: unknown })?.id ?? '?'),
      connector: parsed.ok ? parsed.definition.connector : '?',
      checks,
      passed: false,
    };
  const definition: MqttConnectorDefinition = parsed.definition;
  const spec = definition.mqtt!;
  const defaultTopic = sampleTopic(spec.topics[0]!.topic);
  const settle = (spec.flushMs ?? 500) + 50;
  const secretRefs = Object.values(definition.credentials ?? {}).map((c) => c.secretRef);

  const make = async (opts: { mqtt?: testing.FixtureMqtt | null; settings?: Record<string, JsonValue> } = {}) => {
    const provider = new MqttProvider(definition);
    const broker = opts.mqtt === null ? undefined : (opts.mqtt ?? new testing.FixtureMqtt());
    const ctx = testing.createFixtureContext({
      providerId: definition.id,
      clock: new testing.VirtualClock(NOW),
      responder: () => ({ status: 404 }),
      credentials: secretRefs,
      ...(opts.settings ? { settings: opts.settings } : {}),
      ...(broker ? { mqtt: broker } : {}),
    });
    await provider.initialize(ctx);
    await provider.start();
    return { provider, ctx, broker };
  };
  const open = async (provider: MqttProvider, broker: testing.FixtureMqtt) => {
    const emitted: Observation[] = [];
    const abort = new AbortController();
    await provider.subscribe({ signal: abort.signal }, (obs) => emitted.push(...obs));
    const connection = broker.connections[broker.connections.length - 1];
    return { emitted, abort, connection };
  };
  const deliver = (c: testing.FixtureMqttConnection, bodies: string[]) => {
    for (const body of bodies)
      for (const m of messagesOf(body, defaultTopic)) c.simulateMessage(m.topic, m.payload, { retained: m.retained });
  };
  const codeOf = (err: unknown) => (err instanceof ProviderError ? err.code : String(err));
  const normal = Array.isArray(fixtures.normal) ? fixtures.normal : [fixtures.normal];
  let normalObservations: Observation[] = [];

  await check('Successful parse', async () => {
    const { provider, broker } = await make();
    const { emitted, abort, connection } = await open(provider, broker!);
    if (!connection) return 'no broker connection opened';
    connection.simulateOpen();
    deliver(connection, normal);
    await tick(settle);
    abort.abort();
    normalObservations = emitted;
    if (emitted.length !== fixtures.expectObservations)
      return `expected ${fixtures.expectObservations} observations, got ${emitted.length}`;
    for (const id of fixtures.expectIds ?? [])
      if (!emitted.some((o) => o.externalId === id)) return `missing observation ${id}`;
    for (const o of emitted) {
      const r = observationSchema.parse(o);
      if (!r.ok) return `observation ${o.id} invalid: ${r.issues[0]?.message}`;
      if (o.objectType !== definition.objectType) return `observation ${o.id} is a ${o.objectType}`;
    }
    return fixtures.verify?.(emitted);
  });
  await check('Empty response', async () => {
    const { provider, broker } = await make();
    const { emitted, abort, connection } = await open(provider, broker!);
    connection!.simulateOpen();
    deliver(connection!, [fixtures.empty]);
    await tick(settle);
    abort.abort();
    return emitted.length === 0 ? undefined : `empty message produced ${emitted.length} observations`;
  });
  await check('Malformed response', async () => {
    const { provider, broker } = await make();
    const { emitted, abort, connection } = await open(provider, broker!);
    connection!.simulateOpen();
    deliver(connection!, fixtures.malformed);
    await tick(settle);
    const h = await provider.health();
    abort.abort();
    if (emitted.length) return `malformed messages produced ${emitted.length} observations`;
    return h.status === 'LIVE' ? undefined : `health ${h.status} after malformed messages`;
  });
  await check('Timeout', async () => {
    // A broker that cannot be reached: the subscription fails OFFLINE and says so.
    const broker = new testing.FixtureMqtt();
    broker.refuse = new ProviderError('OFFLINE', `${LOOPBACK_BROKER}:1883: connect ECONNREFUSED`);
    const { provider } = await make({ mqtt: broker });
    try {
      await open(provider, broker);
      return 'subscribe resolved with the broker unreachable';
    } catch (err) {
      if (codeOf(err) !== 'OFFLINE') return `expected OFFLINE, got ${codeOf(err)}`;
    }
    const h = await provider.health();
    return h.status === 'OFFLINE' ? undefined : `health ${h.status} with the broker unreachable`;
  });
  await check('Auth failure', async () => {
    const broker = new testing.FixtureMqtt();
    broker.refuse = new ProviderError('AUTH', 'broker refused: bad user name or password', { retryable: false });
    const { provider } = await make({ mqtt: broker });
    try {
      await open(provider, broker);
      return 'subscribe resolved on a refused CONNACK';
    } catch (err) {
      if (codeOf(err) !== 'AUTH') return `expected AUTH, got ${codeOf(err)}`;
    }
    const h = await provider.health();
    return h.status === 'AUTH_REQUIRED' ? undefined : `health ${h.status} after a refused login`;
  });
  await check('Local endpoint', async () => {
    const m = new MqttProvider(definition).manifest;
    if (m.transport !== 'local-process' && m.transport !== 'hardware') return `transport ${m.transport}`;
    if (m.trustedHostSetting !== BROKER_HOST_SETTING) return 'the broker host is not the trusted-host setting';
    if (m.allowedHosts.some((h) => h !== '127.0.0.1' && h !== 'localhost'))
      return `allowedHosts names more than loopback: ${m.allowedHosts.join(', ')}`;
    const plain = await make();
    const a = await open(plain.provider, plain.broker!);
    a.abort.abort();
    if (a.connection?.options.host !== LOOPBACK_BROKER)
      return `with no broker named it connected to ${a.connection?.options.host}`;
    const named = await make({ settings: { [BROKER_HOST_SETTING]: '192.168.1.20' } });
    const b = await open(named.provider, named.broker!);
    b.abort.abort();
    if (b.connection?.options.host !== '192.168.1.20')
      return `with brokerHost set it connected to ${b.connection?.options.host}`;
    const subs = b.connection.options.subscriptions.map((s) => s.topic).join(',');
    return subs === spec.topics.map((t) => t.topic).join(',') ? undefined : `subscribed to ${subs}`;
  });
  await check('Oversized payload', async () => {
    // The runtime drops a payload over the cap before the provider sees it; the provider
    // passes the cap on and reports the drops.
    const { provider, broker } = await make();
    const { abort, connection } = await open(provider, broker!);
    const cap = connection!.options.maxPayloadBytes ?? 256 * 1024;
    if (cap > 1024 * 1024) return `payload cap ${cap} bytes is over 1 MiB`;
    connection!.simulateOpen();
    connection!.dropped = 2;
    const h = await provider.health();
    abort.abort();
    return h.message?.includes('2 message(s) dropped')
      ? undefined
      : `drops not reported: ${h.message ?? '(no message)'}`;
  });
  await check('No transport', async () => {
    const { provider } = await make({ mqtt: null });
    try {
      await provider.subscribe({ signal: new AbortController().signal }, () => undefined);
      return 'subscribe resolved on a host without MQTT';
    } catch (err) {
      if (codeOf(err) !== 'UNSUPPORTED') return `expected UNSUPPORTED, got ${codeOf(err)}`;
    }
    const h = await provider.health();
    return h.message?.includes('UNSUPPORTED') ? undefined : `health does not say UNSUPPORTED: ${h.message}`;
  });
  await check('Cancellation', async () => {
    const { provider, broker } = await make();
    const { abort, connection } = await open(provider, broker!);
    abort.abort();
    return connection?.closed ? undefined : 'connection not closed on abort';
  });
  await check('Reconnect', async () => {
    const { provider, broker } = await make();
    const { abort, connection } = await open(provider, broker!);
    connection!.simulateOpen();
    connection!.simulateClose('gone');
    const h = await provider.health();
    abort.abort();
    return h.status === 'OFFLINE' ? undefined : `expected OFFLINE after the broker closed, got ${h.status}`;
  });

  // The shared suite's last four checks, unchanged in substance.
  await check('Missing fields', () => {
    const mapping = compileMapping(topicMapping(definition.mapping));
    for (const [what, record] of [
      ['an empty record', {}],
      ['a record with only an id', { id: 'x', externalId: 'x', station_id: 'x', properties: { id: 'x' } }],
    ] as const) {
      let r: ReturnType<typeof mapRecord>;
      try {
        r = mapRecord(record, mapping);
      } catch (err) {
        return `${what} threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (r.ok) {
        if (r.record.position) return `${what} mapped to a positioned observation`;
        continue;
      }
      if (!('skipped' in r) && !r.reason) return `${what} was rejected without a reason`;
    }
    return undefined;
  });
  await check('Attribution', () => {
    const m = new MqttProvider(definition).manifest;
    if (!m.attribution.text) return 'no attribution text';
    return normalObservations.every((o) => o.provenance.attribution === m.attribution.text)
      ? undefined
      : 'observations do not carry the manifest attribution';
  });
  await check('Data policy', () => {
    const m = new MqttProvider(definition).manifest;
    const p = m.dataPolicy;
    if ((definition.review ?? 'user-configured') === 'user-configured') {
      if (p.commercialUseAllowed !== 'unknown')
        return 'a user-configured source must have commercialUseAllowed unknown';
      if (p.redistributionAllowed || p.offlinePackAllowed || p.exportAllowed)
        return 'a user-configured source must not redistribute, pack or export';
    }
    if (m.enabledByDefault && m.commercialReview === 'manual-review-required')
      return 'enabled by default without review';
    return undefined;
  });
  await check('Rate policy', () => {
    const r = new MqttProvider(definition).manifest.refreshPolicy;
    if (r.intervalMs < 5000) return `interval ${r.intervalMs} ms is below 5 s`;
    if (r.maxRequestsPerMinute * r.intervalMs < 60_000) return 'the request limit does not cover the poll cadence';
    const burst = requestsPerPoll(definition);
    if (r.maxRequestsPerMinute < burst) return `the request limit is below one poll's ${burst} request(s)`;
    return undefined;
  });

  return {
    definitionId: definition.id,
    connector: definition.connector,
    checks,
    passed: checks.every((c) => c.passed),
  };
}

// ── sidecars ────────────────────────────────────────────────────────────────

interface Expected {
  externalId: string;
  observedAt?: string;
  position?: { latitude?: number; longitude?: number };
  payload?: Record<string, unknown>;
  attribution?: string;
  flags?: string[];
}

const near = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) : a === b;

/** A sidecar's per-observation expectations, compared as `connector:test` compares them. */
export function verifyExpected(observations: Observation[], expected: Expected[]): string | undefined {
  for (const e of expected) {
    const o = observations.find((x) => x.externalId === e.externalId);
    if (!o) return `no observation with externalId ${e.externalId}`;
    const where = `observation ${e.externalId}`;
    if (e.observedAt !== undefined && o.observedAt !== e.observedAt)
      return `${where}: observedAt ${o.observedAt}, expected ${e.observedAt}`;
    if (e.attribution !== undefined && o.provenance.attribution !== e.attribution)
      return `${where}: attribution ${JSON.stringify(o.provenance.attribution)}`;
    if (e.position) {
      if (!o.position) return `${where}: no position`;
      if (e.position.latitude !== undefined && !near(o.position.latitude, e.position.latitude))
        return `${where}: latitude ${o.position.latitude}, expected ${e.position.latitude}`;
      if (e.position.longitude !== undefined && !near(o.position.longitude, e.position.longitude))
        return `${where}: longitude ${o.position.longitude}, expected ${e.position.longitude}`;
    }
    for (const [k, v] of Object.entries(e.payload ?? {}))
      if (!near(o.payload[k], v) && JSON.stringify(o.payload[k]) !== JSON.stringify(v))
        return `${where}: payload.${k} ${JSON.stringify(o.payload[k])}, expected ${JSON.stringify(v)}`;
    for (const f of e.flags ?? []) if (!(o.quality.flags ?? []).includes(f)) return `${where}: flag ${f} missing`;
  }
  return undefined;
}

/**
 * A definition's `<name>.test.json` read into `SuiteFixtures` — the sidecar format
 * `connector:test` reads (`oneview.connector-test.v1`: fixture paths from the repository
 * root or `{ "inline": "…" }`), with nothing added.
 */
export function loadSidecarFixtures(file: string, root: string): SuiteFixtures {
  const s = JSON.parse(readFileSync(file, 'utf8')) as {
    normal: unknown;
    empty: unknown;
    malformed: unknown[];
    expectObservations: number;
    expectIds?: string[];
    expect?: Expected[];
  };
  const read = (src: unknown): string => {
    if (isObject(src) && typeof src['inline'] === 'string') return src['inline'];
    if (typeof src !== 'string') throw new Error(`${file}: a fixture is a path or { "inline": "…" }`);
    const abs = path.resolve(root, src);
    if (path.relative(root, abs).startsWith('..')) throw new Error(`${file}: ${src} is outside the repository`);
    return readFileSync(abs, 'utf8');
  };
  const fixtures: SuiteFixtures = {
    normal: Array.isArray(s.normal) ? s.normal.map(read) : read(s.normal),
    empty: read(s.empty),
    malformed: s.malformed.map(read),
    expectObservations: s.expectObservations,
  };
  if (s.expectIds) fixtures.expectIds = s.expectIds;
  if (s.expect?.length) fixtures.verify = (obs) => verifyExpected(obs, s.expect!);
  return fixtures;
}
