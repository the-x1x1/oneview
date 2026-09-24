import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, manifestSchema, testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import type { JsonValue, Observation } from '@worldview/world-model';
import { defaultConnectorRegistry, formatSuite, runConnectorSuite, type SuiteFixtures } from '../../index.js';
import type { Timers } from '../websocket-json.js';
import {
  TRACCAR_DEVICES_REFRESH_MS,
  TRACCAR_DEVICES_RETRY_MS,
  TraccarProvider,
  traccarBase,
  traccarManifest,
  validateTraccar,
} from './traccar.js';
import { TraccarDirectory, readDevice, readEvent, readSocketMessage } from './session.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const fixture = (name: string) => read(`fixtures/connectors/traccar/${name}`);
const example = (name: string): Record<string, unknown> =>
  JSON.parse(read(`connectors/examples/traccar/${name}`)) as Record<string, unknown>;
const NOW = Date.parse('2026-09-23T20:00:00.000Z');

const live = () => example('traccar-demo-live.json');
const rest = () => example('traccar-demo-rest.json');
const local = () => example('traccar-local.json');

const byId = (obs: Observation[]) => new Map(obs.map((o) => [o.externalId!, o]));
const ok = (body: string): testing.FixtureResponse => ({ status: 200, body });
const pathOf = (req: ProviderHttpRequest) => new URL(req.url).pathname;
/** `/api/devices` and `/api/positions` answered separately, as a Traccar server does. */
const server =
  (
    devices: () => testing.FixtureResponse = () => ok(fixture('devices.json')),
    positions: () => testing.FixtureResponse = () => ok(fixture('positions.json')),
  ): testing.FixtureResponder =>
  (req) =>
    pathOf(req).endsWith('/api/devices')
      ? devices()
      : pathOf(req).endsWith('/api/positions')
        ? positions()
        : { status: 404 };

/** Timers the test runs by hand. */
class ManualTimers implements Timers {
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  delays(): number[] {
    return [...this.pending.values()].map((t) => t.ms);
  }
  runAll(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, t] of due) t.fn();
  }
}

async function start(
  doc: Record<string, unknown>,
  responder: testing.FixtureResponder,
  opts: { credentials?: string[]; settings?: Record<string, JsonValue>; timers?: Timers } = {},
) {
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  const provider = new TraccarProvider(v.definition, {
    flushIntervalMs: 0,
    ...(opts.timers ? { timers: opts.timers } : {}),
  });
  const clock = new testing.VirtualClock(NOW);
  const sockets = new testing.FixtureSockets();
  const ctx = testing.createFixtureContext({
    providerId: String(doc['id']),
    clock,
    responder,
    sockets,
    credentials: opts.credentials ?? Object.values(v.definition.credentials ?? {}).map((c) => c.secretRef),
    ...(opts.settings ? { settings: opts.settings } : {}),
  });
  await provider.initialize(ctx);
  await provider.start();
  const poll = (signal = new AbortController().signal) => provider.query({ signal, background: true });
  return { provider, ctx, clock, sockets, poll };
}

// ── the shared suite, on every example ─────────────────────────────────────

const restFixtures = (): SuiteFixtures => ({
  normal: fixture('positions.json'),
  empty: fixture('positions-empty.json'),
  malformed: ['not json', '{"positions":[]}', '[{"id":1,"latitude":21.3,"longitude":-157.8}]'],
  expectObservations: 4,
  expectIds: ['1', '2', '3', '7'],
  verify: (obs) => {
    const one = byId(obs).get('1');
    if (one?.payload['speedMps'] !== 11.112) return `speedMps ${String(one?.payload['speedMps'])}, expected 11.112`;
    return obs.every((o) => o.objectType === 'transit-vehicle') ? undefined : 'not transit-vehicle';
  },
});

for (const name of ['traccar-demo-rest.json', 'traccar-local.json']) {
  test(`suite: ${name}`, async () => {
    const r = await runConnectorSuite(example(name), restFixtures());
    assert.ok(r.passed, formatSuite(r));
  });
}

test('suite: traccar-demo-live.json (the socket)', async () => {
  const r = await runConnectorSuite(live(), {
    normal: [fixture('socket-devices.json'), fixture('socket-positions.json'), fixture('socket-events.json'), '{}'],
    empty: '{"positions":[]}',
    malformed: ['not json', '{"positions":"x"}', '[1,2]', '{"status":"ok"}'],
    expectObservations: 3,
    expectIds: ['1', '2', '7'],
    verify: (obs) => {
      const one = byId(obs).get('1');
      if (one?.payload['event'] !== 'alarm') return 'device 1 lost its alarm event';
      return byId(obs).has('4') ? 'the person-category device was mapped' : undefined;
    },
  });
  assert.ok(r.passed, formatSuite(r));
});

test('every example is user-configured, disabled, opens no policy, and has a valid manifest', () => {
  for (const doc of [live(), rest(), local()]) {
    assert.equal(doc['review'], 'user-configured');
    assert.equal(doc['enabled'], false);
    assert.equal(doc['dataPolicy'], undefined);
    const v = defaultConnectorRegistry.validate(doc);
    assert.ok(v.ok && v.definition, v.errors.join('; '));
    const m = traccarManifest(v.definition);
    const parsed = manifestSchema.parse(m);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(m.enabledByDefault, false);
    assert.equal(m.commercialReview, 'manual-review-required');
    assert.equal(m.dataPolicy.redistributionAllowed, false);
    // One poll is two requests: the limit covers the burst twice plus one, and the budget both.
    assert.ok(m.refreshPolicy.maxRequestsPerMinute >= 5);
    assert.ok((m.refreshPolicy.pollBudgetMs ?? 0) >= m.refreshPolicy.timeoutMs * 2);
  }
});

// ── the REST snapshot ───────────────────────────────────────────────────────

test('REST: devices joined to positions; unknown device labelled by id; person category left out', async () => {
  const withPerson = JSON.stringify([
    ...(JSON.parse(fixture('positions.json')) as unknown[]),
    { ...(JSON.parse(fixture('socket-positions.json')) as { positions: object[] }).positions[2] },
  ]);
  const { poll, provider, ctx } = await start(
    rest(),
    server(undefined, () => ok(withPerson)),
  );
  const obs = await poll();
  const m = byId(obs);
  assert.deepEqual([...m.keys()].sort(), ['1', '2', '3', '7']);
  assert.equal(m.get('1')!.payload['name'], 'Van 12');
  assert.equal(m.get('1')!.payload['category'], 'van');
  assert.equal(m.get('1')!.payload['status'], 'online');
  assert.equal(m.get('1')!.payload['model'], 'FMB920');
  assert.equal(m.get('3')!.payload['category'], 'boat');
  assert.equal(m.get('7')!.payload['name'], '7');
  assert.equal(m.get('7')!.payload['category'], undefined);
  // fixTime is the observation time, not serverTime.
  assert.equal(m.get('2')!.observedAt, '2026-09-23T19:57:45.000Z');
  // Nothing that identifies a tracker or a person reaches an observation.
  const text = JSON.stringify(obs);
  for (const secretish of ['860000000000012', '555 0100', 'Field office', 'uniqueId', 'Survey handset'])
    assert.ok(!text.includes(secretish), secretish);
  const h = await provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(h.message ?? '', /category "person" are not shown/);
  assert.equal(provider.stats.excluded, 1);
  // Two requests, the token attached by the host as a bearer token.
  assert.deepEqual(
    ctx.http.requests.map((r) => r.url),
    ['https://demo.traccar.org/api/devices', 'https://demo.traccar.org/api/positions'],
  );
  for (const r of ctx.http.requests) assert.deepEqual(r.credential, { key: 'traccar-demo.token', as: 'bearer' });
});

test('REST: speed in knots becomes m/s; course is a heading', async () => {
  const { poll } = await start(rest(), server());
  const m = byId(await poll());
  assert.equal(m.get('1')!.payload['speedMps'], 11.112); // 21.6 kn
  assert.equal(m.get('2')!.payload['speedMps'], 2.212); // 4.3 kn
  assert.equal(m.get('3')!.payload['speedMps'], 0);
  assert.equal(m.get('1')!.payload['headingDegrees'], 274);
  assert.equal(m.get('1')!.position?.altitudeM, 12);
});

test('REST: the device list is read again only every few minutes', async () => {
  const { poll, ctx, clock } = await start(rest(), server());
  await poll();
  clock.advance(30_000);
  await poll();
  const paths = () => ctx.http.requests.map((r) => pathOf(r));
  assert.deepEqual(paths(), ['/api/devices', '/api/positions', '/api/positions']);
  clock.advance(TRACCAR_DEVICES_REFRESH_MS);
  await poll();
  assert.deepEqual(paths().slice(3), ['/api/devices', '/api/positions']);
});

test('REST: a device list that fails leaves the positions to be read, labelled by id, and is retried', async () => {
  let devices: testing.FixtureResponse = { status: 500 };
  const { poll, provider, ctx, clock } = await start(
    rest(),
    server(() => devices),
  );
  const obs = await poll();
  assert.equal(obs.length, 4);
  assert.equal(byId(obs).get('1')!.payload['name'], '1');
  const h = await provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(h.message ?? '', /device names unavailable/);
  devices = ok(fixture('devices.json'));
  clock.advance(TRACCAR_DEVICES_RETRY_MS);
  const again = byId(await poll());
  assert.equal(again.get('1')!.payload['name'], 'Van 12');
  assert.equal((await provider.health()).message, undefined);
  assert.equal(ctx.http.requests.filter((r) => pathOf(r) === '/api/devices').length, 2);
});

test('REST: a device list that is not a device list is not taken as one', async () => {
  const { poll, provider } = await start(
    rest(),
    server(() => ok(fixture('positions.json'))),
  );
  const obs = await poll();
  assert.equal(obs.length, 4);
  assert.equal(provider.directory.deviceCount, 0);
  assert.match((await provider.health()).message ?? '', /no entry of the \/api\/devices answer has an id and a name/);
});

test('auth failure: a refused token is AUTH on the device list and on the positions', async () => {
  for (const responder of [server(() => ({ status: 401 })), server(undefined, () => ({ status: 403 }))]) {
    const { poll, provider } = await start(rest(), responder);
    await assert.rejects(poll(), (err: unknown) => err instanceof ProviderError && err.code === 'AUTH');
    assert.equal((await provider.health()).status, 'AUTH_REQUIRED');
  }
});

test('REST: a timeout or an offline server fails the poll at the device list, without a second request', async () => {
  const { poll, ctx } = await start(
    rest(),
    server(() => ({ error: 'timeout' })),
  );
  await assert.rejects(poll(), (err: unknown) => err instanceof ProviderError && err.code === 'TIMEOUT');
  assert.equal(ctx.http.requests.length, 1);
});

test('REST: positions without a device, or that the mapping cannot use, are MALFORMED when none is usable', async () => {
  for (const body of ['[{"id":1}]', '[{"deviceId":1}]', '{"error":"x"}']) {
    const { poll } = await start(
      rest(),
      server(undefined, () => ok(body)),
    );
    await assert.rejects(poll(), (err: unknown) => err instanceof ProviderError && err.code === 'MALFORMED', body);
  }
  // One bad position among good ones is counted, not fatal.
  const mixed = JSON.stringify([...(JSON.parse(fixture('positions.json')) as unknown[]), { id: 9 }]);
  const { poll, provider } = await start(
    rest(),
    server(undefined, () => ok(mixed)),
  );
  assert.equal((await poll()).length, 4);
  assert.match((await provider.health()).message ?? '', /1 position\(s\) rejected/);
});

test('REST: only person-category positions is an empty answer, not a malformed one', async () => {
  const person = (JSON.parse(fixture('socket-positions.json')) as { positions: object[] }).positions[2];
  const { poll, provider } = await start(
    rest(),
    server(undefined, () => ok(JSON.stringify([person]))),
  );
  assert.deepEqual(await poll(), []);
  assert.equal((await provider.health()).status, 'LIVE');
});

// ── the socket over the snapshot ────────────────────────────────────────────

test('socket: the token goes in the URL the host dials; the provider never sees it', async () => {
  const { provider, sockets } = await start(live(), server());
  sockets.secrets['traccar-demo.token'] = 's3cret';
  const seen: Array<{ secret?: string }> = [];
  await provider.subscribe!({ signal: new AbortController().signal }, () => undefined);
  const opened = sockets.opened[0]!;
  assert.equal(opened.url, 'wss://demo.traccar.org/api/socket?token=s3cret');
  assert.deepEqual(opened.credential, { key: 'traccar-demo.token', as: 'query', param: 'token' });
  const events = opened.events;
  const original = events.onOpen!;
  events.onOpen = (ctx) => {
    seen.push(ctx);
    original(ctx);
  };
  opened.handle.simulateOpen();
  assert.deepEqual(seen, [{}]);
  assert.deepEqual(opened.handle.sent, [], 'no frame is sent: Traccar needs none');
});

test('socket: nothing is opened until the token is configured', async () => {
  const { provider, sockets } = await start(live(), server(), { credentials: [] });
  await assert.rejects(
    provider.subscribe!({ signal: new AbortController().signal }, () => undefined),
    (err: unknown) => err instanceof ProviderError && err.code === 'AUTH',
  );
  assert.equal(sockets.opened.length, 0);
});

test('snapshot + socket: socket positions carry the snapshot’s names; an event re-sends the device’s last position with it', async () => {
  const { provider, sockets, poll } = await start(live(), server());
  const snapshot = byId(await poll());
  assert.equal(snapshot.get('3')!.payload['event'], undefined);
  const emitted: Observation[] = [];
  await provider.subscribe!({ signal: new AbortController().signal }, (obs) => emitted.push(...obs));
  const s = sockets.opened[0]!.handle;
  s.simulateOpen();
  // Device 3 raises an event without moving: its REST position again, now with the event.
  s.simulateMessage(
    JSON.stringify({
      events: [
        {
          id: 9001,
          deviceId: 3,
          type: 'deviceOffline',
          eventTime: '2026-09-23T19:59:50.000+00:00',
          positionId: 0,
          geofenceId: 0,
          attributes: {},
        },
      ],
    }),
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.externalId, '3');
  assert.equal(emitted[0]!.payload['event'], 'deviceOffline');
  assert.equal(emitted[0]!.payload['name'], 'Kaimana');
  assert.equal(emitted[0]!.observedAt, snapshot.get('3')!.observedAt);
  // A socket position for a device the snapshot named.
  s.simulateMessage(fixture('socket-positions.json'));
  const one = emitted.filter((o) => o.externalId === '1').at(-1)!;
  assert.equal(one.payload['name'], 'Van 12');
  assert.equal(one.payload['speedMps'], 9.466);
  assert.equal(one.observedAt, '2026-09-23T19:59:41.000Z');
  // Device 4 is a person in the snapshot: never emitted.
  assert.ok(!emitted.some((o) => o.externalId === '4'));
  // A later event keeps the device's newest position, not the snapshot's.
  s.simulateMessage(fixture('socket-events.json'));
  const alarm = emitted.filter((o) => o.externalId === '1').at(-1)!;
  assert.equal(alarm.payload['alarm'], 'sos');
  assert.equal(alarm.observedAt, '2026-09-23T19:59:41.000Z');
  assert.equal((await provider.health()).status, 'LIVE');
});

test('socket: a renamed device is re-sent with its new name; a device turned person is not', async () => {
  const { provider, sockets, poll } = await start(live(), server());
  await poll();
  const emitted: Observation[] = [];
  await provider.subscribe!({ signal: new AbortController().signal }, (obs) => emitted.push(...obs));
  const s = sockets.opened[0]!.handle;
  s.simulateOpen();
  const devices = JSON.parse(fixture('devices.json')) as Array<Record<string, unknown>>;
  s.simulateMessage(
    JSON.stringify({
      devices: [
        { ...devices[0], name: 'Van 12 (spare)' },
        { ...devices[1], category: 'person' },
      ],
    }),
  );
  assert.deepEqual(
    emitted.map((o) => [o.externalId, o.payload['name']]),
    [['1', 'Van 12 (spare)']],
  );
});

test('socket: an older position does not replace the newer one an event is attached to', async () => {
  const dir = new TraccarDirectory();
  dir.record({ deviceId: 1, fixTime: '2026-09-23T19:59:00.000Z', latitude: 1, longitude: 1 });
  dir.record({ deviceId: 1, fixTime: '2026-09-23T19:50:00.000Z', latitude: 2, longitude: 2 });
  assert.equal(dir.lastPosition(1)!['latitude'], 1);
});

test('socket: a dropped socket after a good poll is DEGRADED, before one OFFLINE; it reconnects with back-off', async () => {
  const timers = new ManualTimers();
  const { provider, sockets, poll } = await start(live(), server(), { timers });
  await provider.subscribe!({ signal: new AbortController().signal }, () => undefined);
  sockets.opened[0]!.handle.simulateOpen();
  sockets.opened[0]!.handle.simulateClose(1006, 'gone');
  let h = await provider.health();
  assert.equal(h.status, 'OFFLINE');
  assert.deepEqual(timers.delays(), [2000]);
  await poll();
  h = await provider.health();
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.message ?? '', /live socket unavailable .*positions from the poll every 300 s/);
  timers.runAll();
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.opened.length, 2);
  assert.equal(provider.stats.reconnects, 1);
  sockets.opened[1]!.handle.simulateOpen();
  assert.equal((await provider.health()).status, 'LIVE');
  sockets.opened[1]!.handle.simulateClose(1006, 'gone again');
  assert.deepEqual(timers.delays(), [2000], 'a good open resets the back-off');
});

test('socket: unsubscribing closes it and nothing is emitted after', async () => {
  const { provider, sockets } = await start(live(), server());
  const emitted: Observation[] = [];
  const abort = new AbortController();
  await provider.subscribe!({ signal: abort.signal }, (obs) => emitted.push(...obs));
  const s = sockets.opened[0]!.handle;
  s.simulateOpen();
  abort.abort();
  assert.ok(s.closed);
  s.simulateMessage(fixture('socket-positions.json'));
  assert.equal(emitted.filter((o) => o.externalId).length, 0);
});

test('a definition without a websocket has no subscription', async () => {
  const { provider } = await start(rest(), server());
  assert.equal(provider.subscribe, undefined);
});

// ── a server on this computer or the operator's network ─────────────────────

test('local: loopback by default, the named host and port from settings, REST only', async () => {
  const v = defaultConnectorRegistry.validate(local());
  assert.ok(v.ok && v.definition);
  const m = traccarManifest(v.definition);
  assert.equal(m.transport, 'local-process');
  assert.equal(m.trustedHostSetting, 'host');
  assert.deepEqual(m.allowedHosts, ['127.0.0.1', 'localhost']);
  assert.deepEqual(
    m.settings?.map((s) => s.key),
    ['host', 'port'],
  );
  assert.equal(m.refreshPolicy.intervalMs, 30_000);

  const first = await start(local(), server());
  await first.poll();
  assert.equal(first.ctx.http.requests[0]!.url, 'http://127.0.0.1:8082/api/devices');
  assert.deepEqual(first.ctx.http.requests[0]!.credential, { key: 'traccar-local.token', as: 'bearer' });
  assert.equal(first.provider.subscribe, undefined);

  const named = await start(local(), server(), { settings: { host: 'Traccar.Home.Example', port: 8090 } });
  await named.poll();
  assert.equal(named.ctx.http.requests[0]!.url, 'http://traccar.home.example:8090/api/devices');

  const badPort = await start(local(), server(), { settings: { port: 'eighty' } });
  await badPort.poll();
  assert.equal(badPort.ctx.http.requests[0]!.url, 'http://127.0.0.1:8082/api/devices');
});

// ── validation ─────────────────────────────────────────────────────────────

test('validation refuses what a Traccar source cannot be', () => {
  const errorsOf = (doc: Record<string, unknown>) => {
    const v = defaultConnectorRegistry.validate(doc);
    return v.ok ? [] : v.errors;
  };
  const ws = live()['websocket'] as Record<string, unknown>;
  const ep = live()['endpoint'] as Record<string, unknown>;
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      'socket without endpoint',
      { ...local(), websocket: ws, credentials: live()['credentials'] },
      /websocket needs an endpoint/,
    ],
    [
      'socket elsewhere',
      { ...live(), websocket: { ...ws, url: 'wss://other.example.org/api/socket' } },
      /same server's socket/,
    ],
    ['socket token as a frame', { ...live(), websocket: { ...ws, credential: { name: 'token' } } }, /must be "query"/],
    ['socket subscribe frame', { ...live(), websocket: { ...ws, subscribe: { hello: 1 } } }, /no subscribe frame/],
    ['API path', { ...live(), endpoint: { ...ep, url: 'https://demo.traccar.org/api/positions' } }, /not an API path/],
    ['no REST token', { ...rest(), endpoint: { url: 'https://demo.traccar.org' } }, /endpoint.credential is required/],
    [
      'token in the query',
      { ...rest(), endpoint: { ...ep, credential: { name: 'token', as: 'query', param: 'token' } } },
      /"bearer"/,
    ],
    [
      'header without name',
      { ...rest(), endpoint: { ...ep, credential: { name: 'token', as: 'header' } } },
      /needs param/,
    ],
    ['local without token', { ...local(), credentials: { key: { secretRef: 'x.key' } } }, /credentials.token/],
    ['bounds', { ...rest(), boundsQuery: true }, /boundsQuery is not supported/],
    ['POST', { ...rest(), endpoint: { ...ep, method: 'POST' } }, /GET/],
  ];
  for (const [what, doc, pattern] of cases)
    assert.ok(
      errorsOf(doc).some((e) => pattern.test(e)),
      `${what}: ${errorsOf(doc).join('; ') || 'accepted'}`,
    );
  // A server under a path prefix, its socket beside it; `/api` at the end is the same server.
  const prefixed = {
    ...live(),
    endpoint: { ...ep, url: 'https://gps.example.org/traccar/api/' },
    websocket: { ...ws, url: 'wss://gps.example.org/traccar/api/socket' },
  };
  assert.deepEqual(errorsOf(prefixed), []);
  assert.equal(traccarBase('https://gps.example.org/traccar/api/'), 'https://gps.example.org/traccar');
  const w = validateTraccar(defaultConnectorRegistry.validate(rest()).definition!);
  assert.deepEqual(w.errors, []);
});

// ── reading Traccar's JSON ──────────────────────────────────────────────────

test('socket messages: parts, keep-alive, malformed', () => {
  assert.deepEqual(readSocketMessage('{}'), { kind: 'keepalive' });
  assert.equal(readSocketMessage('nope').kind, 'malformed');
  assert.equal(readSocketMessage('[]').kind, 'malformed');
  assert.equal(readSocketMessage('{"events":{}}').kind, 'malformed');
  assert.equal(readSocketMessage('{"other":1}').kind, 'malformed');
  const m = readSocketMessage(new TextEncoder().encode('{"positions":[{"deviceId":1}]}'));
  assert.equal(m.kind, 'update');
  if (m.kind === 'update') {
    assert.equal(m.positions.length, 1);
    assert.deepEqual(m.devices, []);
  }
});

test('devices and events are reduced to what describes the equipment', () => {
  const d = readDevice((JSON.parse(fixture('devices.json')) as unknown[])[3]);
  assert.deepEqual(d, {
    id: 4,
    name: 'Survey handset',
    category: 'person',
    status: 'online',
    disabled: false,
    lastUpdate: '2026-09-23T19:59:20.000+00:00',
  });
  assert.equal(readDevice({ id: 'x', name: 'n' }), undefined);
  assert.equal(readDevice({ id: 1 }), undefined);
  const e = readEvent((JSON.parse(fixture('socket-events.json')) as { events: unknown[] }).events[1]);
  assert.deepEqual(e, {
    id: 5522,
    deviceId: 1,
    type: 'alarm',
    eventTime: '2026-09-23T19:59:41.000+00:00',
    positionId: 88121,
    alarm: 'sos',
  });
  assert.equal(readEvent({ deviceId: 1 }), undefined);
});
