import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProviderError,
  manifestSchema,
  testing,
  type ProviderMqtt,
  type ProviderMqttEvents,
  type ProviderMqttHandle,
  type ProviderMqttOptions,
} from '@worldview/provider-sdk';
import type { JsonValue, Observation } from '@worldview/world-model';
import { formatSuite } from '../../testing/suite.js';
import { defaultConnectorRegistry } from '../../registry.js';
import {
  BROKER_HOST_SETTING,
  FIXED_POSITION_SETTING,
  LOOPBACK_BROKER,
  CONFIGURED_POSITION_FLAG,
  MQTT_CONNECTOR_ID,
  MqttProvider,
  checkTopicFilter,
  createPreset,
  mqttConnector,
  parseFixedPosition,
  parseMqttDefinition,
  sampleTopic,
  topicMapping,
  topicMatches,
  unambiguousTime,
  type MqttConnectorDefinition,
  type MqttTimers,
} from './index.js';
import { loadSidecarFixtures, messagesOf, runMqttSuite } from './testing/suite.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const examplesDir = path.join(root, 'connectors', 'examples', 'mqtt', 'awaiting-amendments');
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(examplesDir, name), 'utf8')) as Record<string, unknown>;
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'connectors', 'mqtt', name), 'utf8');
const NOW = Date.parse('2026-09-23T20:00:00.000Z');

function definitionOf(doc: unknown): MqttConnectorDefinition {
  const r = parseMqttDefinition(doc);
  assert.ok(r.ok, r.ok ? '' : r.issues.join('; '));
  const v = mqttConnector.validate(r.definition);
  assert.ok(v.ok, v.errors.join('; '));
  return r.definition;
}

/** Timers a test fires by hand. */
class ManualTimers implements MqttTimers {
  queue: Array<{ fn: () => void; ms: number; id: number }> = [];
  private next = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.next;
    this.queue.push({ fn, ms, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }
  /** Run the earliest-scheduled timer; its delay. */
  fire(): number | undefined {
    const t = this.queue.shift();
    t?.fn();
    return t?.ms;
  }
}

async function start(
  doc: unknown,
  opts: {
    settings?: Record<string, JsonValue>;
    credentials?: string[];
    broker?: testing.FixtureMqtt | null;
    timers?: MqttTimers;
    flushIntervalMs?: number;
  } = {},
) {
  const definition = definitionOf(doc);
  const provider = new MqttProvider(definition, {
    flushIntervalMs: opts.flushIntervalMs ?? 0,
    ...(opts.timers ? { timers: opts.timers } : {}),
  });
  const broker = opts.broker === null ? undefined : (opts.broker ?? new testing.FixtureMqtt());
  const ctx = testing.createFixtureContext({
    providerId: definition.id,
    clock: new testing.VirtualClock(NOW),
    responder: () => ({ status: 404 }),
    credentials: opts.credentials ?? Object.values(definition.credentials ?? {}).map((c) => c.secretRef),
    ...(opts.settings ? { settings: opts.settings } : {}),
    ...(broker ? { mqtt: broker } : {}),
  });
  await provider.initialize(ctx);
  await provider.start();
  const emitted: Observation[] = [];
  const abort = new AbortController();
  const subscribe = () => provider.subscribe({ signal: abort.signal }, (obs) => emitted.push(...obs));
  return { provider, ctx, broker, emitted, abort, subscribe, definition };
}

const send = (c: testing.FixtureMqttConnection, body: string) => {
  for (const m of messagesOf(body, 'x')) c.simulateMessage(m.topic, m.payload, { retained: m.retained });
};

const generic = () => example('gps-trackers.json');
const sensors = () => example('rtl_433-sensors.json');

// ── the examples through the suite's MQTT mode ────────────────────────────────

const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'));

test('five examples wait for the amendments, one per preset and the generic tracker', () => {
  assert.deepEqual(exampleFiles.sort(), [
    'gps-trackers.json',
    'meshtastic-nodes.json',
    'owntracks-devices.json',
    'rtl_433-sensors.json',
    'rtl_433-weather-stations.json',
  ]);
});

for (const file of exampleFiles)
  test(`suite (MQTT mode): ${file}`, async () => {
    const doc = example(file);
    const fixtures = loadSidecarFixtures(path.join(examplesDir, file.replace(/\.json$/, '.test.json')), root);
    const r = await runMqttSuite(doc, fixtures);
    assert.ok(r.passed, '\n' + formatSuite(r));
    assert.equal(r.checks.length, 15);
    const d = definitionOf(doc);
    assert.equal(d.review, 'user-configured');
    assert.equal(d.enabled, false);
    assert.equal(d.dataPolicy, undefined, 'no data policy opened');
  });

test('the suite fails a definition whose fixture expectations are wrong', async () => {
  const fixtures = loadSidecarFixtures(path.join(examplesDir, 'gps-trackers.test.json'), root);
  const r = await runMqttSuite(generic(), { ...fixtures, expectObservations: 3 });
  assert.equal(r.passed, false);
  assert.match(formatSuite(r), /Successful parse\s+FAIL\s+expected 3 observations, got 2/);
});

// ── the frozen contracts today (amendment requests M1 and M2) ─────────────────

test('M1 tripwire: the frozen definition schema drops the mqtt block, so the registry refuses every MQTT definition', () => {
  const r = defaultConnectorRegistry.validate(generic());
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /mqtt is required .*amendment M1/);
  assert.equal((r.definition as MqttConnectorDefinition | undefined)?.mqtt, undefined);
  // …while the same document read as M1 asks carries it.
  assert.ok(definitionOf(generic()).mqtt);
});

test('the connector is registered under the id the directive names', () => {
  assert.equal(defaultConnectorRegistry.get(MQTT_CONNECTOR_ID), mqttConnector);
  assert.ok(defaultConnectorRegistry.ids().includes('mqtt'));
});

// ── topics ──────────────────────────────────────────────────────────────────

test('topic filters: + is one level, # the rest and only last', () => {
  for (const ok of ['a', 'a/b', 'a/+/c', 'a/#', '#', '+', '+/+', 'rtl_433/+/events', 'msh/+/2/json/#', '/a'])
    assert.equal(checkTopicFilter(ok), undefined, ok);
  assert.match(checkTopicFilter('a/#/b')!, /last/);
  assert.match(checkTopicFilter('a/b#')!, /whole level/);
  assert.match(checkTopicFilter('a/b+')!, /whole level/);
  assert.match(checkTopicFilter('')!, /empty/);
  assert.match(checkTopicFilter('a\u0000b')!, /control/);
  assert.match(checkTopicFilter('x'.repeat(300))!, /longer/);
});

test('topic matching follows MQTT 3.1.1 §4.7', () => {
  assert.ok(topicMatches('a/+/c', 'a/b/c'));
  assert.ok(!topicMatches('a/+/c', 'a/b/c/d'));
  assert.ok(!topicMatches('a/+', 'a'));
  assert.ok(topicMatches('a/#', 'a'), '# also matches the parent level');
  assert.ok(topicMatches('a/#', 'a/b/c'));
  assert.ok(topicMatches('#', 'anything/at/all'));
  assert.ok(!topicMatches('#', '$SYS/broker/uptime'), 'wildcards do not reach $ topics');
  assert.ok(!topicMatches('+/broker/uptime', '$SYS/broker/uptime'));
  assert.ok(topicMatches('$SYS/#', '$SYS/broker/uptime'));
  assert.ok(topicMatches('+/+', '/x'), 'an empty level is a level');
  assert.ok(!topicMatches('a/b', 'a/+'), 'a name never has wildcards');
  assert.equal(sampleTopic('rtl_433/+/events'), 'rtl_433/x/events');
  assert.equal(sampleTopic('msh/+/2/json/#'), 'msh/x/2/json');
  assert.equal(sampleTopic('#'), 'x');
});

// ── the definition block ────────────────────────────────────────────────────

test('the mqtt block is checked: topics, credential, positions, no other transport', () => {
  const doc = generic();
  const withMqtt = (mqtt: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseMqttDefinition({ ...doc, ...extra, mqtt: { ...(doc['mqtt'] as object), ...mqtt } });
  const issues = (r: ReturnType<typeof parseMqttDefinition>) => (r.ok ? '' : r.issues.join('; '));
  assert.match(issues(withMqtt({ topics: [{ topic: 'a/#/b' }] })), /topic "a\/#\/b": "#" must be/);
  assert.match(issues(withMqtt({ topics: [] })), /mqtt\.topics/);
  assert.match(issues(withMqtt({ topics: [{ topic: 'a' }, { topic: 'a' }] })), /listed twice/);
  assert.match(issues(withMqtt({ topics: [{ topic: 'a', qos: 2 }] })), /qos/);
  assert.match(issues(withMqtt({ credential: { name: 'nope' } })), /credentials does not declare/);
  assert.match(issues(withMqtt({ positions: { 'van-1': [91, 0] } })), /positions/);
  assert.match(issues(withMqtt({ port: 70000 })), /port/);
  assert.match(issues(withMqtt({ clientId: 'has space' })), /clientId/);
  assert.match(issues(withMqtt({ preset: 'zigbee2mqtt' })), /preset/);
  assert.match(
    issues(withMqtt({}, { endpoint: { url: 'https://example.org/feed' } })),
    /no endpoint, websocket or file/,
  );
  assert.ok(withMqtt({ positions: { 'Acurite-Tower:C:11520': [21.3, -157.8] } }).ok);
});

test('connector checks: a view query, a stray endpoint and a definition setting that shadows the broker host', () => {
  const d = definitionOf(generic());
  assert.match(mqttConnector.validate({ ...d, boundsQuery: true }).errors.join(), /boundsQuery/);
  const shadow = mqttConnector.validate({
    ...d,
    settings: [{ key: BROKER_HOST_SETTING, label: 'Broker', kind: 'number' }],
  });
  assert.ok(shadow.ok);
  assert.match(shadow.warnings.join(), /connector's own setting/);
  const m = new MqttProvider({ ...d, settings: [{ key: BROKER_HOST_SETTING, label: 'Broker', kind: 'number' }] })
    .manifest;
  assert.equal(m.settings!.find((s) => s.key === BROKER_HOST_SETTING)!.kind, 'string');
  const { position: _p, ...unplaced } = d.mapping;
  assert.match(mqttConnector.validate({ ...d, mapping: unplaced }).warnings.join(), /position\.fixed/);
});

test('the manifest is a local-process source: loopback hosts, the broker host as the trusted-host setting', () => {
  const m = new MqttProvider(definitionOf(sensors())).manifest;
  assert.equal(m.transport, 'local-process');
  assert.deepEqual(m.allowedHosts, ['127.0.0.1', 'localhost']);
  assert.equal(m.trustedHostSetting, BROKER_HOST_SETTING);
  assert.deepEqual(
    m.settings!.map((s) => s.key),
    [BROKER_HOST_SETTING, FIXED_POSITION_SETTING],
  );
  assert.equal(m.enabledByDefault, false);
  assert.equal(m.commercialReview, 'manual-review-required');
  assert.equal(m.capabilities.live, true);
  const parsed = manifestSchema.parse(m);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
});

// ── connecting ──────────────────────────────────────────────────────────────

test('connect options: loopback by default, the named host, port, TLS, username and the password by key', async () => {
  const doc = example('owntracks-devices.json');
  const broker = new testing.FixtureMqtt();
  broker.secrets['owntracks-devices.broker'] = 'hunter2';
  const s = await start(
    { ...doc, mqtt: { ...(doc['mqtt'] as object), tls: true, clientId: 'wv-test', keepAliveSeconds: 30 } },
    { broker, settings: { [BROKER_HOST_SETTING]: '  Broker.Home.Example ' } },
  );
  await s.subscribe();
  const c = broker.connections[0]!;
  assert.equal(c.options.host, 'broker.home.example');
  assert.equal(c.options.port, 8883);
  assert.equal(c.options.tls, true);
  assert.equal(c.options.username, 'worldview');
  assert.deepEqual(c.options.credential, { key: 'owntracks-devices.broker' });
  assert.equal(c.password, 'hunter2', 'the runtime resolves the password; the provider only names the key');
  assert.equal(c.options.clientId, 'wv-test');
  assert.equal(c.options.keepAliveSeconds, 30);
  assert.deepEqual(c.options.subscriptions, [{ topic: 'owntracks/+/+', qos: 1 }]);
  assert.ok(!JSON.stringify(c.options).includes('hunter2'));
  s.abort.abort();

  const plain = await start(generic());
  await plain.subscribe();
  assert.equal(plain.broker!.connections[0]!.options.host, LOOPBACK_BROKER);
  assert.equal(plain.broker!.connections[0]!.options.port, 1883);
  assert.equal(plain.broker!.connections[0]!.options.credential, undefined);
});

test('a missing broker password is AUTH_REQUIRED and nothing is dialled', async () => {
  const s = await start(example('owntracks-devices.json'), { credentials: [] });
  await assert.rejects(s.subscribe(), (e: unknown) => e instanceof ProviderError && e.code === 'AUTH');
  assert.equal(s.broker!.connections.length, 0);
  const h = await s.provider.health();
  assert.equal(h.status, 'AUTH_REQUIRED');
  assert.equal(h.credentialState, 'missing');
});

test('a host the runtime refuses is reported with the setting to name it in', async () => {
  const broker = new testing.FixtureMqtt();
  broker.refuse = new ProviderError('HOST_NOT_ALLOWED', '10.0.0.9 is not loopback or the host named for this source', {
    retryable: false,
  });
  const s = await start(generic(), { broker });
  await assert.rejects(s.subscribe(), /not loopback/);
  const h = await s.provider.health();
  assert.equal(h.status, 'ERROR');
  assert.match(h.message!, /name it in brokerHost/);
});

test('a dropped connection is reopened with a back-off from 2 s, reset once open', async () => {
  const timers = new ManualTimers();
  const s = await start(generic(), { timers });
  await s.subscribe();
  const first = s.broker!.connections[0]!;
  first.simulateOpen();
  assert.equal((await s.provider.health()).status, 'LIVE');
  first.simulateClose('broker restarting');
  const h = await s.provider.health();
  assert.equal(h.status, 'OFFLINE');
  assert.match(h.message!, /broker restarting/);
  assert.equal(timers.fire(), 2000);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.broker!.connections.length, 2);
  s.broker!.connections[1]!.simulateError(new ProviderError('TIMEOUT', 'stopped answering keep-alive pings'));
  assert.equal(s.broker!.connections[1]!.closed, true, 'a connection that errored is closed');
  assert.equal(timers.fire(), 4000);
  await new Promise((r) => setImmediate(r));
  const third = s.broker!.connections[2]!;
  third.simulateOpen();
  assert.equal((await s.provider.health()).status, 'LIVE');
  third.simulateClose();
  assert.equal(timers.fire(), 2000, 'the back-off starts again after a connection that opened');
  // Late callbacks from an old connection change nothing.
  first.simulateMessage('trackers/ghost/position', '{"lat":1,"lon":1}');
  assert.equal(s.emitted.length, 0);
  assert.equal(s.provider.stats.reconnects, 3);
  s.abort.abort();
});

test('a reconnect that fails keeps backing off up to a minute', async () => {
  const timers = new ManualTimers();
  const s = await start(generic(), { timers });
  await s.subscribe();
  s.broker!.connections[0]!.simulateClose();
  s.broker!.refuse = new ProviderError('OFFLINE', 'connect ECONNREFUSED');
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    delays.push(timers.fire()!);
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal((await s.provider.health()).status, 'OFFLINE');
  s.abort.abort();
  assert.equal(timers.queue.length, 0, 'closing the subscription cancels the pending reconnect');
});

test('a changed broker address reconnects at once to the new host', async () => {
  const timers = new ManualTimers();
  const s = await start(generic(), { timers });
  await s.subscribe();
  const first = s.broker!.connections[0]!;
  first.simulateOpen();
  s.ctx.settings.update({ [BROKER_HOST_SETTING]: '192.168.1.20' });
  assert.equal(first.closed, true);
  assert.equal(timers.fire(), 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.broker!.connections[1]!.options.host, '192.168.1.20');
  // A change to another setting does not reconnect.
  s.ctx.settings.update({ [BROKER_HOST_SETTING]: '192.168.1.20', [FIXED_POSITION_SETTING]: '21.3, -157.8' });
  assert.equal(s.broker!.connections[1]!.closed, false);
  s.abort.abort();
});

test('stop closes the connection, and a host without the transport says UNSUPPORTED', async () => {
  const s = await start(generic());
  await s.subscribe();
  await s.provider.stop();
  assert.equal(s.broker!.connections[0]!.closed, true);
  assert.equal((await s.provider.health()).status, 'DISABLED');
  const none = await start(generic(), { broker: null });
  await assert.rejects(none.subscribe(), (e: unknown) => e instanceof ProviderError && e.code === 'UNSUPPORTED');
  assert.match((await none.provider.health()).message!, /^UNSUPPORTED/);
});

// ── messages ────────────────────────────────────────────────────────────────

test('a retained message is taken once: the same payload again after a reconnect is not mapped', async () => {
  const timers = new ManualTimers();
  const s = await start(generic(), { timers });
  await s.subscribe();
  const payload = '{"lat":21.3,"lon":-157.8,"time":"2026-09-23T19:50:00Z"}';
  const c1 = s.broker!.connections[0]!;
  c1.simulateOpen();
  c1.simulateMessage('trackers/van-1/position', payload, { retained: true });
  assert.equal(s.emitted.length, 1);
  assert.equal(s.emitted[0]!.provenance.origin, 'cached', 'a retained value is the broker’s stored copy');
  c1.simulateClose();
  timers.fire();
  await new Promise((r) => setImmediate(r));
  const c2 = s.broker!.connections[1]!;
  c2.simulateOpen();
  c2.simulateMessage('trackers/van-1/position', payload, { retained: true });
  assert.equal(s.emitted.length, 1, 'the re-sent retained copy is skipped');
  assert.equal(s.provider.stats.retainedRepeats, 1);
  c2.simulateMessage('trackers/van-1/position', payload.replace('19:50', '19:55'), { retained: true });
  c2.simulateMessage('trackers/van-1/position', payload);
  c2.simulateMessage('trackers/van-1/position', payload);
  assert.equal(s.emitted.length, 4, 'a new retained value, and live messages every time');
  s.abort.abort();
});

test('messages are coalesced by id and emitted every flushMs', async () => {
  const timers = new ManualTimers();
  const s = await start(generic(), { timers, flushIntervalMs: 500 });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  c.simulateMessage('trackers/van-1/position', '{"lat":21.30,"lon":-157.8,"time":"2026-09-23T19:59:00Z"}');
  c.simulateMessage('trackers/van-1/position', '{"lat":21.31,"lon":-157.8,"time":"2026-09-23T19:59:10Z"}');
  c.simulateMessage('trackers/boat-2/position', '{"lat":21.29,"lon":-157.8,"time":"2026-09-23T19:59:10Z"}');
  assert.equal(s.emitted.length, 0);
  assert.equal(timers.queue.length, 1);
  assert.equal(timers.fire(), 500);
  assert.equal(s.emitted.length, 2);
  assert.equal(s.emitted.find((o) => o.externalId === 'van-1')!.position!.latitude, 21.31, 'the latest wins');
  s.abort.abort();
});

test('_topic and _topic[n] reach the mapping; a message on a topic not subscribed to is not mapped', async () => {
  const doc = generic();
  const s = await start({
    ...doc,
    mapping: { ...(doc['mapping'] as object), labels: { name: '_topic[1]', topic: '_topic', kind: '_topic[-1]' } },
  });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  c.simulateMessage('trackers/van-1/position', '{"lat":21.3,"lon":-157.8}');
  c.simulateMessage('fleet/van-1/position', '{"lat":21.3,"lon":-157.8}');
  assert.equal(s.emitted.length, 1);
  assert.deepEqual(
    [s.emitted[0]!.payload['name'], s.emitted[0]!.payload['topic'], s.emitted[0]!.payload['kind']],
    ['van-1', 'trackers/van-1/position', 'position'],
  );
  assert.equal(s.provider.stats.offTopic, 1);
  assert.match((await s.provider.health()).message!, /1 message\(s\) on topics not subscribed to/);
  assert.equal(topicMapping({ externalId: '_topic[2]' }).externalId, '_topicLevels[2]');
  assert.deepEqual(
    (topicMapping({ externalId: { path: 'x', fallback: ['_topic[0]', 'y'] } }).externalId as { fallback: string[] })
      .fallback,
    ['_topicLevels[0]', 'y'],
  );
  s.abort.abort();
});

test('a payload that is not JSON is a record { raw, topic } without a preset, and unreadable under one', async () => {
  const doc = generic();
  const s = await start({
    ...doc,
    mqtt: { topics: [{ topic: 'meters/+/power' }], positions: { 'meters/house/power': [21.3, -157.8] } },
    objectType: 'sensor',
    mapping: {
      externalId: 'topic',
      properties: { powerW: { path: 'raw', transform: 'number' }, text: 'raw' },
    },
  });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  c.simulateMessage('meters/house/power', '1432.5');
  c.simulateMessage('meters/house/power', 'ON');
  assert.equal(s.emitted.length, 2);
  assert.equal(s.emitted[0]!.payload['powerW'], 1432.5);
  assert.equal(s.emitted[1]!.payload['text'], 'ON');
  c.simulateMessage('meters/house/power', new Uint8Array([0xff, 0xfe, 0x00]));
  assert.equal(s.provider.stats.malformed, 1, 'bytes that are not UTF-8 are unreadable');

  const r = await start(sensors());
  await r.subscribe();
  r.broker!.connections[0]!.simulateOpen();
  r.broker!.connections[0]!.simulateMessage('rtl_433/pi/events', 'not json');
  assert.equal(r.provider.stats.malformed, 1);
  assert.equal(r.emitted.length, 0);
  s.abort.abort();
  r.abort.abort();
});

test('mqtt.filter and mqtt.itemsPath work on the message before the records', async () => {
  const doc = generic();
  const s = await start({
    ...doc,
    mqtt: {
      topics: [{ topic: 'gateway/+/batch' }],
      itemsPath: 'devices',
      filter: [
        { path: 'kind', equals: 'positions' },
        { path: '_topic[1]', in: ['north', 'south'] },
      ],
    },
    mapping: { ...(doc['mapping'] as object), externalId: 'id', labels: { gateway: '_topic[1]' } },
  });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  const body = (kind: string) =>
    JSON.stringify({
      kind,
      devices: [
        { id: 'a', lat: 21.3, lon: -157.8 },
        { id: 'b', lat: 21.4, lon: -157.9 },
      ],
    });
  c.simulateMessage('gateway/north/batch', body('positions'));
  c.simulateMessage('gateway/north/batch', body('status'));
  c.simulateMessage('gateway/east/batch', body('positions'));
  assert.deepEqual(
    s.emitted.map((o) => `${o.externalId}@${o.payload['gateway']}`),
    ['a@north', 'b@north'],
  );
  assert.equal(s.provider.stats.filtered, 2);
  c.simulateMessage('gateway/south/batch', '{"kind":"positions","devices":7}');
  assert.equal(s.provider.stats.malformed, 1);
  s.abort.abort();
});

test('a message with too many records is capped', async () => {
  const doc = generic();
  const s = await start({
    ...doc,
    mqtt: { topics: [{ topic: 'bulk' }] },
    mapping: { ...(doc['mapping'] as object), externalId: 'id' },
  });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  c.simulateMessage('bulk', JSON.stringify(Array.from({ length: 1200 }, (_, i) => ({ id: `d${i}`, lat: 1, lon: 1 }))));
  assert.equal(s.emitted.length, 1000);
  assert.equal(s.provider.stats.rejected, 200);
  s.abort.abort();
});

// ── positions ───────────────────────────────────────────────────────────────

test('positions: the payload first, then mqtt.positions, then position.fixed; none is named in Source Health', async () => {
  const doc = sensors();
  const table = { 'Acurite-Tower:C:11520': [10, 20] };
  const s = await start({ ...doc, mqtt: { ...(doc['mqtt'] as object), positions: table } });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  send(c, fixture('rtl_433-events.json'));
  assert.deepEqual(
    s.emitted.map((o) => o.externalId),
    ['Acurite-Tower:C:11520'],
  );
  assert.deepEqual([s.emitted[0]!.position!.latitude, s.emitted[0]!.position!.longitude], [10, 20]);
  let h = await s.provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(
    h.message!,
    /1 device\(s\) send no position — set position\.fixed or add them to mqtt\.positions: LaCrosse-TX141THBv2:0:150/,
  );
  // The operator places the rest of this source's devices with the setting.
  s.ctx.settings.update({ [FIXED_POSITION_SETTING]: '21.5, -158.0' });
  send(c, fixture('rtl_433-events.json'));
  const lacrosse = s.emitted.filter((o) => o.externalId === 'LaCrosse-TX141THBv2:0:150');
  assert.equal(lacrosse.length, 1);
  assert.deepEqual([lacrosse[0]!.position!.latitude, lacrosse[0]!.position!.longitude], [21.5, -158]);
  const tower = s.emitted.filter((o) => o.externalId === 'Acurite-Tower:C:11520');
  assert.deepEqual(
    [tower[1]!.position!.latitude, tower[1]!.position!.longitude],
    [10, 20],
    'the table beats the setting',
  );
  h = await s.provider.health();
  assert.ok(!h.message?.includes('send no position'), 'placed devices are no longer listed');
  s.ctx.settings.update({ [FIXED_POSITION_SETTING]: 'the shed' });
  assert.match((await s.provider.health()).message!, /position\.fixed "the shed" is not "lat, lon"/);
  s.abort.abort();

  // A payload position wins over both.
  const g = generic();
  const t = await start(
    { ...g, mqtt: { ...(g['mqtt'] as object), positions: { 'van-1': [0, 0], 'van-3': [5, 6] } } },
    { settings: { [FIXED_POSITION_SETTING]: '1, 1' } },
  );
  await t.subscribe();
  const c2 = t.broker!.connections[0]!;
  c2.simulateOpen();
  c2.simulateMessage('trackers/van-1/position', '{"lat":21.3,"lon":-157.8}');
  // A device that reports its position but has no fix yet is never put at the fixed point…
  c2.simulateMessage('trackers/van-2/position', '{"speed_kmh":3}');
  // …while the definition's own table still places a device the operator listed.
  c2.simulateMessage('trackers/van-3/position', '{"speed_kmh":0}');
  // A device id that is an Object.prototype key is not in the table.
  c2.simulateMessage('trackers/constructor/position', '{"speed_kmh":0}');
  assert.deepEqual(
    t.emitted.map((o) => [o.externalId, o.position!.latitude, o.quality.flags ?? []]),
    [
      ['van-1', 21.3, ['fetch-time']],
      ['van-3', 5, ['fetch-time', CONFIGURED_POSITION_FLAG]],
    ],
  );
  const note = (await t.provider.health()).message!;
  assert.match(note, /2 device\(s\) have not reported a position yet \(not shown until they do\): constructor, van-2/);
  assert.ok(!note.includes('position.fixed'), 'a moving source is not told to pin its devices');
  t.abort.abort();
});

test('positions from the table or position.fixed are flagged configured-position', async () => {
  const s = await start(sensors(), { settings: { [FIXED_POSITION_SETTING]: '21.5, -158.0' } });
  await s.subscribe();
  s.broker!.connections[0]!.simulateOpen();
  send(s.broker!.connections[0]!, fixture('rtl_433-events.json'));
  assert.equal(s.emitted.length, 2);
  for (const o of s.emitted) assert.ok(o.quality.flags?.includes(CONFIGURED_POSITION_FLAG), o.externalId);
  s.abort.abort();
});

test('position.fixed takes "lat, lon" in degrees', () => {
  assert.deepEqual(parseFixedPosition('21.3069, -157.8583'), { lat: 21.3069, lon: -157.8583 });
  assert.deepEqual(parseFixedPosition(' 21.3 -157.8 '), { lat: 21.3, lon: -157.8 });
  for (const bad of ['', '21.3', '91, 0', '0, 181', 'a, b', '1, 2, 3', 7])
    assert.equal(parseFixedPosition(bad), undefined);
});

// ── presets ─────────────────────────────────────────────────────────────────

test('unambiguous times only: Unix seconds, milliseconds, and a zone; never a zone-less local time', () => {
  assert.equal(unambiguousTime(1790193570), '2026-09-23T19:59:30.000Z');
  assert.equal(unambiguousTime('1790193570.25'), '2026-09-23T19:59:30.250Z');
  assert.equal(unambiguousTime(1790193570123), '2026-09-23T19:59:30.123Z');
  assert.equal(unambiguousTime('2026-09-23T09:59:30-1000'), '2026-09-23T19:59:30.000Z');
  assert.equal(unambiguousTime('2026-09-23 19:59:30Z'), '2026-09-23T19:59:30.000Z');
  assert.equal(unambiguousTime('2026-09-23T09:59:30.5-10:00'), '2026-09-23T19:59:30.500Z');
  assert.equal(unambiguousTime('2026-09-23 09:59:30'), undefined);
  assert.equal(unambiguousTime(42), undefined);
  assert.equal(unambiguousTime(''), undefined);
  assert.equal(unambiguousTime(null), undefined);
});

test('rtl_433: model:channel:id, the class, one unit per reading, merged per device', () => {
  const p = createPreset('rtl_433');
  const read = (body: unknown) => {
    const r = p.read(body, 'rtl_433/pi/events', ['rtl_433', 'pi', 'events']);
    assert.ok('records' in r, JSON.stringify(r));
    return r.records[0]!;
  };
  const a = read({ model: 'Acurite-5n1', id: 1234, channel: 'A', temperature_F: 50, humidity: 60, time: '1790193570' });
  assert.equal(a['_device'], 'Acurite-5n1:A:1234');
  assert.equal(a['_class'], 'sensor');
  assert.equal(a['_temperature_C'], 10);
  assert.equal(a['_time'], '2026-09-23T19:59:30.000Z');
  const b = read({
    model: 'Acurite-5n1',
    id: 1234,
    channel: 'A',
    wind_avg_mi_h: 10,
    rain_in: 1,
    time: '2026-09-23 10:00:00',
  });
  assert.equal(b['_class'], 'weather-station', 'wind or rain makes a station');
  assert.equal(b['_temperature_C'], 10, 'the reading from the other message type is kept');
  assert.equal(b['_wind_avg_m_s'], 4.47);
  assert.equal(b['_rain_mm'], 25.4);
  assert.equal(b['_time'], undefined, 'an older message’s time does not date this one');
  assert.equal(read({ model: 'Oregon-THGR810', id: 5, pressure_kPa: 101.3 })['_pressure_hPa'], 1013);
  assert.equal(read({ model: 'Oregon-THGR810', id: 5, pressure_kPa: 101.3 })['_device'], 'Oregon-THGR810:5');
  assert.equal(read({ model: 'Honeywell-Security', id: 9, state: 'open' })['_class'], 'other');
  assert.equal(read({ model: 'Solight-TE44', temperature_C: 3 })['_device'], 'Solight-TE44');
  assert.deepEqual(p.read({ id: 1 }, 't', ['t']), { skipped: 'not an rtl_433 event (no model)' });
  assert.ok('skipped' in p.read([1, 2], 't', ['t']));
});

test('OwnTracks: location messages only, the device from the topic, vel in m/s', () => {
  const p = createPreset('owntracks');
  const levels = ['owntracks', 'alex', 'phone'];
  const r = p.read({ _type: 'location', lat: 1, lon: 2, tst: 1790193570, vel: 36 }, 'owntracks/alex/phone', levels);
  assert.ok('records' in r);
  assert.equal(r.records[0]!['_device'], 'alex/phone');
  assert.equal(r.records[0]!['_time'], '2026-09-23T19:59:30.000Z');
  assert.equal(r.records[0]!['_speed_m_s'], 10);
  for (const type of ['transition', 'waypoint', 'card', 'lwt', 'encrypted'])
    assert.ok('skipped' in p.read({ _type: type }, 'owntracks/alex/phone', levels), type);
  const other = p.read({ _type: 'location', lat: 1, lon: 2 }, 'phones/alex', ['phones', 'alex']);
  assert.ok('records' in other && other.records[0]!['_device'] === 'phones/alex');
});

test('Meshtastic: state merged per node, 1e-7 degrees, no fix is no position, text is never read', () => {
  const p = createPreset('meshtastic');
  const read = (body: unknown) => p.read(body, 'msh/US/2/json/LongFast/!1', []);
  const records = (body: unknown) => {
    const r = read(body);
    assert.ok('records' in r, JSON.stringify(r));
    return r.records[0]!;
  };
  records({ from: 16, type: 'nodeinfo', payload: { longname: 'Ridge', shortname: 'RDG' }, timestamp: 1790193480 });
  const pos = records({ from: 16, type: 'position', payload: { latitude_i: 213069000, longitude_i: -1578583000 } });
  assert.equal(pos['_device'], '!00000010');
  assert.deepEqual([pos['_lat'], pos['_lon'], pos['_name']], [21.3069, -157.8583, 'Ridge']);
  const nofix = records({
    from: 16,
    type: 'position',
    payload: { latitude_i: 0, longitude_i: 0 },
    timestamp: 1790193500,
  });
  assert.equal(nofix['_lat'], 21.3069, 'a 0/0 report keeps the last fix');
  const t = records({
    from: 16,
    type: 'telemetry',
    payload: { battery_level: 50, temperature: 21.5 },
    timestamp: 1790193570,
  });
  assert.deepEqual(
    [t['_battery'], t['_temperature_C'], t['_lat'], t['_time']],
    [50, 21.5, 21.3069, '2026-09-23T19:59:30.000Z'],
  );
  const text = read({ from: 16, type: 'text', payload: { text: 'meet at the harbour' } });
  assert.deepEqual(text, { skipped: 'Meshtastic text (not read)' });
  assert.ok(!JSON.stringify(records({ from: 16, type: 'telemetry', payload: {} })).includes('harbour'));
  assert.ok('skipped' in read({ type: 'position' }));
  assert.ok('skipped' in read({ from: -1, type: 'position' }));
});

test('Meshtastic through the provider: a text message on the subscribed topic reaches no observation', async () => {
  const s = await start(example('meshtastic-nodes.json'));
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  send(c, fixture('meshtastic-packets.json'));
  assert.equal(s.emitted.length, 3, 'nodeinfo is not placed yet; position, telemetry and the second node are');
  assert.ok(!JSON.stringify(s.emitted).includes('reef'), 'the text packet’s words appear nowhere');
  assert.equal(s.provider.stats.skipped, 1);
  s.abort.abort();
});

// ── review fixes: attempts overtaken, the real client's ordering, rewrites ────

/** A broker whose connects the test settles by hand, and that can open before resolving as the runtime does. */
class DeferredMqtt implements ProviderMqtt {
  attempts: Array<{
    options: ProviderMqttOptions;
    events: ProviderMqttEvents;
    resolve: () => void;
    reject: (e: ProviderError) => void;
    closed: boolean;
  }> = [];
  connect(options: ProviderMqttOptions, events: ProviderMqttEvents): Promise<ProviderMqttHandle> {
    return new Promise((resolve, reject) => {
      const a = {
        options,
        events,
        closed: false,
        resolve: () => resolve({ close: () => void (a.closed = true), dropped: 0 }),
        reject,
      };
      this.attempts.push(a);
    });
  }
}
const settle = () => new Promise((r) => setImmediate(r));

async function startDeferred(doc: unknown, timers = new ManualTimers(), credentials: string[] = []) {
  const definition = definitionOf(doc);
  const provider = new MqttProvider(definition, { flushIntervalMs: 0, timers });
  const broker = new DeferredMqtt();
  // createFixtureContext takes only a FixtureMqtt; this broker is another ProviderMqtt.
  const ctx = {
    ...testing.createFixtureContext({
      providerId: definition.id,
      clock: new testing.VirtualClock(NOW),
      responder: () => ({ status: 404 }),
      credentials,
    }),
    mqtt: broker,
  };
  await provider.initialize(ctx);
  await provider.start();
  const emitted: Observation[] = [];
  const abort = new AbortController();
  return { provider, ctx, broker, timers, emitted, abort, definition };
}

test('an attempt overtaken by a changed broker address neither reconnects nor reports when it fails', async () => {
  const s = await startDeferred(generic());
  const first = s.provider.subscribe({ signal: s.abort.signal }, (o) => s.emitted.push(...o));
  await settle();
  const a0 = s.broker.attempts[0]!;
  // The operator corrects the address while the first attempt still waits for a CONNACK.
  s.ctx.settings.update({ [BROKER_HOST_SETTING]: '192.168.1.20' });
  assert.equal(a0.options.signal!.aborted, true, 'the overtaken attempt is told to stop');
  assert.equal(s.timers.fire(), 0);
  await settle();
  const a1 = s.broker.attempts[1]!;
  assert.equal(a1.options.host, '192.168.1.20');
  a1.resolve();
  await settle();
  a1.events.onOpen!();
  // The old attempt now fails: nothing may follow from it.
  a0.reject(new ProviderError('TIMEOUT', 'no CONNACK from 127.0.0.1:1883 within 8000 ms'));
  await first; // subscribe resolves: the newer attempt is the source's connection
  await settle();
  assert.equal(s.broker.attempts.length, 2, 'no reconnect scheduled by the overtaken attempt');
  assert.equal(s.timers.queue.length, 0);
  const h = await s.provider.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(h.lastError, undefined, 'the overtaken failure is not the source’s error');
  assert.equal(a1.closed, false, 'the live connection stays open');
  s.abort.abort();
  assert.equal(a1.closed, true);
});

test('every connection has its own signal; a superseded one is aborted', async () => {
  const timers = new ManualTimers();
  const s = await start(generic(), { timers });
  await s.subscribe();
  const signals = [s.broker!.connections[0]!.options.signal!];
  s.broker!.connections[0]!.simulateClose();
  assert.equal(signals[0]!.aborted, true);
  timers.fire();
  await new Promise((r) => setImmediate(r));
  signals.push(s.broker!.connections[1]!.options.signal!);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, false);
  s.abort.abort();
  assert.equal(signals[1]!.aborted, true);
});

test('cancelling while the first connection is being made is CANCELLED, not an error of the source', async () => {
  const s = await startDeferred(generic());
  const sub = s.provider.subscribe({ signal: s.abort.signal }, () => undefined);
  await settle();
  s.abort.abort();
  s.broker.attempts[0]!.reject(new ProviderError('OFFLINE', '127.0.0.1:1883 closed the connection before it was open'));
  await assert.rejects(sub, (e: unknown) => e instanceof ProviderError && e.code === 'CANCELLED');
  assert.equal((await s.provider.health()).lastError, undefined);
});

test('the runtime’s order: onOpen and a retained message before connect resolves', async () => {
  // mqtt-client.ts resolves on SUBACK and calls onOpen at once; a retained message in the same
  // TCP chunk is delivered before the provider's await resumes.
  const early: ProviderMqtt = {
    async connect(_options, events) {
      events.onOpen?.();
      events.onMessage(
        'trackers/van-1/position',
        new TextEncoder().encode('{"lat":21.3,"lon":-157.8,"time":"2026-09-23T19:50:00Z"}'),
        { retained: true, qos: 0 },
      );
      return { close: () => undefined, dropped: 0 };
    },
  };
  const definition = definitionOf(generic());
  const provider = new MqttProvider(definition, { flushIntervalMs: 0 });
  // createFixtureContext takes only a FixtureMqtt; this broker is another ProviderMqtt.
  const ctx = {
    ...testing.createFixtureContext({
      providerId: definition.id,
      clock: new testing.VirtualClock(NOW),
      responder: () => ({ status: 404 }),
    }),
    mqtt: early,
  };
  await provider.initialize(ctx);
  await provider.start();
  const emitted: Observation[] = [];
  const abort = new AbortController();
  await provider.subscribe({ signal: abort.signal }, (o) => emitted.push(...o));
  assert.deepEqual(
    emitted.map((o) => o.externalId),
    ['van-1'],
  );
  assert.equal((await provider.health()).status, 'LIVE');
  abort.abort();
});

test('a retained copy of what was last seen live is not mapped again', async () => {
  const timers = new ManualTimers();
  const s = await start(example('owntracks-devices.json'), { timers });
  await s.subscribe();
  const loc = '{"_type":"location","lat":21.3,"lon":-157.8,"tst":1790193500}';
  s.broker!.connections[0]!.simulateOpen();
  s.broker!.connections[0]!.simulateMessage('owntracks/alex/phone', loc); // live, published with retain
  s.broker!.connections[0]!.simulateClose();
  timers.fire();
  await new Promise((r) => setImmediate(r));
  s.broker!.connections[1]!.simulateOpen();
  s.broker!.connections[1]!.simulateMessage('owntracks/alex/phone', loc, { retained: true });
  assert.deepEqual(
    s.emitted.map((o) => o.provenance.origin),
    ['live'],
  );
  s.abort.abort();
});

test('_topic[n] is read everywhere a path can be, in every spelling', async () => {
  const doc = generic();
  const s = await start({
    ...doc,
    mqtt: { topics: [{ topic: 'grid/+/+/+/+' }] },
    mapping: {
      externalId: '$._topic[1]',
      position: {
        lat: { path: '_topic[2]', transform: 'number' },
        lon: { path: '["_topic"][3]', transform: 'number' },
      },
      motion: { headingDegrees: { path: '$["_topic"][4]', transform: 'number' } },
      filter: [{ path: '_topic[-1]', notEquals: '0' }],
    },
  });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  c.simulateMessage('grid/cell-7/21.3/-157.8/90', '{}');
  c.simulateMessage('grid/cell-8/21.3/-157.8/0', '{}');
  assert.deepEqual(
    s.emitted.map((o) => [o.externalId, o.position!.latitude, o.position!.longitude, o.payload['headingDegrees']]),
    [['cell-7', 21.3, -157.8, 90]],
  );
  assert.equal(s.provider.stats.filtered, 1);
  s.abort.abort();
});

test('an array message is filtered with _items and the topic', async () => {
  const doc = generic();
  const s = await start({
    ...doc,
    mqtt: {
      topics: [{ topic: 'fleet/+' }],
      filter: [
        { path: '_topic[1]', equals: 'north' },
        { path: '_items[0].ok', equals: true },
      ],
    },
    mapping: { ...(doc['mapping'] as object), externalId: 'id' },
  });
  await s.subscribe();
  const c = s.broker!.connections[0]!;
  c.simulateOpen();
  c.simulateMessage('fleet/north', '[{"ok":true,"id":"a","lat":1,"lon":1}]');
  c.simulateMessage('fleet/south', '[{"ok":true,"id":"b","lat":1,"lon":1}]');
  c.simulateMessage('fleet/north', '[{"ok":false,"id":"c","lat":1,"lon":1}]');
  assert.deepEqual(
    s.emitted.map((o) => o.externalId),
    ['a'],
  );
  s.abort.abort();
});

test('rtl_433 tyre-pressure sensors are class other, whatever they report', () => {
  const p = createPreset('rtl_433');
  for (const body of [
    { model: 'Toyota', type: 'TPMS', id: 'fbad1234', pressure_PSI: 32.5, temperature_C: 21 },
    { model: 'Schrader-EG53MA4', type: 'TPMS', id: 'a1b2c3', pressure_kPa: 230, temperature_C: 19 },
    { model: 'Citroen-TPMS', id: 99, pressure_kPa: 240 },
  ]) {
    const r = p.read(body, 'rtl_433/pi/events', []);
    assert.ok('records' in r && r.records[0]!['_class'] === 'other', body.model);
  }
});

test('Meshtastic: a new fix without a time is not dated by the previous fix', () => {
  const p = createPreset('meshtastic');
  const read = (body: unknown) => {
    const r = p.read(body, 'msh/US/2/json/LongFast/!1', []);
    assert.ok('records' in r);
    return r.records[0]!;
  };
  read({ from: 7, type: 'position', payload: { latitude_i: 10e7, longitude_i: 20e7, time: 1790193000 } });
  const b = read({
    from: 7,
    type: 'position',
    payload: { latitude_i: 11e7, longitude_i: 21e7 },
    timestamp: 1790193570,
  });
  assert.deepEqual([b['_lat'], b['_time']], [11, '2026-09-23T19:59:30.000Z']);
  const c = read({ from: 7, type: 'position', payload: { latitude_i: 12e7, longitude_i: 22e7 } });
  assert.equal(c['_time'], undefined);
});

test('a date that does not exist is not a time', () => {
  assert.equal(unambiguousTime('2026-02-30T09:59:30Z'), undefined);
  assert.equal(unambiguousTime('2026-13-01T00:00:00Z'), undefined);
  assert.equal(unambiguousTime('2028-02-29T00:00:00Z'), '2028-02-29T00:00:00.000Z');
});

test('a broker address changed while the first attempt awaits its credential: one connection, the right state', async () => {
  const doc = example('owntracks-devices.json');
  const kept = await startDeferred(doc, new ManualTimers(), ['owntracks-devices.broker']);
  const sub = kept.provider.subscribe({ signal: kept.abort.signal }, () => undefined);
  kept.ctx.settings.update({ [BROKER_HOST_SETTING]: '192.168.1.20' }); // during the credential check
  await settle();
  const a = kept.broker.attempts[0]!;
  assert.equal(a.options.host, '192.168.1.20', 'the attempt reads the address after the check');
  a.resolve();
  await sub;
  a.events.onOpen!();
  kept.timers.fire(); // the reconnect onSettings asked for finds the right broker already open
  await settle();
  assert.equal(kept.broker.attempts.length, 1);
  assert.equal(a.closed, false);
  assert.equal((await kept.provider.health()).status, 'LIVE');
  kept.abort.abort();

  // The same, but the reconnect runs before the first attempt opens and then fails.
  const raced = await startDeferred(doc, new ManualTimers(), ['owntracks-devices.broker']);
  const sub2 = raced.provider.subscribe({ signal: raced.abort.signal }, () => undefined);
  raced.ctx.settings.update({ [BROKER_HOST_SETTING]: '192.168.1.20' });
  await settle();
  raced.timers.fire();
  await settle();
  const [first, second] = raced.broker.attempts;
  assert.equal(first!.options.signal!.aborted, true);
  second!.reject(new ProviderError('OFFLINE', '192.168.1.20:1883: connect ECONNREFUSED'));
  await settle();
  first!.resolve(); // too late: overtaken, closed at once
  await sub2;
  await settle();
  assert.equal(first!.closed, true);
  const h = await raced.provider.health();
  assert.equal(h.status, 'OFFLINE', 'not LIVE with no connection open');
  assert.equal(raced.timers.queue.length, 1, 'the back-off carries on');
  raced.abort.abort();
});
