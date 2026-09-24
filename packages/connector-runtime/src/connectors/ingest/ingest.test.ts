import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProviderError,
  manifestSchema,
  testing,
  type LocalListenerHandler,
  type LocalListenerOptions,
  type LocalResponse,
} from '@worldview/provider-sdk';
import { observationSchema, type JsonValue, type Observation } from '@worldview/world-model';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { loadSidecar } from '@worldview/tool-connector-validator';
import { defaultConnectorRegistry } from '../../registry.js';
import { runConnectorSuite } from '../../testing/suite.js';
import {
  HttpIngestProvider,
  INGEST_DEFAULT_PORT,
  INGEST_SCHEMA_ID,
  ingestManifest,
  ingestPath,
  listenerConfigOf,
  parseEnvelope,
  validateHttpIngest,
} from './index.js';

/**
 * `http-ingest` over the SDK's fixture listener (`testing.FixtureLocalAccess.listen` and
 * `simulateRequest`), which applies the same admission rules as the app's listener
 * (`ListenerGate`: path, method, bearer token, size, rate). The app's listener itself — the
 * 127.0.0.1 bind, the Host check, the socket — is tested where it lives, in
 * `packages/runtime/src/support/local-listener.test.ts`.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const examplesDir = path.join(root, 'connectors', 'examples', 'ingest', 'awaiting-amendments');
const EXAMPLES = ['node-red-weather-stations.json', 'pi-soil-sensors.json'];
const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const TOKEN = 'correct-horse-battery-staple-0123456789';
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'connectors', 'ingest', name), 'utf8');

function definitionOf(name: string): ConnectorProviderDefinition {
  const doc = JSON.parse(readFileSync(path.join(examplesDir, name), 'utf8')) as unknown;
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok && v.definition, `${name}: ${v.errors.join('; ')}`);
  return v.definition;
}
const weather = () => definitionOf('node-red-weather-stations.json');
const tokenKey = (d: ConnectorProviderDefinition) => Object.values(d.credentials!)[0]!.secretRef;

interface Rig {
  provider: HttpIngestProvider;
  ctx: testing.FixtureContext;
  local: testing.FixtureLocalAccess;
  emitted: Observation[][];
  abort: AbortController;
  post: (
    body: string,
    extra?: { token?: string; path?: string; method?: string; ua?: string },
  ) => Promise<LocalResponse>;
}

async function rig(
  definition: ConnectorProviderDefinition,
  opts: { settings?: Record<string, JsonValue>; tokenStored?: boolean; local?: testing.FixtureLocalAccess } = {},
): Promise<Rig> {
  const local = opts.local ?? new testing.FixtureLocalAccess();
  local.now = () => NOW;
  if (opts.tokenStored !== false) local.listenerSecrets[tokenKey(definition)] = TOKEN;
  const provider = defaultConnectorRegistry.createProvider(definition) as HttpIngestProvider;
  const ctx = testing.createFixtureContext({
    providerId: definition.id,
    clock: new testing.VirtualClock(NOW),
    credentials: opts.tokenStored === false ? [] : [tokenKey(definition)],
    settings: opts.settings ?? {},
    local,
  });
  await provider.initialize(ctx);
  await provider.start();
  const emitted: Observation[][] = [];
  const abort = new AbortController();
  await provider.subscribe!({ signal: abort.signal }, (obs, meta) => {
    assert.equal(meta?.snapshot, false, 'an ingest push is a delta');
    emitted.push(obs);
  });
  const post: Rig['post'] = (body, extra = {}) =>
    local.simulateRequest({
      body,
      token: extra.token ?? TOKEN,
      ...(extra.path ? { path: extra.path } : {}),
      ...(extra.method ? { method: extra.method } : {}),
      headers: { 'content-type': 'application/json', ...(extra.ua ? { 'user-agent': extra.ua } : {}) },
    });
  return { provider, ctx, local, emitted, abort, post };
}
const json = (r: LocalResponse) => JSON.parse(String(r.body)) as Record<string, unknown>;

// ── The examples, with their sidecar fixtures, through the listener ──────────────────────

for (const name of EXAMPLES) {
  test(`listener checks: ${name} with its sidecar fixtures`, async () => {
    const definition = definitionOf(name);
    const sidecar = loadSidecar(path.join(examplesDir, name.replace(/\.json$/, '.test.json')), root);
    const normal = Array.isArray(sidecar.normal) ? sidecar.normal : [sidecar.normal];

    // Successful parse: 202 with counts, observations emitted as a delta, valid and attributed.
    const r = await rig(definition);
    for (const body of normal) assert.equal((await r.post(body)).status, 202);
    const observations = r.emitted.flat();
    assert.equal(observations.length, sidecar.expectObservations);
    for (const id of sidecar.expectIds ?? [])
      assert.ok(
        observations.some((o) => o.externalId === id),
        id,
      );
    for (const o of observations) {
      const parsed = observationSchema.parse(o);
      assert.ok(parsed.ok, `${o.id}: ${parsed.ok ? '' : parsed.issues[0]?.message}`);
      assert.equal(o.objectType, definition.objectType);
      assert.equal(o.provenance.attribution, r.provider.manifest.attribution.text);
    }
    // The sidecar's per-observation expectations, compared as connector:test compares them.
    assert.equal(sidecar.verify?.(observations), undefined);

    // Empty: accepted, nothing emitted.
    const empty = await rig(definition);
    const emptyAnswer = await empty.post(sidecar.empty);
    assert.equal(emptyAnswer.status, 202);
    assert.equal(json(emptyAnswer).accepted, 0);
    assert.equal(empty.emitted.flat().length, 0);

    // Malformed: each one 400 with a reason, nothing emitted.
    const bad = await rig(definition);
    for (const [i, body] of sidecar.malformed.entries()) {
      const a = await bad.post(body);
      assert.equal(a.status, 400, `malformed[${i}] answered ${a.status}: ${String(a.body)}`);
      assert.ok(typeof json(a).error === 'string' && String(json(a).error).length > 0);
    }
    assert.equal(bad.emitted.flat().length, 0);

    // Wrong token, and no token: 401 before the provider is asked.
    const auth = await rig(definition);
    assert.equal((await auth.post(normal[0]!, { token: 'not-the-token' })).status, 401);
    assert.equal(auth.provider.stats.pushes + auth.provider.stats.refusedBodies, 0);
    assert.equal(auth.emitted.length, 0);

    // Cancellation: aborting the subscription closes the listener and frees the slot.
    const c = await rig(definition);
    c.abort.abort();
    await new Promise((res) => setImmediate(res));
    assert.equal(c.local.listener?.closed, true);
    await assert.rejects(c.post(normal[0]!), /nothing is listening/);
    await c.local.listen({ port: INGEST_DEFAULT_PORT + 1, path: '/x', credential: { key: 'k' } }, () => ({
      status: 204,
    }));
  });
}

test('the frozen shared suite passes every check it can drive on the ingest examples (the rest wait for A1)', async () => {
  const drivable = new Set(['Config validation', 'Missing fields', 'Attribution', 'Data policy', 'Rate policy']);
  for (const name of EXAMPLES) {
    const doc = JSON.parse(readFileSync(path.join(examplesDir, name), 'utf8')) as unknown;
    const sidecar = loadSidecar(path.join(examplesDir, name.replace(/\.json$/, '.test.json')), root);
    const result = await runConnectorSuite(doc, sidecar, defaultConnectorRegistry);
    for (const c of result.checks.filter((x) => drivable.has(x.name)))
      assert.ok(c.passed, `${name}: ${c.name}: ${c.detail}`);
  }
});

// ── Caps and refusals ───────────────────────────────────────────────────────────────────

test('an oversized body is refused 413 before the provider reads it', async () => {
  const r = await rig(weather(), { settings: { maxBodyBytes: 2048 } });
  const a = await r.post(fixture('weather-stations-oversized.json'));
  assert.equal(a.status, 413);
  assert.equal(r.provider.stats.pushes + r.provider.stats.refusedBodies, 0);
  assert.equal(r.emitted.length, 0);
  assert.equal(
    (await r.post(fixture('weather-stations-envelope.json'))).status,
    202,
    'a body under the cap still goes through',
  );
});

test('past maxRequestsPerMinute the pusher gets 429 with a Retry-After', async () => {
  const r = await rig(weather(), { settings: { maxRequestsPerMinute: 2 } });
  const body = fixture('weather-stations-empty.json');
  assert.equal((await r.post(body)).status, 202);
  assert.equal((await r.post(body)).status, 202);
  const third = await r.post(body);
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers?.['Retry-After']) >= 1);
});

test('another path is 404 and another method 405, before the provider is asked', async () => {
  const r = await rig(weather());
  const body = fixture('weather-stations-envelope.json');
  assert.equal((await r.post(body, { path: '/ingest/someone-else' })).status, 404);
  assert.equal((await r.post(body, { method: 'GET' })).status, 405);
  assert.equal((await r.post(body, { method: 'OPTIONS' })).status, 405);
  assert.equal(r.provider.stats.pushes, 0);
});

test('a push where no record maps is 400 with the reasons; a partly good push is 202 with the rejections counted', async () => {
  const r = await rig(weather());
  const none = await r.post(fixture('weather-stations-unmappable.json'));
  assert.equal(none.status, 400);
  assert.equal(json(none).rejected, 2);
  assert.ok(Array.isArray(json(none).reasons));
  const mixed = await r.post(
    JSON.stringify({
      schema: INGEST_SCHEMA_ID,
      source: 'node-red-weather-stations',
      records: [{ station: 'ok-1', lat: 21.3, lon: -157.8, time: '2026-09-23T19:00:00Z' }, { station: 'no-position' }],
    }),
  );
  assert.equal(mixed.status, 202);
  assert.deepEqual([json(mixed).accepted, json(mixed).rejected], [1, 1]);
  assert.equal(r.emitted.flat().length, 1);
});

test('a record without observedAt carries the receipt time, flagged, and the answer says how many', async () => {
  const r = await rig(definitionOf('pi-soil-sensors.json'));
  const a = await r.post(fixture('soil-sensors-array.json'));
  assert.equal(a.status, 202);
  assert.deepEqual([json(a).accepted, json(a).rejected, json(a).timedAtReceipt], [3, 1, 2]);
  const bed1 = r.emitted.flat().find((o) => o.externalId === 'bed-1')!;
  assert.equal(bed1.observedAt, new Date(NOW).toISOString());
  assert.deepEqual(bed1.quality.flags, ['fetch-time']);
});

test('a record timed in the future is rejected, not emitted', async () => {
  const r = await rig(weather());
  const a = await r.post(
    JSON.stringify({
      schema: INGEST_SCHEMA_ID,
      source: 'node-red-weather-stations',
      records: [
        { station: 'late', lat: 21.3, lon: -157.8, time: '2026-09-23T19:59:00Z' },
        { station: 'early', lat: 21.3, lon: -157.8, time: '2026-09-24T20:00:00Z' },
      ],
    }),
  );
  assert.equal(a.status, 202);
  assert.deepEqual([json(a).accepted, json(a).rejected], [1, 1]);
});

// ── The listener the provider asks for ─────────────────────────────────────────────────

/** Local access that records every listen call and hands it to the fixture. */
function recordingLocal(fail?: ProviderError): { local: testing.FixtureLocalAccess; calls: LocalListenerOptions[] } {
  const local = new testing.FixtureLocalAccess();
  const calls: LocalListenerOptions[] = [];
  const listen = local.listen.bind(local);
  local.listen = async (options: LocalListenerOptions, handler: LocalListenerHandler) => {
    calls.push(options);
    if (fail) throw fail;
    return listen(options, handler);
  };
  return { local, calls };
}

test('the provider names only a port and its own path: no address, the token by key, never the value', async () => {
  const { local, calls } = recordingLocal();
  const d = weather();
  await rig(d, { local });
  assert.equal(calls.length, 1);
  const o = calls[0]!;
  assert.deepEqual(Object.keys(o).sort(), [
    'credential',
    'maxBodyBytes',
    'maxRequestsPerMinute',
    'path',
    'port',
    'signal',
  ]);
  assert.equal(o.port, INGEST_DEFAULT_PORT);
  assert.equal(o.path, '/ingest/node-red-weather-stations');
  assert.deepEqual(o.credential, { key: 'ingest.node-red-weather-stations.token' });
  assert.ok(!JSON.stringify({ ...o, signal: undefined }).includes(TOKEN));
});

test('the handler never sees the Authorization header or the token', async () => {
  const { local } = recordingLocal();
  const r = await rig(weather(), { local });
  let seen: Record<string, string> | undefined;
  const handler = local.listener!.handler;
  local.listener!.handler = (req) => {
    seen = req.headers;
    return handler(req);
  };
  await r.post(fixture('weather-stations-envelope.json'));
  assert.ok(seen);
  assert.equal(seen.authorization, undefined);
  assert.ok(!JSON.stringify(seen).includes(TOKEN));
});

test('changing the port setting moves the listener; a bad port setting is refused with the reason', async () => {
  const { local, calls } = recordingLocal();
  const r = await rig(weather(), { local, settings: { port: 47400 } });
  assert.equal(r.provider.listening?.port, 47400);
  r.ctx.settings.update({ port: 47401 });
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(calls.length, 2);
  assert.equal(r.provider.listening?.port, 47401);
  assert.equal((await r.post(fixture('weather-stations-envelope.json'))).status, 202);
  r.ctx.settings.update({ port: 80 });
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(calls.length, 2, 'a refused setting does not close the working listener');
  assert.equal(r.provider.listening?.port, 47401);
  assert.throws(() => listenerConfigOf(weather(), { port: 80 }), /setting "port" is 80/);
  assert.throws(() => listenerConfigOf(weather(), { maxBodyBytes: 64 * 1024 * 1024 }), /maxBodyBytes/);
  assert.equal(listenerConfigOf(weather(), { port: '47500' }).port, 47500);
});

test('a port in use fails the subscription with the port named, and health says so', async () => {
  const { local } = recordingLocal(new ProviderError('NETWORK', 'port 47311 is already in use on 127.0.0.1'));
  const provider = defaultConnectorRegistry.createProvider(weather()) as HttpIngestProvider;
  const ctx = testing.createFixtureContext({
    providerId: 'node-red-weather-stations',
    clock: new testing.VirtualClock(NOW),
    credentials: [tokenKey(weather())],
    local,
  });
  await provider.initialize(ctx);
  await provider.start();
  await assert.rejects(
    provider.subscribe!({ signal: new AbortController().signal }, () => undefined),
    (err) => {
      return err instanceof ProviderError && err.code === 'NETWORK' && /47311/.test(err.message);
    },
  );
  const h = await provider.health();
  assert.equal(h.status, 'ERROR');
  assert.match(h.message ?? '', /already in use/);
});

test('a subscription cancelled while its port is opening closes the listener it gets', async () => {
  const local = new testing.FixtureLocalAccess();
  const listen = local.listen.bind(local);
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  local.listen = async (options: LocalListenerOptions, handler: LocalListenerHandler) => {
    await gate;
    return listen(options, handler);
  };
  const provider = defaultConnectorRegistry.createProvider(weather()) as HttpIngestProvider;
  const ctx = testing.createFixtureContext({ providerId: 'node-red-weather-stations', local });
  await provider.initialize(ctx);
  await provider.start();
  const abort = new AbortController();
  const subscribing = provider.subscribe!({ signal: abort.signal }, () => undefined);
  await new Promise((res) => setImmediate(res));
  abort.abort();
  release();
  await subscribing.catch(() => undefined);
  assert.equal(local.listener?.closed, true, 'the listener that opened after the cancel is closed');
  assert.equal(provider.listening, undefined);
});

test('a host without a listener refuses with UNSUPPORTED', async () => {
  const local = new testing.FixtureLocalAccess();
  // A host that offers no listener: the method is simply not there (a remote source's context).
  Object.defineProperty(local, 'listen', { value: undefined });
  const provider = defaultConnectorRegistry.createProvider(weather());
  const ctx = testing.createFixtureContext({ providerId: 'node-red-weather-stations', local });
  await provider.initialize(ctx);
  await provider.start();
  await assert.rejects(
    provider.subscribe!({ signal: new AbortController().signal }, () => undefined),
    /no loopback listener/,
  );
});

test('stop closes the listener; a second subscription replaces the first', async () => {
  const r = await rig(weather());
  const first = r.local.listener!;
  await r.provider.subscribe!({ signal: new AbortController().signal }, () => undefined);
  assert.equal(first.closed, true);
  assert.equal(r.local.listener!.closed, false);
  await r.provider.stop();
  assert.equal(r.local.listener!.closed, true);
  assert.equal((await r.provider.health()).status, 'DISABLED');
});

test('health: waiting, then the last push and the pusher, the refusals, and a missing token', async () => {
  const r = await rig(weather());
  let h = await r.provider.health();
  assert.equal(h.status, 'STARTING');
  assert.match(h.message!, /listening on 127\.0\.0\.1:47311\/ingest\/node-red-weather-stations; no push yet/);
  await r.post(fixture('weather-stations-envelope.json'), { ua: 'Node-RED/4.0.2 (http request)' });
  await r.post(fixture('weather-stations-envelope.json'), { token: 'wrong' });
  h = await r.provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(h.message!, /from Node-RED\/4\.0\.2 \(http request\): 3 accepted, 0 rejected/);
  assert.match(h.message!, /refused before the source: 401×1/);
  assert.equal(h.objectCount, 3);
  assert.equal(h.lastSuccess, new Date(NOW).toISOString());

  const noToken = await rig(weather(), { tokenStored: false });
  h = await noToken.provider.health();
  assert.equal(h.status, 'AUTH_REQUIRED');
  assert.equal(h.credentialState, 'missing');
  assert.equal((await noToken.post(fixture('weather-stations-envelope.json'))).status, 401);
});

test('a user agent with control characters is cleaned and shortened for health', async () => {
  const r = await rig(weather());
  await r.post(fixture('weather-stations-empty.json'), { ua: `bad\u0000agent\n${'x'.repeat(300)}` });
  assert.equal(r.provider.lastPush?.userAgent?.length, 120);
  assert.ok(!/[\u0000\n]/.test(r.provider.lastPush!.userAgent!));
});

// ── The envelope ────────────────────────────────────────────────────────────────────────

test('envelope: the v1 envelope, a bare array, and every refusal with a reason', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const src = 'my-source';
  assert.deepEqual(parseEnvelope(enc(`{"schema":"${INGEST_SCHEMA_ID}","source":"my-source","records":[1]}`), src), {
    ok: true,
    records: [1],
    form: 'envelope',
  });
  assert.deepEqual(parseEnvelope(enc('[{"a":1}]'), src), { ok: true, records: [{ a: 1 }], form: 'array' });
  const refusals: Array<[string | Uint8Array, RegExp]> = [
    [new Uint8Array([0xff, 0xfe]), /not UTF-8/],
    ['   ', /empty/],
    ['{nope', /not JSON/],
    ['42', /envelope or a JSON array/],
    ['{"records":[]}', /no "schema"/],
    [`{"schema":"oneview.ingest.v2","source":"my-source","records":[]}`, /is not oneview\.ingest\.v1/],
    [`{"schema":"${INGEST_SCHEMA_ID}","source":"other","records":[]}`, /"other" is not this listener's source/],
    [`{"schema":"${INGEST_SCHEMA_ID}","records":[]}`, /source missing/],
    [`{"schema":"${INGEST_SCHEMA_ID}","source":"my-source","records":{}}`, /must be an array/],
    [`{"schema":"${INGEST_SCHEMA_ID}","source":"my-source","records":[],"extra":1}`, /unknown field.*"extra"/],
  ];
  for (const [body, reason] of refusals) {
    const r = parseEnvelope(typeof body === 'string' ? enc(body) : body, src);
    assert.equal(r.ok, false, String(body));
    if (!r.ok) assert.match(r.reason, reason);
  }
  const long = parseEnvelope(enc(`{"schema":"${'s'.repeat(500)}"}`), src);
  assert.ok(!long.ok && long.reason.length < 120, 'a refusal never echoes the whole body');
});

// ── Definition rules and the manifest ──────────────────────────────────────────────────

test('validation: pushed sources have no endpoint, one token, sane settings; warnings for the rest', () => {
  const d = weather();
  assert.deepEqual(validateHttpIngest(d).errors, []);
  const errs = (patch: Partial<ConnectorProviderDefinition>) =>
    validateHttpIngest({ ...d, ...patch }).errors.join('\n');
  assert.match(errs({ endpoint: { url: 'https://example.com/x' } }), /no endpoint/);
  assert.match(errs({ websocket: { url: 'wss://example.com/x' } }), /no websocket/);
  assert.match(errs({ file: { path: 'a.csv' } }), /no file/);
  assert.match(errs({ boundsQuery: true }), /boundsQuery/);
  assert.match(errs({ credentials: {} }), /exactly one credential/);
  assert.match(errs({ credentials: { a: { secretRef: 'a' }, b: { secretRef: 'b' } } }), /exactly one credential/);
  assert.match(errs({ settings: [{ key: 'port', label: 'Port', kind: 'string' }] }), /"port" must be a number/);
  assert.match(errs({ settings: [{ key: 'port', label: 'Port', kind: 'number', min: 80 }] }), /min is below 1024/);
  assert.match(
    errs({ settings: [{ key: 'maxBodyBytes', label: 'Max', kind: 'number', max: 1e9 }] }),
    /max is above 16777216/,
  );
  const warns = validateHttpIngest({
    ...d,
    settings: [],
    credentials: { t: { secretRef: 't' } },
    mapping: { ...d.mapping, observedAt: undefined as never },
  }).warnings.join('\n');
  assert.match(warns, /fixed at port 47311/);
  assert.match(warns, /kind "token"/);
  assert.match(warns, /receipt time/);
  // Through the registry: the schema's own rules still hold (no opened policy for a user-configured file).
  const opened = defaultConnectorRegistry.validate({ ...d, dataPolicy: { exportAllowed: true } });
  assert.equal(opened.ok, false);
});

test('manifest: a local-process source, token required, fail-closed policy, off by default, valid', () => {
  for (const name of EXAMPLES) {
    const d = definitionOf(name);
    const m = ingestManifest(d);
    const parsed = manifestSchema.parse(m);
    assert.ok(parsed.ok, `${name}: ${parsed.ok ? '' : parsed.issues.map((i) => i.message).join('; ')}`);
    assert.equal(m.transport, 'local-process');
    assert.deepEqual(m.allowedHosts, []);
    assert.equal(m.enabledByDefault, false);
    assert.equal(m.commercialReview, 'manual-review-required');
    assert.equal(m.credentials.length, 1);
    assert.equal(m.credentials[0]!.required, true);
    assert.equal(m.dataPolicy.commercialUseAllowed, 'unknown');
    assert.equal(m.dataPolicy.redistributionAllowed, false);
    assert.equal(m.dataPolicy.exportAllowed, false);
    assert.equal(d.review, 'user-configured');
    assert.equal(d.enabled, false);
    assert.equal(ingestPath(d.id), `/ingest/${d.id}`);
  }
});

test('the Node-RED example flow posts the envelope to the example source, and carries no token', () => {
  const flow = JSON.parse(fixture('node-red-flow.json')) as Array<Record<string, unknown>>;
  const request = flow.find((n) => n.type === 'http request');
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `http://127.0.0.1:${INGEST_DEFAULT_PORT}${ingestPath('node-red-weather-stations')}`);
  const fn = flow.find((n) => n.type === 'function');
  assert.match(String(fn?.func), /schema: 'oneview\.ingest\.v1'/);
  assert.match(String(fn?.func), /env\.get\('ONEVIEW_INGEST_TOKEN'\)/);
  assert.ok(!/Bearer [A-Za-z0-9+/=]{16,}/.test(JSON.stringify(flow)), 'no token written into the flow');
  // Wired inject → function → http request → debug.
  const byId = new Map(flow.map((n) => [n.id, n]));
  const next = (n: Record<string, unknown> | undefined) =>
    byId.get(((n?.wires as string[][] | undefined)?.[0] ?? [])[0] as string);
  const inject = flow.find((n) => n.type === 'inject');
  assert.deepEqual(
    [next(inject)?.type, next(next(inject))?.type, next(next(next(inject)))?.type],
    ['function', 'http request', 'debug'],
  );
});
