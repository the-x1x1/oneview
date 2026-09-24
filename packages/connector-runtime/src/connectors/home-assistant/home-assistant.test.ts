import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, manifestSchema, testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import type { JsonValue, Observation } from '@worldview/world-model';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { defaultConnectorRegistry, formatSuite, runConnectorSuite, type SuiteFixtures } from '../../index.js';
import {
  HA_ALLOWED_FRAMES,
  HA_AUTH_TIMEOUT_MS,
  HA_MAX_ENTITIES,
  HA_PING_MS,
  HA_REFUSED_RETRY_MS,
  HA_RESYNC_MS,
  HA_SILENCE_MS,
  HomeAssistantProvider,
  haEndpoint,
  homeAssistantManifest,
  parseHaSettings,
  validateHomeAssistant,
  type Timers,
} from './home-assistant.js';
import {
  MAX_POSITIONS,
  MAX_SELECTORS,
  REFUSED_DOMAINS,
  enrich,
  matches,
  parsePositions,
  parseSelectors,
  readState,
  toSi,
  type HaState,
} from './entities.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const examplesDir = path.join(root, 'connectors', 'examples', 'home-assistant');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const fixture = (name: string) => read(`fixtures/connectors/home-assistant/${name}`);
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(examplesDir, `home-assistant-${name}.json`), 'utf8')) as Record<string, unknown>;
const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const TOKEN_KEY = 'home-assistant-token';
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.test-token-value';
const STATES = fixture('states.json');
const SESSION = JSON.parse(fixture('socket-session.json')) as Array<Record<string, unknown>>;
const AUTH_INVALID = JSON.parse(fixture('socket-auth-invalid.json')) as Array<Record<string, unknown>>;

function definition(name: string, patch: Record<string, unknown> = {}): ConnectorProviderDefinition {
  const v = defaultConnectorRegistry.validate({ ...example(name), ...patch });
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  return v.definition;
}

/** Timers a test advances by hand, on the same virtual clock the context reads. */
class ManualTimers implements Timers {
  private seq = 0;
  readonly pending = new Map<number, { at: number; fn: () => void }>();
  constructor(readonly clock: testing.VirtualClock) {}
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.clock.now() + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Move the clock on by `ms`, running every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.clock.now() + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.pending) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.pending.delete(next[0]);
      this.clock.set(Math.max(this.clock.now(), next[1].at));
      next[1].fn();
    }
    this.clock.set(end);
  }
}

/** Every fixture socket this file opened, for the "only auth, subscribe_events and ping" test at the end. */
const everySockets: testing.FixtureSockets[] = [];
/** Every HTTP request any provider in this file made. */
const everyRequest: ProviderHttpRequest[] = [];

const settle = () => new Promise((r) => setImmediate(r));

async function harness(
  name: string,
  opts: {
    settings?: Record<string, JsonValue>;
    responder?: testing.FixtureResponder;
    patch?: Record<string, unknown>;
    credentials?: string[];
    refuseSocket?: ProviderError;
  } = {},
) {
  const clock = new testing.VirtualClock(NOW);
  const timers = new ManualTimers(clock);
  const sockets = new testing.FixtureSockets();
  everySockets.push(sockets);
  sockets.secrets = { [TOKEN_KEY]: TOKEN };
  if (opts.refuseSocket) {
    const refusal = opts.refuseSocket;
    sockets.open = async () => {
      throw refusal;
    };
  }
  const responder = opts.responder ?? (() => ({ status: 200, body: STATES }));
  const ctx = testing.createFixtureContext({
    providerId: String(example(name)['id']),
    clock,
    sockets,
    credentials: opts.credentials ?? [TOKEN_KEY],
    settings: opts.settings ?? {},
    responder: (req) => {
      everyRequest.push(req);
      return responder(req);
    },
  });
  const provider = new HomeAssistantProvider(definition(name, opts.patch), { timers, flushIntervalMs: 0 });
  await provider.initialize(ctx);
  await provider.start();
  const emitted: Observation[][] = [];
  const abort = new AbortController();
  const poll = (signal = new AbortController().signal) => provider.query({ signal, background: true });
  const subscribe = () => provider.subscribe({ signal: abort.signal }, (obs) => emitted.push(obs));
  const socket = (n = sockets.opened.length - 1) => sockets.opened[n]!.handle;
  const frames = (n = sockets.opened.length - 1) =>
    socket(n).sent.map((f) => {
      const text = typeof f === 'string' ? f : new TextDecoder().decode(f);
      return JSON.parse(text) as Record<string, unknown>;
    });
  const serve = (msg: unknown, n?: number) => socket(n).simulateMessage(JSON.stringify(msg));
  /** Open the latest socket and walk it to a live subscription, as Home Assistant answers. */
  const goLive = (n?: number) => {
    socket(n).simulateOpen();
    serve(SESSION[0], n); // auth_required
    serve(SESSION[1], n); // auth_ok
    const sub = frames(n).find((f) => f['type'] === 'subscribe_events');
    serve({ id: sub?.['id'], type: 'result', success: true, result: null }, n);
  };
  const flat = () => emitted.flat();
  return {
    provider,
    ctx,
    clock,
    timers,
    sockets,
    abort,
    poll,
    subscribe,
    socket,
    frames,
    serve,
    goLive,
    emitted,
    flat,
  };
}

// ---------------------------------------------------------------------------------------
// The shared suite on every example, from its sidecar.

interface Sidecar {
  normal: string;
  empty: string;
  malformed: Array<{ inline: string }>;
  expectObservations: number;
  expectIds?: string[];
  expect?: Array<{ externalId: string; position?: { latitude: number; longitude: number }; payload?: object }>;
}

const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'));

test('home-assistant: there are examples, each with a sidecar', () => {
  assert.deepEqual(exampleFiles.sort(), [
    'home-assistant-sensors.json',
    'home-assistant-weather.json',
    'home-assistant-zones.json',
  ]);
  for (const f of exampleFiles) assert.ok(readdirSync(examplesDir).includes(f.replace(/\.json$/, '.test.json')), f);
});

for (const file of exampleFiles) {
  test(`home-assistant: the shared suite passes on ${file}`, async () => {
    const doc = JSON.parse(readFileSync(path.join(examplesDir, file), 'utf8')) as Record<string, unknown>;
    const side = JSON.parse(
      readFileSync(path.join(examplesDir, file.replace(/\.json$/, '.test.json')), 'utf8'),
    ) as Sidecar;
    const fixtures: SuiteFixtures = {
      normal: read(side.normal),
      empty: read(side.empty),
      malformed: side.malformed.map((m) => m.inline),
      expectObservations: side.expectObservations,
      ...(side.expectIds ? { expectIds: side.expectIds } : {}),
      verify: (obs) => {
        for (const e of side.expect ?? []) {
          const o = obs.find((x) => x.externalId === e.externalId);
          if (!o) return `missing ${e.externalId}`;
          if (
            e.position &&
            (o.position?.latitude !== e.position.latitude || o.position?.longitude !== e.position.longitude)
          )
            return `${e.externalId} at ${o.position?.latitude},${o.position?.longitude}`;
          for (const [k, v] of Object.entries(e.payload ?? {}))
            if (JSON.stringify(o.payload[k]) !== JSON.stringify(v))
              return `${e.externalId}.${k} = ${JSON.stringify(o.payload[k])}, expected ${JSON.stringify(v)}`;
        }
        return undefined;
      },
    };
    const r = await runConnectorSuite(doc, fixtures);
    assert.ok(r.passed, formatSuite(r));
    assert.equal(r.checks.length, 14);
  });
}

// ---------------------------------------------------------------------------------------
// Definition, manifest, settings.

test('home-assistant: the examples are user-configured, disabled, open no policy and hold no address or secret', () => {
  for (const f of exampleFiles) {
    const doc = JSON.parse(readFileSync(path.join(examplesDir, f), 'utf8')) as Record<string, unknown>;
    assert.equal(doc['review'], 'user-configured', f);
    assert.equal(doc['enabled'], false, f);
    assert.equal(doc['dataPolicy'], undefined, f);
    assert.equal(doc['endpoint'], undefined, f);
    assert.equal(doc['websocket'], undefined, f);
    const text = JSON.stringify(doc);
    assert.doesNotMatch(text, /Bearer|access_token|eyJ|https?:\/\/(?!(www|developers)\.home-assistant\.io)/, f);
    assert.deepEqual(Object.values(doc['credentials'] as object), [
      {
        secretRef: TOKEN_KEY,
        label: 'Home Assistant long-lived access token',
        kind: 'token',
        helpUrl: 'https://www.home-assistant.io/docs/authentication/#your-account-profile',
      },
    ]);
  }
});

test('home-assistant: the manifest is a local source — loopback plus the one host the operator names', () => {
  const m = homeAssistantManifest(definition('sensors'));
  const parsed = manifestSchema.parse(m);
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.issues));
  assert.equal(m.transport, 'local-process');
  assert.equal(m.trustedHostSetting, 'host');
  assert.deepEqual(m.allowedHosts, ['127.0.0.1', 'localhost']);
  assert.equal(m.enabledByDefault, false);
  assert.equal(m.commercialReview, 'manual-review-required');
  assert.deepEqual(
    m.credentials.map((c) => [c.key, c.required]),
    [[TOKEN_KEY, true]],
  );
  assert.deepEqual(
    (m.settings ?? []).map((s) => s.key),
    ['host', 'port', 'tls', 'entities', 'positions'],
  );
  assert.equal(m.dataPolicy.redistributionAllowed, false);
  assert.equal(m.dataPolicy.commercialUseAllowed, 'unknown');
  assert.equal(m.refreshPolicy.intervalMs, 60_000);
  assert.ok(m.refreshPolicy.maxRequestsPerMinute * m.refreshPolicy.intervalMs >= 60_000);
});

test('home-assistant: the address comes from the settings under the local-endpoint policy', () => {
  const at = (raw: Record<string, unknown>) => haEndpoint(parseHaSettings(raw));
  assert.deepEqual(at({}), {
    ok: true,
    base: 'http://127.0.0.1:8123',
    statesUrl: 'http://127.0.0.1:8123/api/states',
    socketUrl: 'ws://127.0.0.1:8123/api/websocket',
    trusted: false,
  });
  const lan = at({ host: ' 192.168.1.20 ', port: 8124, tls: true });
  assert.ok(lan.ok);
  assert.equal(lan.statesUrl, 'https://192.168.1.20:8124/api/states');
  assert.equal(lan.socketUrl, 'wss://192.168.1.20:8124/api/websocket');
  assert.equal(lan.trusted, true);
  const named = at({ host: 'HomeAssistant.local' });
  assert.ok(named.ok && named.statesUrl === 'http://homeassistant.local:8123/api/states');
  assert.ok(at({ host: 'localhost' }).ok);
  for (const host of ['192.168.1.20/admin', 'user@host', 'ha.example.org:9000', '*.lan', 'a b'])
    assert.equal(at({ host }).ok, false, host);
  assert.equal(parseHaSettings({ port: 70000 }).port, 8123);
  assert.equal(parseHaSettings({ tls: 'yes' }).tls, false);
});

test('home-assistant: validation refuses an address, a missing or second credential and viewport queries', () => {
  const base = example('sensors');
  const errors = (patch: Record<string, unknown>) => {
    const v = defaultConnectorRegistry.validate({ ...base, ...patch });
    return v.ok ? [] : v.errors;
  };
  assert.match(errors({ endpoint: { url: 'https://ha.example.org/api/states' } }).join(), /never holds an address/);
  assert.match(errors({ websocket: { url: 'wss://ha.example.org/api/websocket' } }).join(), /never holds an address/);
  assert.match(errors({ credentials: {} }).join(), /exactly one credential/);
  assert.match(
    errors({
      credentials: {
        token: { secretRef: TOKEN_KEY },
        other: { secretRef: 'another-token' },
      },
    }).join(),
    /exactly one credential/,
  );
  assert.match(errors({ boundsQuery: true }).join(), /boundsQuery is not supported/);
  const warned = validateHomeAssistant(
    definition('zones', {
      mapping: {
        externalId: 'entity_id',
        observedAt: 'last_updated',
        position: { latLon: '_position' },
        filter: [{ path: '_domain', in: ['person', 'device_tracker'] }],
      },
    }),
  );
  assert.ok(warned.ok);
  assert.match(warned.warnings.join(), /person, device_tracker entities are never read/);
});

// ---------------------------------------------------------------------------------------
// REST.

test('home-assistant: the snapshot is one GET /api/states with the token as a bearer credential', async () => {
  const h = await harness('sensors', { settings: { host: '192.168.1.20' } });
  const obs = await h.poll();
  assert.equal(obs.length, 6);
  assert.equal(h.ctx.http.requests.length, 1);
  const req = h.ctx.http.requests[0]!;
  assert.equal(req.url, 'http://192.168.1.20:8123/api/states');
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined);
  assert.deepEqual(req.credential, { key: TOKEN_KEY, as: 'bearer' });
  assert.equal(req.allowStale, false);
  // The provider never has the token: it names the key and the host attaches it.
  assert.doesNotMatch(JSON.stringify(req), new RegExp(TOKEN));
  const health = await h.provider.health();
  assert.equal(health.status, 'LIVE');
  assert.match(health.message ?? '', /reading \/api\/states once a minute/);
});

test('home-assistant: person and device_tracker entities never become observations, whatever selects them', async () => {
  for (const name of ['sensors', 'weather', 'zones']) {
    const h = await harness(name, { settings: { entities: 'person.*, device_tracker.*, *.*' } });
    const obs = await h.poll();
    assert.ok(obs.length > 0, name);
    for (const o of obs) assert.ok(!REFUSED_DOMAINS.has(o.externalId!.split('.')[0]!), `${name}: ${o.externalId}`);
  }
  // A definition that asks for them outright gets nothing — they were dropped before mapping.
  const h = await harness('zones', {
    patch: {
      mapping: {
        externalId: 'entity_id',
        observedAt: 'last_updated',
        position: { latLon: '_position' },
        labels: { name: 'attributes.friendly_name' },
        filter: [{ path: '_domain', in: ['person', 'device_tracker'] }],
      },
    },
  });
  assert.deepEqual(await h.poll(), []);
  assert.ok(h.provider.stats.refused >= 2);
});

test('home-assistant: the entities setting narrows what the definition selects; bad patterns are reported', async () => {
  const h = await harness('sensors', {
    settings: { entities: 'sensor.outdoor_*;  bogus pattern, Sensor.House_Power' },
  });
  const ids = (await h.poll()).map((o) => o.externalId).sort();
  assert.deepEqual(ids, ['sensor.house_power', 'sensor.outdoor_humidity', 'sensor.outdoor_temperature']);
  const health = await h.provider.health();
  assert.match(health.message ?? '', /settings: "bogus" is not an entity id or pattern/);
});

test('home-assistant: positions place entities without coordinates, by fixed point or by zone; attributes win', async () => {
  const h = await harness('sensors', {
    settings: {
      positions:
        'sensor.garden_*=zone.community_garden; sensor.house_power = 21.25,-157.80\nsensor.nearest_station_pm2_5=0,0; nonsense',
    },
  });
  const obs = await h.poll();
  const at = (id: string) => obs.find((o) => o.externalId === id)!;
  assert.deepEqual(
    [
      at('sensor.garden_soil_temperature').position?.latitude,
      at('sensor.garden_soil_temperature').payload['positionSource'],
    ],
    [21.2972, 'zone'],
  );
  assert.deepEqual(
    [
      at('sensor.house_power').position?.latitude,
      at('sensor.house_power').position?.longitude,
      at('sensor.house_power').payload['positionSource'],
    ],
    [21.25, -157.8, 'table'],
  );
  // The station states its own coordinates; the table does not move it.
  assert.deepEqual(
    [
      at('sensor.nearest_station_pm2_5').position?.latitude,
      at('sensor.nearest_station_pm2_5').payload['positionSource'],
    ],
    [21.3279, 'attributes'],
  );
  assert.equal(at('sensor.outdoor_temperature').payload['positionSource'], 'home');
  assert.match((await h.provider.health()).message ?? '', /"nonsense" has no "="/);
});

test('home-assistant: without a home zone and a position, an entity is rejected and health says why', async () => {
  const states = (JSON.parse(STATES) as HaState[]).filter((s) => s.entity_id !== 'zone.home');
  const h = await harness('weather', { responder: () => ({ status: 200, body: JSON.stringify(states) }) });
  assert.deepEqual(await h.poll(), []);
  const health = await h.provider.health();
  assert.equal(health.status, 'LIVE');
  assert.match(health.message ?? '', /2 selected entities rejected/);
});

test('home-assistant: the REST path reports what Home Assistant answered', async () => {
  const cases: Array<[testing.FixtureResponse, string]> = [
    [{ status: 401, body: '401: Unauthorized' }, 'AUTH'],
    [{ error: 'network' }, 'NETWORK'],
    [{ status: 200, body: '{"message":"API running."}' }, 'MALFORMED'],
    [{ status: 200, body: '[{"no":"entity"}]' }, 'MALFORMED'],
    [{ status: 502, body: 'Bad Gateway' }, 'HTTP_5XX'],
  ];
  for (const [response, code] of cases) {
    const h = await harness('zones', { responder: () => response });
    await assert.rejects(h.poll(), (e: unknown) => e instanceof ProviderError && e.code === code, code);
  }
  const auth = await harness('zones', { responder: () => ({ status: 401 }) });
  await assert.rejects(auth.poll());
  assert.equal((await auth.provider.health()).status, 'AUTH_REQUIRED');
  const offline = await harness('zones', { responder: () => ({ error: 'network' }) });
  await assert.rejects(offline.poll());
  assert.equal((await offline.provider.health()).status, 'OFFLINE');
  const missing = await harness('zones', { credentials: [] });
  assert.equal((await missing.provider.health()).status, 'AUTH_REQUIRED');
  // A bad address is not HOST_NOT_ALLOWED (on which the host stops polling for good): a corrected one is read.
  const badHost = await harness('zones', { settings: { host: 'not a host' } });
  await assert.rejects(badHost.poll(), (e: unknown) => e instanceof ProviderError && e.code === 'UNSUPPORTED');
  assert.equal(badHost.ctx.http.requests.length, 0);
  assert.equal((await badHost.provider.health()).status, 'ERROR');
  badHost.ctx.settings.update({ host: '192.168.1.20' });
  assert.equal((await badHost.poll()).length, 2);
  assert.equal(badHost.ctx.http.requests[0]!.url, 'http://192.168.1.20:8123/api/states');
  assert.equal((await badHost.provider.health()).status, 'LIVE');
});

// ---------------------------------------------------------------------------------------
// WebSocket.

test('home-assistant: the socket authenticates with the token in the auth frame, then subscribes to state_changed', async () => {
  const h = await harness('sensors', { settings: { host: '192.168.1.20', tls: true } });
  await h.subscribe();
  assert.equal(h.sockets.opened.length, 1);
  assert.equal(h.sockets.opened[0]!.url, 'wss://192.168.1.20:8123/api/websocket');
  assert.deepEqual(h.sockets.opened[0]!.credential, { key: TOKEN_KEY });
  h.socket().simulateOpen();
  assert.deepEqual(h.frames(), [{ type: 'auth', access_token: TOKEN }]);
  assert.equal(h.provider.socketStatus, 'authenticating');
  h.serve(SESSION[0]);
  h.serve(SESSION[1]);
  assert.deepEqual(h.frames()[1], { id: 1, type: 'subscribe_events', event_type: 'state_changed' });
  assert.equal(h.provider.socketStatus, 'subscribing');
  h.serve(SESSION[2]);
  assert.equal(h.provider.socketStatus, 'live');
  assert.equal((await h.provider.health()).status, 'LIVE');
  assert.match((await h.provider.health()).message ?? '', /live over the WebSocket API/);
  // Nothing about the token is kept or logged.
  assert.doesNotMatch(JSON.stringify(h.ctx.logger.entries), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(await h.provider.health()), new RegExp(TOKEN));
});

test('home-assistant: state_changed events are mapped from new_state; refused, unselected and removed entities are not', async () => {
  const h = await harness('sensors');
  await h.poll(); // the states the zone lookups and the home position come from
  await h.subscribe();
  h.goLive();
  const refusedBefore = h.provider.stats.refused;
  for (const m of SESSION.slice(3)) h.serve(m);
  const obs = h.flat();
  assert.deepEqual(
    obs.map((o) => o.externalId),
    ['sensor.outdoor_temperature'],
  );
  const t = obs[0]!;
  assert.equal(t.payload['value'], 28.39);
  assert.equal(t.payload['state'], '83.1');
  assert.equal(t.observedAt, '2026-09-23T19:56:01.000Z');
  assert.deepEqual([t.position?.latitude, t.position?.longitude], [21.3069, -157.8583]);
  // old_state is nowhere in what was emitted.
  assert.doesNotMatch(JSON.stringify(obs), /82\.4/);
  assert.equal(h.provider.stats.refused - refusedBefore, 2);

  const w = await harness('weather');
  await w.poll();
  await w.subscribe();
  w.goLive();
  for (const m of SESSION.slice(3)) w.serve(m);
  assert.deepEqual(
    w.flat().map((o) => [o.externalId, o.payload['temperatureC'], o.payload['condition']]),
    [['weather.forecast_home', 29.44, 'sunny']],
  );
});

test('home-assistant: a removed entity leaves the next snapshot, which the socket keeps current without asking again', async () => {
  const h = await harness('zones');
  assert.equal((await h.poll()).length, 2);
  await h.subscribe();
  h.goLive();
  // The subscription may have missed events: the next poll reads /api/states once more …
  await h.poll();
  assert.equal(h.ctx.http.requests.length, 2);
  for (const m of SESSION.slice(3)) h.serve(m);
  // … and after that a poll answers from the states the socket keeps.
  const next = await h.poll();
  assert.equal(h.ctx.http.requests.length, 2);
  assert.equal(h.provider.stats.memoryAnswers, 1);
  assert.deepEqual(
    next.map((o) => o.externalId),
    ['zone.home'],
  );
  // Every ten minutes /api/states is read again anyway.
  h.timers.advance(HA_RESYNC_MS);
  h.serve({ id: 99, type: 'pong' });
  await h.poll();
  assert.equal(h.ctx.http.requests.length, 3);
});

test('home-assistant: auth_invalid stops the socket for good — no reconnect, AUTH_REQUIRED', async () => {
  const h = await harness('sensors');
  await h.subscribe();
  h.socket().simulateOpen();
  for (const m of AUTH_INVALID) h.serve(m);
  assert.equal(h.provider.socketStatus, 'auth-failed');
  assert.ok(h.socket().closed);
  const health = await h.provider.health();
  assert.equal(health.status, 'AUTH_REQUIRED');
  assert.match(health.message ?? '', /Home Assistant refused the token: Invalid access token or password/);
  h.timers.advance(60 * 60_000);
  assert.equal(h.sockets.opened.length, 1, 'a refused token is not tried again');
  assert.deepEqual(
    h.frames().map((f) => f['type']),
    ['auth'],
  );
});

test('home-assistant: a dropped socket goes OFFLINE, reconnects with back-off and resubscribes', async () => {
  const h = await harness('sensors');
  await h.subscribe();
  h.goLive();
  h.socket().simulateClose(1006, 'gone');
  assert.equal(h.provider.socketStatus, 'waiting');
  assert.equal((await h.provider.health()).status, 'OFFLINE');
  h.timers.advance(1_999);
  assert.equal(h.sockets.opened.length, 1);
  h.timers.advance(1);
  assert.equal(h.sockets.opened.length, 2);
  await settle();
  h.goLive(1);
  assert.deepEqual(
    h.frames(1).map((f) => f['type']),
    ['auth', 'subscribe_events'],
  );
  assert.equal(h.provider.socketStatus, 'live');
  // A live subscription resets the back-off; failures in a row double it.
  h.socket(1).simulateError(new Error('ECONNRESET'));
  h.timers.advance(2_000);
  assert.equal(h.sockets.opened.length, 3);
  await settle();
  h.socket(2).simulateClose(1006, 'refused');
  h.timers.advance(3_999);
  assert.equal(h.sockets.opened.length, 3);
  h.timers.advance(1);
  assert.equal(h.sockets.opened.length, 4);
  // Frames of a connection that is gone are ignored.
  h.serve(SESSION[3], 0);
  assert.equal(h.flat().length, 0);
});

test('home-assistant: pings a live socket and drops one that goes quiet; an unanswered auth is dropped too', async () => {
  const h = await harness('sensors');
  await h.subscribe();
  h.goLive();
  h.timers.advance(HA_PING_MS);
  assert.deepEqual(h.frames().at(-1), { id: 2, type: 'ping' });
  h.serve({ id: 2, type: 'pong' });
  h.timers.advance(HA_PING_MS);
  assert.deepEqual(h.frames().at(-1), { id: 3, type: 'ping' });
  // No answer at all: the first tick past HA_SILENCE_MS drops it (before the reconnect is due).
  h.timers.advance(2 * HA_PING_MS);
  assert.deepEqual(h.frames().at(-1), { id: 4, type: 'ping' });
  assert.ok(2 * HA_PING_MS + HA_PING_MS > HA_SILENCE_MS);
  assert.ok(h.socket(0).closed);
  assert.equal(h.provider.socketStatus, 'waiting');
  assert.match((await h.provider.health()).message ?? '', /no answer from Home Assistant/);

  const a = await harness('sensors');
  await a.subscribe();
  a.socket().simulateOpen();
  a.timers.advance(HA_AUTH_TIMEOUT_MS);
  assert.ok(a.socket(0).closed);
  assert.match((await a.provider.health()).message ?? '', /did not answer the auth frame/);
});

test('home-assistant: malformed and unknown messages are ignored; cancelling closes the socket', async () => {
  const h = await harness('sensors');
  await h.subscribe();
  h.goLive();
  for (const m of [
    'not json',
    '{"type":"event","id":1}',
    '[1,2]',
    '{"id":1,"type":"event","event":{"event_type":"state_changed","data":{"entity_id":"sensor.x","new_state":{"state":5}}}}',
  ])
    h.socket().simulateMessage(m);
  h.serve({ type: 'something_new' });
  assert.equal(h.flat().length, 0);
  assert.equal((await h.provider.health()).status, 'LIVE');
  assert.ok(h.provider.stats.malformed >= 3);
  h.abort.abort();
  assert.ok(h.socket().closed);
  assert.equal(h.provider.socketStatus, 'idle');
});

test('home-assistant: a socket the host will not open leaves the REST path running and is asked for much later', async () => {
  const h = await harness('zones', {
    refuseSocket: new ProviderError('HOST_NOT_ALLOWED', 'websocket host not allowed (wss only, allowlisted hosts)', {
      retryable: false,
    }),
  });
  await h.subscribe();
  assert.equal(h.provider.socketStatus, 'refused');
  assert.equal((await h.poll()).length, 2);
  const health = await h.provider.health();
  assert.equal(health.status, 'LIVE');
  assert.match(health.message ?? '', /WebSocket API is not available here \(websocket host not allowed/);
  assert.equal(h.provider.stats.reconnects, 0);
  h.timers.advance(HA_REFUSED_RETRY_MS);
  assert.equal(h.provider.stats.reconnects, 1);
});

test('home-assistant: a new address closes the socket, forgets what was read and connects there', async () => {
  const h = await harness('zones');
  await h.poll();
  await h.subscribe();
  h.goLive();
  h.ctx.settings.update({ host: '10.0.0.5' });
  assert.ok(h.socket(0).closed);
  h.timers.advance(0);
  assert.equal(h.sockets.opened.length, 2);
  assert.equal(h.sockets.opened[1]!.url, 'ws://10.0.0.5:8123/api/websocket');
  await h.poll();
  assert.equal(h.ctx.http.requests.at(-1)!.url, 'http://10.0.0.5:8123/api/states');
});

test('home-assistant: the socket answers only frames of its own subscription and connection', async () => {
  const h = await harness('sensors');
  await h.poll();
  await h.subscribe();
  // Events before the subscription is confirmed are not taken.
  h.socket().simulateOpen();
  h.serve(SESSION[1]);
  h.serve(SESSION[3]);
  assert.equal(h.flat().length, 0);
  h.serve({ id: 1, type: 'result', success: true, result: null });
  h.serve({ ...SESSION[3], id: 7 });
  assert.equal(h.flat().length, 0);
  h.serve(SESSION[3]);
  assert.equal(h.flat().length, 1);
  await settle();
});

// ---------------------------------------------------------------------------------------
// Entities.

test('home-assistant entities: states are checked before anything reads them', () => {
  assert.equal(typeof readState(null), 'string');
  assert.equal(typeof readState({ entity_id: 'Sensor.X', state: '1' }), 'string');
  assert.equal(typeof readState({ entity_id: 'sensor.x', state: 1 }), 'string');
  assert.equal(typeof readState({ entity_id: 'sensor.x', state: '1', attributes: [] }), 'string');
  assert.deepEqual(readState({ entity_id: 'sensor.x', state: '1' }), {
    entity_id: 'sensor.x',
    state: '1',
    attributes: {},
  });
});

test('home-assistant entities: patterns and positions are parsed strictly and capped', () => {
  const sel = parseSelectors('sensor.*, weather.home zone.*;binary_sensor.door_?');
  assert.deepEqual(
    sel.items.map((s) => s.source),
    ['sensor.*', 'weather.home', 'zone.*'],
  );
  assert.equal(sel.problems.length, 1);
  assert.ok(matches(sel.items[0]!, 'sensor.outdoor_temperature'));
  assert.ok(!matches(sel.items[0]!, 'sensorx.outdoor'));
  assert.ok(!matches(sel.items[2]!, 'zone.home.extra'));
  assert.ok(matches({ source: 's*r.*_t*e' }, 'sensor.outdoor_temperature'));
  assert.ok(!matches({ source: 's*r.*_t*x' }, 'sensor.outdoor_temperature'));
  assert.ok(matches({ source: '*.*' }, 'a.b'));
  // Many stars cost nothing: no regular expression, no backtracking (a regex took ~50 s here).
  const nasty = parseSelectors('************x.*');
  assert.equal(nasty.items[0]!.source, '*x.*');
  const started = Date.now();
  for (let i = 0; i < 1000; i++)
    matches({ source: '*a*a*a*a*a*a*a*a*a*a*a*a*x.*' }, 'binary_sensor_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.foo');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  const many = parseSelectors(Array.from({ length: MAX_SELECTORS + 5 }, (_, i) => `sensor.s${i}`).join(','));
  assert.equal(many.items.length, MAX_SELECTORS);
  assert.match(many.problems.join(), /more than 64/);
  assert.match(parseSelectors('x'.repeat(20_000)).problems.join(), /longer than/);

  const pos = parsePositions('sensor.a=21.3,-157.8; sensor.b = zone.home\nsensor.c=91,0;sensor.d=abc;sensor.e=1,2,3');
  assert.deepEqual(
    pos.items.map((p) => p.target),
    [
      { kind: 'fixed', lat: 21.3, lon: -157.8 },
      { kind: 'zone', zone: 'zone.home' },
    ],
  );
  assert.equal(pos.problems.length, 3);
  const lots = parsePositions(Array.from({ length: MAX_POSITIONS + 1 }, (_, i) => `sensor.p${i}=1,1`).join(';'));
  assert.equal(lots.items.length, MAX_POSITIONS);
});

test('home-assistant entities: units are converted to SI through the transform registry, never guessed', () => {
  assert.deepEqual(toSi(212, '°F'), { value: 100, unit: '°C' });
  assert.deepEqual(toSi(273.15, 'K', { temperature: true }), { value: 0, unit: '°C' });
  assert.equal(toSi(2700, 'K'), undefined, 'a colour temperature stays in kelvin');
  assert.deepEqual(toSi(101.3, 'kPa'), { value: 1013, unit: 'hPa' });
  assert.deepEqual(toSi(14.7, 'psi'), { value: 1013.529, unit: 'hPa' });
  assert.deepEqual(toSi(36, 'km/h'), { value: 10, unit: 'm/s' });
  assert.deepEqual(toSi(10, 'kn'), { value: 5.144, unit: 'm/s' });
  assert.deepEqual(toSi(30, 'inHg'), { value: 1015.9, unit: 'hPa' });
  assert.deepEqual(toSi(1, 'in'), { value: 25.4, unit: 'mm' });
  assert.deepEqual(toSi(2, 'km'), { value: 2000, unit: 'm' });
  assert.equal(toSi(5, 'furlong'), undefined);
  const home: HaState = { entity_id: 'zone.home', state: '0', attributes: { latitude: 21.3, longitude: -157.8 } };
  const r = enrich(
    { entity_id: 'sensor.mystery', state: '12', attributes: { unit_of_measurement: 'widgets' } },
    { positions: [], stateOf: (id) => (id === 'zone.home' ? home : undefined) },
  );
  assert.deepEqual(r['_si'], { value: 12, unit: 'widgets' });
  assert.deepEqual(r['_home'], [21.3, -157.8]);
  assert.equal(r['_position'], undefined);
  const w = enrich(
    { entity_id: 'weather.x', state: 'sunny', attributes: { temperature: 20, pressure: 1000, pressure_unit: 'hPa' } },
    { positions: [], stateOf: () => undefined },
  );
  // No temperature_unit: the temperature is not converted, or kept under a unit it may not have.
  assert.deepEqual(w['_si'], { pressureHpa: 1000 });
  const nul = enrich(
    { entity_id: 'sensor.gps', state: '1', attributes: { latitude: 0, longitude: 0 } },
    { positions: [], stateOf: () => undefined },
  );
  assert.equal(nul['_position'], undefined, '0,0 is no position');
});

// ---------------------------------------------------------------------------------------
// Races, recovery and the edges an independent review found.

test('home-assistant: socket changes that arrive while /api/states is in flight are not undone by its answer', async () => {
  let release: (() => void) | undefined;
  const h = await harness('sensors', {
    responder: () =>
      new Promise<testing.FixtureResponse>((resolve) => {
        release = () => resolve({ status: 200, body: STATES });
      }),
  });
  await h.subscribe();
  h.goLive();
  const read = h.poll();
  await settle();
  // While the read is out: the temperature changes, and the power meter goes away.
  h.serve(SESSION[3]);
  h.serve({
    id: 1,
    type: 'event',
    event: { event_type: 'state_changed', data: { entity_id: 'sensor.house_power', old_state: null, new_state: null } },
  });
  release!();
  const obs = await read;
  const t = obs.find((o) => o.externalId === 'sensor.outdoor_temperature')!;
  assert.equal(t.payload['state'], '83.1', 'the event is newer than the answer');
  assert.equal(
    obs.find((o) => o.externalId === 'sensor.house_power'),
    undefined,
  );
  // And the socket keeps that on the next memory answer.
  const next = await h.poll();
  assert.equal(next.find((o) => o.externalId === 'sensor.outdoor_temperature')!.payload['state'], '83.1');
});

test('home-assistant: a read still in flight when the address changes is not kept; the new address is read', async () => {
  let release: (() => void) | undefined;
  const h = await harness('zones', {
    responder: (req) =>
      req.url.startsWith('http://127.0.0.1')
        ? new Promise<testing.FixtureResponse>((resolve) => {
            release = () => resolve({ status: 200, body: STATES });
          })
        : {
            status: 200,
            body: JSON.stringify((JSON.parse(STATES) as HaState[]).filter((s) => s.entity_id === 'zone.home')),
          },
  });
  const read = h.poll();
  await settle();
  h.ctx.settings.update({ host: '10.0.0.5' });
  release!();
  const obs = await read;
  assert.deepEqual(
    h.ctx.http.requests.map((r) => r.url),
    ['http://127.0.0.1:8123/api/states', 'http://10.0.0.5:8123/api/states'],
  );
  assert.deepEqual(
    obs.map((o) => o.externalId),
    ['zone.home'],
  );
});

test('home-assistant: a failure of the old address after a move is not charged to the new one', async () => {
  let fail: (() => void) | undefined;
  const h = await harness('zones', {
    responder: (req) =>
      req.url.startsWith('http://127.0.0.1')
        ? new Promise<testing.FixtureResponse>((resolve) => {
            fail = () => resolve({ status: 401 });
          })
        : { status: 200, body: STATES },
  });
  const read = h.poll();
  await settle();
  h.ctx.settings.update({ host: '10.0.0.5' });
  fail!();
  assert.equal((await read).length, 2);
  assert.equal(h.ctx.http.requests.at(-1)!.url, 'http://10.0.0.5:8123/api/states');
  assert.equal((await h.provider.health()).status, 'LIVE');
});

test('home-assistant: a socket stopped by an auth failure tries once more after /api/states accepts the token', async () => {
  const h = await harness('zones', { settings: { tls: true } });
  await h.subscribe();
  h.socket().simulateOpen();
  for (const m of AUTH_INVALID) h.serve(m);
  assert.equal(h.provider.socketStatus, 'auth-failed');
  assert.equal((await h.provider.health()).status, 'AUTH_REQUIRED');
  // The operator stores the right token: REST works, and health no longer blames the old one.
  await h.poll();
  assert.equal((await h.provider.health()).status, 'LIVE');
  h.timers.advance(0);
  assert.equal(h.sockets.opened.length, 2);
  await settle();
  // Refused again: that is final, however many polls succeed.
  h.socket(1).simulateOpen();
  for (const m of AUTH_INVALID) h.serve(m, 1);
  await h.poll();
  h.timers.advance(60 * 60_000);
  assert.equal(h.sockets.opened.length, 2);
  const health = await h.provider.health();
  assert.equal(health.status, 'LIVE');
  assert.match(health.message ?? '', /the WebSocket API refused the token/);
});

test('home-assistant: zones say where they are, never who is in them or when that changed', async () => {
  const states = (JSON.parse(STATES) as Array<Record<string, unknown>>).map((s) =>
    s['entity_id'] === 'zone.home'
      ? { ...s, state: '2', attributes: { ...(s['attributes'] as object), persons: ['person.alex', 'person.sam'] } }
      : s,
  );
  const h = await harness('zones', { responder: () => ({ status: 200, body: JSON.stringify(states) }) });
  const obs = await h.poll();
  const home = obs.find((o) => o.externalId === 'zone.home')!;
  assert.doesNotMatch(JSON.stringify(obs), /person\.|alex|sam/i);
  assert.equal(home.observedAt, new Date(NOW).toISOString(), 'the time of the read, not of an arrival');
  assert.deepEqual(home.quality.flags, ['fetch-time']);
  const rec = readState(states.find((s) => s['entity_id'] === 'zone.home'));
  assert.ok(typeof rec !== 'string');
  assert.equal(rec.state, '');
  assert.equal(rec.attributes['persons'], undefined);
  assert.equal(rec.last_updated, undefined);
  // Someone arriving changes nothing a zone says: no event is emitted for it.
  await h.subscribe();
  h.goLive();
  const zone = states.find((s) => s['entity_id'] === 'zone.home')!;
  h.serve({
    id: 1,
    type: 'event',
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: 'zone.home',
        old_state: zone,
        new_state: { ...zone, state: '3', attributes: { ...(zone['attributes'] as object), persons: ['person.x'] } },
      },
    },
  });
  assert.equal(h.flat().length, 0);
  // A zone that really changed (its radius) is emitted.
  h.serve({
    id: 1,
    type: 'event',
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: 'zone.home',
        old_state: zone,
        new_state: { ...zone, attributes: { ...(zone['attributes'] as object), radius: 150 } },
      },
    },
  });
  assert.deepEqual(
    h.flat().map((o) => o.payload['radiusM']),
    [150],
  );
});

test('home-assistant: an Entities setting with no valid pattern shows nothing, and says so', async () => {
  const h = await harness('sensors', { settings: { entities: 'sensor.outdoor-*' } });
  assert.deepEqual(await h.poll(), []);
  assert.match((await h.provider.health()).message ?? '', /no valid pattern in Entities, so nothing is shown/);
});

test('home-assistant: states beyond the entity cap are counted, not silently dropped; refused ids stay out of messages', async () => {
  const many = Array.from({ length: HA_MAX_ENTITIES + 3 }, (_, i) => ({
    entity_id: `sensor.s${i}`,
    state: '1',
    attributes: {},
  }));
  const h = await harness('zones', {
    responder: () => ({
      status: 200,
      body: JSON.stringify([...(JSON.parse(STATES) as unknown[]).slice(0, 2), ...many]),
    }),
  });
  await h.poll();
  assert.match((await h.provider.health()).message ?? '', /5 states beyond the 50000-entity cap not kept/);
  const bad = await harness('zones', {
    responder: () => ({
      status: 200,
      body: '[{"entity_id":"sensor.a","state":1},{"entity_id":"device_tracker.alex_phone","state":2}]',
    }),
  });
  await assert.rejects(
    bad.poll(),
    (e: unknown) => e instanceof ProviderError && e.code === 'MALFORMED' && !/alex/.test(e.message),
  );
  assert.equal(typeof readState({ entity_id: 'device_tracker.alex_phone', state: 5 }), 'string');
  assert.doesNotMatch(String(readState({ entity_id: 'device_tracker.alex_phone', state: 5 })), /alex/);
});

// ---------------------------------------------------------------------------------------
// Last: what this file's providers sent, all together.

test('home-assistant: no frame other than auth, subscribe_events and ping is ever sent, and no request but GET /api/states', () => {
  const everyFrame = everySockets.flatMap((s) =>
    s.opened.flatMap((o) => o.handle.sent.map((f) => (typeof f === 'string' ? f : new TextDecoder().decode(f)))),
  );
  assert.ok(everyFrame.length > 20, `only ${everyFrame.length} frames were seen`);
  const types = new Set(everyFrame.map((f) => (JSON.parse(f) as { type: string }).type));
  for (const t of types) assert.ok((HA_ALLOWED_FRAMES as readonly string[]).includes(t), `sent a "${t}" frame`);
  assert.deepEqual([...types].sort(), ['auth', 'ping', 'subscribe_events']);
  for (const f of everyFrame) {
    const frame = JSON.parse(f) as Record<string, unknown>;
    if (frame['type'] !== 'auth')
      assert.doesNotMatch(f, new RegExp(TOKEN), 'the token only ever goes in the auth frame');
    if (frame['type'] === 'subscribe_events') assert.equal(frame['event_type'], 'state_changed');
  }
  assert.ok(everyRequest.length > 10);
  for (const r of everyRequest) {
    assert.equal(r.method ?? 'GET', 'GET');
    assert.equal(r.body, undefined);
    assert.match(new URL(r.url).pathname, /^\/api\/states$/);
  }
});
