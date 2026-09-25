import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderHost, pollBudgetMs, subscribeFailureStatus, viewportPollGapMs } from '../../src/index.js';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import { WorldState } from '@worldview/state-engine';
import { createProvider } from '@worldview/provider-usgs';
import { createProvider as createReadsb } from '@worldview/provider-readsb-local';
import { ProviderError, manifestSchema, testing } from '@worldview/provider-sdk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fixture = (n: string) => readFileSync(path.join(root, 'fixtures', 'usgs', n), 'utf8');

function makeHost(clock: testing.VirtualClock, fetchImpl: typeof fetch) {
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink] });
  const host = new ProviderHost({
    clock,
    loggerHub: hub,
    fetchImpl,
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
  });
  return { host, sink };
}

const fakeFetch = (handler: (url: string) => Response | Promise<Response>): typeof fetch =>
  (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;

test('integration: USGS → ProviderHost → WorldState (live, failure, offline, recovery)', async () => {
  const clock = new testing.VirtualClock(Date.parse('2026-09-21T08:05:00.000Z'));
  let mode: 'ok' | '500' | 'garbage' = 'ok';
  let calls = 0;
  const { host, sink } = makeHost(
    clock,
    fakeFetch(() => {
      calls++;
      if (mode === '500') return new Response('upstream down', { status: 503 });
      if (mode === 'garbage') return new Response('<html>', { status: 200 });
      return new Response(fixture('normal.geojson'), {
        status: 200,
        headers: { etag: '"abc"', 'content-type': 'application/geo+json' },
      });
    }),
  );
  const state = new WorldState({ clock, flushDelayMs: 0 });
  const batches: number[] = [];
  host.onObservations((b) => {
    batches.push(b.observations.length);
    state.ingest(b.observations, {
      snapshot: b.snapshot,
      providerId: b.providerId,
      ...(b.freshness ? { freshness: b.freshness } : {}),
    });
  });
  const statuses: string[] = [];
  host.health.on('change', (c) => statuses.push(`${c.from}->${c.to}`));

  host.register(createProvider());
  await host.start();
  const first = await host.pollNow('usgs-earthquakes');
  assert.equal(first?.observations.length, 8);
  assert.equal(state.size, 8);
  assert.equal(state.get('earthquake:usgs:us7000wv02')?.labels.place, 'Near the east coast of Honshu, Japan');
  assert.equal(host.health.get('usgs-earthquakes')?.health.status, 'LIVE');
  assert.equal(host.health.connection().state, 'CONNECTED');

  // Malformed body → MALFORMED error, health DEGRADED, no crash, state untouched.
  mode = 'garbage';
  clock.advance(60_000);
  const second = await host.pollNow('usgs-earthquakes');
  assert.equal(second, undefined);
  assert.equal(host.health.get('usgs-earthquakes')?.health.status, 'DEGRADED');
  assert.equal(host.health.get('usgs-earthquakes')?.health.lastError?.code, 'MALFORMED');
  assert.equal(state.size, 8);

  // Upstream failure: HttpClient retries then serves the cached body (stale); circuit opens after 3 attempts.
  mode = '500';
  clock.advance(60_000);
  const before500 = calls;
  const third = await host.pollNow('usgs-earthquakes');
  assert.equal(third?.observations.length, 8, 'stale cache served on failure');
  assert.equal(third?.observations[0]?.provenance.origin, 'cached');
  assert.equal(calls - before500, 3, 'initial attempt + 2 retries');
  const h = host.health.get('usgs-earthquakes')!.health;
  assert.ok(['LIVE', 'STALE', 'DEGRADED'].includes(h.status), h.status);
  assert.ok((h.cacheAgeMs ?? 0) >= 120_000, `cacheAgeMs=${h.cacheAgeMs}`);
  const afterCircuit = calls;
  await host.pollNow('usgs-earthquakes');
  assert.equal(calls, afterCircuit, 'circuit open: stale served without an upstream call');

  // Offline → OFFLINE with no upstream calls; back online → recovers automatically.
  mode = 'ok';
  const before = calls;
  host.setOnline(false);
  assert.equal(host.health.get('usgs-earthquakes')?.health.status, 'OFFLINE');
  assert.equal(host.health.connection().state, 'OFFLINE');
  const offlinePoll = await host.pollNow('usgs-earthquakes');
  assert.equal(offlinePoll, undefined);
  assert.equal(calls, before, 'no network calls while offline');
  clock.advance(60_000); // circuit half-open again
  host.setOnline(true);
  const fourth = await host.pollNow('usgs-earthquakes');
  assert.equal(fourth?.observations.length, 8);
  assert.equal(host.health.get('usgs-earthquakes')?.health.status, 'LIVE');
  assert.equal(host.health.connection().state, 'CONNECTED');
  assert.ok(statuses.includes('LIVE->OFFLINE') || statuses.includes('DEGRADED->OFFLINE'), statuses.join(','));
  assert.ok(statuses.at(-1)?.endsWith('->LIVE'), statuses.join(','));

  // Logs must not contain secrets and must be structured.
  assert.ok(sink.records.every((r) => typeof r.ts === 'string' && r.category === 'provider'));

  // Disable provider → objects removed from state, health DISABLED.
  await host.setEnabled('usgs-earthquakes', false);
  state.removeProvider('usgs-earthquakes');
  assert.equal(state.size, 0);
  assert.equal(host.health.get('usgs-earthquakes')?.health.status, 'DISABLED');
  await host.dispose();
});

test('integration: a provider that throws in start() is isolated', async () => {
  const clock = new testing.VirtualClock();
  const { host } = makeHost(
    clock,
    fakeFetch(() => new Response('{}')),
  );
  const bad = createProvider();
  bad.start = async () => {
    throw new Error('boom');
  };
  host.register(bad);
  await host.start();
  assert.equal(host.health.get('usgs-earthquakes')?.health.status, 'ERROR');
  assert.ok(host.health.get('usgs-earthquakes')?.health.message?.includes('boom'));
  await host.dispose();
});

test('integration: manifest validation refuses bad providers at registration', async () => {
  const clock = new testing.VirtualClock();
  const { host } = makeHost(
    clock,
    fakeFetch(() => new Response('{}')),
  );
  const p = createProvider();
  (p as { manifest: unknown }).manifest = { ...p.manifest, allowedHosts: [] };
  assert.throws(() => host.register(p), /allowedHosts/);
  await host.dispose();
});

test('integration: a provider can attach only the credentials its manifest declares', async () => {
  const clock = new testing.VirtualClock();
  const seen: Array<Record<string, string>> = [];
  const hub = new LoggerHub({ level: 'warn', sinks: [new RingBufferSink()] });
  const host = new ProviderHost({
    clock,
    loggerHub: hub,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push({ ...((init?.headers as Record<string, string>) ?? {}) });
      return new Response('{}');
    }) as typeof fetch,
    manualScheduling: true,
    sleep: async () => {},
    credentials: {
      get: async (k) => (k === 'probe.mine' ? 'mine-secret' : k === 'other.key' ? 'not-yours' : undefined),
      has: async () => true,
    },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
  });
  const usgs = createProvider();
  let ctx: import('@worldview/provider-sdk').ProviderContext | undefined;
  const probe: import('@worldview/provider-sdk').WorldProvider = {
    manifest: {
      ...usgs.manifest,
      id: 'key-probe',
      credentials: [{ key: 'probe.mine', label: 'Probe key', required: false, kind: 'api-key' }],
    },
    initialize: async (c) => {
      ctx = c;
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: 'key-probe',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
  };
  host.register(probe);
  await host.start();
  const url = `https://${usgs.manifest.allowedHosts[0]}/probe`;
  await ctx!.http.request({ url, credential: { key: 'probe.mine', as: 'header', name: 'X-Key' }, cacheKey: 'a' });
  assert.equal(seen[0]!['X-Key'], 'mine-secret');
  await assert.rejects(
    ctx!.http.request({ url, credential: { key: 'other.key', as: 'header', name: 'X-Key' }, cacheKey: 'b' }),
    (e: Error & { code?: string }) => e.code === 'AUTH',
    "another provider's key is not attached",
  );
  assert.equal(seen.length, 1, 'and no request left without it');
  await host.dispose();
});

test('a local provider reaches the one host the user named — over plain http — and nothing else (ADR-003)', async () => {
  const clock = new testing.VirtualClock(Date.parse('2026-09-21T08:05:00.000Z'));
  const settings = new testing.MemorySettings({
    endpoint: 'http://receiver.lan:8080/data/aircraft.json',
    trustedHost: 'Receiver.LAN',
  });
  const fetched: string[] = [];
  let probeTrusted: (() => readonly string[]) | undefined;
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    fetchImpl: fakeFetch((url) => {
      fetched.push(url);
      return new Response(fixture('../readsb-local/aircraft.json'), { status: 200 });
    }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => settings,
    // The runtime's local access admits a probe to the named host; this stand-in does the same.
    localAccess: (_id, _allowed, trusted) => {
      probeTrusted = trusted;
      return {
        readGrantedFile: async () => {
          throw new Error('no grant');
        },
        probeLocal: async (url) => ({ reachable: trusted().includes(new URL(url).hostname), status: 200 }),
      };
    },
  });
  host.register(createReadsb());
  await host.start();
  await new Promise((r) => setImmediate(r)); // settings read
  const batch = await host.pollNow('readsb-local');
  assert.ok(batch && batch.observations.length > 0, JSON.stringify(host.health.get('readsb-local')?.health.lastError));
  assert.deepEqual(fetched, ['http://receiver.lan:8080/data/aircraft.json']);
  assert.deepEqual(probeTrusted?.(), ['receiver.lan'], 'the probe sees the named host, lowercased');

  // The setting cleared: the host is no longer reachable, and loopback still is the default.
  settings.update({ endpoint: 'http://receiver.lan:8080/data/aircraft.json' });
  clock.advance(60_000);
  assert.equal(await host.pollNow('readsb-local'), undefined);
  assert.equal(fetched.length, 1, 'nothing was sent to a host no longer named');
  // A wildcard or a URL is not a host.
  settings.update({ endpoint: 'http://receiver.lan:8080/data/aircraft.json', trustedHost: '*.lan' });
  assert.deepEqual(probeTrusted?.(), []);
});

test('raster overlays (ADR-008): published after start, validated, kept to the allowed hosts, gone on stop', async () => {
  const clock = new testing.VirtualClock();
  const { host } = makeHost(
    clock,
    fakeFetch(() => new Response('{}')),
  );
  const usgs = createProvider();
  const base = { name: 'Roads', attribution: 'Example agency (CC BY 4.0)' };
  const published: unknown[] = [
    { ...base, id: 'roads', kind: 'wms', url: `https://${usgs.manifest.allowedHosts[0]}/wms`, layers: 'roads' },
    { ...base, id: 'elsewhere', kind: 'xyz', url: 'https://evil.example/{z}/{x}/{y}.png' },
    { ...base, id: 'plain', kind: 'xyz', url: `http://${usgs.manifest.allowedHosts[0]}/{z}/{x}/{y}.png` },
    { ...base, id: 'roads', kind: 'wms', url: `https://${usgs.manifest.allowedHosts[0]}/wms`, layers: 'roads-again' },
    { ...base, id: 'broken', kind: 'wmts' },
  ];
  const probe: import('@worldview/provider-sdk').WorldProvider = {
    manifest: { ...usgs.manifest, id: 'overlay-probe', enabledByDefault: true },
    initialize: async () => {},
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: 'overlay-probe',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
    overlays: async () => published as never,
  };
  const seen: number[] = [];
  host.onOverlays((all) => seen.push(all.length));
  host.register(probe);
  assert.deepEqual(host.overlays(), [], 'nothing before start');
  await host.start();
  await new Promise((r) => setImmediate(r)); // overlays are asked for after start, not awaited by it
  const overlays = host.overlays();
  assert.deepEqual(
    overlays.map((o) => o.id),
    ['roads'],
    'the wrong host, plain http, a duplicate id and an invalid descriptor are refused',
  );
  assert.equal(overlays[0]!.providerId, 'overlay-probe', "the provider id is the host's, whatever the descriptor said");
  assert.deepEqual(seen, [1]);
  await host.refreshOverlays('overlay-probe');
  assert.deepEqual(seen, [1], 'an unchanged list is not re-announced');
  await host.setEnabled('overlay-probe', false);
  assert.deepEqual(host.overlays(), []);
  assert.deepEqual(seen, [1, 0], 'stopping the provider takes its overlays away');
  await host.dispose();
});

test('raster overlays: start does not wait for a slow capabilities read; overlays are asked again after each successful poll', async () => {
  const clock = new testing.VirtualClock();
  const { host } = makeHost(
    clock,
    fakeFetch(() => new Response('{"type":"FeatureCollection","features":[]}')),
  );
  const usgs = createProvider();
  let answer: () => void = () => undefined;
  let asked = 0;
  let list: unknown[] = [];
  const probe: import('@worldview/provider-sdk').WorldProvider = {
    manifest: { ...usgs.manifest, id: 'slow-overlays', enabledByDefault: true },
    initialize: async () => {},
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: 'slow-overlays',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
    query: async () => [],
    overlays: () => {
      asked++;
      return new Promise((resolve) => {
        answer = () => resolve(list as never);
      });
    },
  };
  host.register(probe);
  let started = false;
  const starting = host.start().then(() => {
    started = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(started, true, 'start returned while the first overlays read was still pending');
  assert.equal(asked, 1);
  await starting;
  list = [
    {
      id: 'roads',
      kind: 'xyz',
      name: 'Roads',
      attribution: 'Example',
      url: `https://${usgs.manifest.allowedHosts[0]}/{z}/{x}/{y}.png`,
    },
  ];
  answer();
  await new Promise((r) => setImmediate(r));
  assert.equal(host.overlays().length, 1, 'the late answer is published');
  // A successful poll asks again (a changed setting reaches the renderers without a restart).
  await host.pollNow('slow-overlays');
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 2);
  await host.dispose();
});

test("the poll budget is the manifest's own when it names one, else one request with its retries", () => {
  const base = createProvider().manifest.refreshPolicy;
  assert.equal(pollBudgetMs({ ...base, timeoutMs: 20_000, maxRetries: 1 }), 45_000);
  assert.equal(pollBudgetMs({ ...base, timeoutMs: 20_000, maxRetries: 1, pollBudgetMs: 225_000 }), 225_000);
});

test('a socket credential as a URL query is dialed by the host, never handed to onOpen, and appears in no log line (ADR-003 amendment)', async () => {
  const clock = new testing.VirtualClock();
  const sink = new RingBufferSink();
  const dialed: string[] = [];
  class FakeWebSocket {
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    constructor(url: string) {
      dialed.push(url);
      setImmediate(() => this.onopen?.());
    }
    send(): void {}
    close(): void {}
  }
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [sink] }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async (key) => (key === 'feed.token' ? 's3cret' : undefined), has: async () => true },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  const usgs = createProvider();
  const opens: Array<{ secret?: string }> = [];
  let ctx: import('@worldview/provider-sdk').ProviderContext | undefined;
  const probe: import('@worldview/provider-sdk').WorldProvider = {
    manifest: {
      ...usgs.manifest,
      id: 'socket-probe',
      transport: 'websocket',
      allowedHosts: ['feeds.example.org'],
      credentials: [{ key: 'feed.token', label: 'Token', required: true, kind: 'token' }],
    },
    initialize: async (c) => {
      ctx = c;
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: 'socket-probe',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'configured',
    }),
  };
  host.register(probe);
  await host.start();
  const events = {
    onOpen: (c: { secret?: string }) => opens.push(c),
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
  };
  await ctx!.sockets.open('wss://feeds.example.org/api/socket', events, {
    credential: { key: 'feed.token', as: 'query' },
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(dialed, ['wss://feeds.example.org/api/socket?token=s3cret']);
  assert.deepEqual(opens, [{}], 'a query credential never reaches onOpen');
  await ctx!.sockets.open('wss://feeds.example.org/api/socket', events, {
    credential: { key: 'feed.token', as: 'query', param: 'access_token' },
  });
  assert.equal(dialed[1], 'wss://feeds.example.org/api/socket?access_token=s3cret');
  await ctx!.sockets.open('wss://feeds.example.org/api/socket', events, { credential: { key: 'feed.token' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(dialed[2], 'wss://feeds.example.org/api/socket', 'the default hands the secret to onOpen');
  assert.deepEqual(opens, [{}, {}, { secret: 's3cret' }]);
  await assert.rejects(
    ctx!.sockets.open('wss://feeds.example.org/api/socket', events, {
      credential: { key: 'feed.token', as: 'query', param: 'a=b' },
    }),
    (e: Error & { code?: string }) => e.code === 'INTERNAL',
  );
  assert.ok(!JSON.stringify(sink.records).includes('s3cret'), 'the secret is in no log line');
  await host.dispose();
});

test('the loopback listener is offered to local-process sources only, one at a time, for a declared credential, and closed when the source stops', async () => {
  const clock = new testing.VirtualClock();
  const opened: Array<{ port: number; closed: boolean; secretSeen: string | undefined }> = [];
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async (key) => (key === 'ingest.token' ? 'tok' : 'other'), has: async () => true },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
    listen: (_id, resolveSecret) => async (options) => {
      const record = { port: options.port, closed: false, secretSeen: await resolveSecret(options.credential.key) };
      opened.push(record);
      return {
        port: options.port,
        received: 0,
        refused: {},
        close: async () => {
          record.closed = true;
        },
      };
    },
  });
  const usgs = createProvider();
  const contexts: Record<string, import('@worldview/provider-sdk').ProviderContext> = {};
  const probe = (id: string, transport: 'local-process' | 'http'): import('@worldview/provider-sdk').WorldProvider => ({
    manifest: {
      ...usgs.manifest,
      id,
      transport,
      allowedHosts: transport === 'http' ? usgs.manifest.allowedHosts : [],
      enabledByDefault: true,
      credentials: [{ key: 'ingest.token', label: 'Token', required: true, kind: 'token' }],
    },
    initialize: async (c) => {
      contexts[id] = c;
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: id,
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'configured',
    }),
  });
  host.register(probe('ingest-probe', 'local-process'));
  host.register(probe('remote-probe', 'http'));
  await host.start();
  assert.equal(contexts['remote-probe']!.local.listen, undefined, 'a remote source never listens');
  const local = contexts['ingest-probe']!.local;
  assert.ok(local.listen);
  const handler = () => ({ status: 202 });
  const handle = await local.listen(
    { port: 47311, path: '/ingest/probe', credential: { key: 'ingest.token' } },
    handler,
  );
  assert.equal(opened[0]!.secretSeen, 'tok', "the listener resolves the source's own credential");
  await assert.rejects(
    local.listen({ port: 47312, path: '/ingest/other', credential: { key: 'ingest.token' } }, handler),
    /one listener per source/,
  );
  await assert.rejects(
    local.listen({ port: 47312, path: '/ingest/other', credential: { key: 'someone.else' } }, handler),
    /not declared/,
  );
  await handle.close();
  assert.equal(opened[0]!.closed, true);
  await local.listen({ port: 47311, path: '/ingest/probe', credential: { key: 'ingest.token' } }, handler);
  await host.setEnabled('ingest-probe', false);
  assert.equal(opened[1]!.closed, true, 'disabling the source closes its listener');
  await host.dispose();
});

test('a filesystem provider reads the one folder the user named in its grantedFolderSetting, and nothing when it is cleared (ADR-003)', async () => {
  const clock = new testing.VirtualClock();
  const settings = new testing.MemorySettings({ folder: 'C:\\Users\\me\\gis' });
  const grants: Array<string | undefined> = [];
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => settings,
    localAccess: (_id, _hosts, _trusted, grantedFolder, declared) => ({
      readGrantedFile: async (file) => {
        assert.equal(declared, true, 'the manifest declares the setting, so the host is told');
        grants.push(grantedFolder());
        if (!grantedFolder()) throw new Error('no grant');
        return new TextEncoder().encode(`${grantedFolder()}/${file}`);
      },
      probeLocal: async () => ({ reachable: false }),
    }),
  });
  const usgs = createProvider();
  let ctx: import('@worldview/provider-sdk').ProviderContext | undefined;
  const probe: import('@worldview/provider-sdk').WorldProvider = {
    manifest: {
      ...usgs.manifest,
      id: 'folder-probe',
      transport: 'filesystem',
      allowedHosts: [],
      settings: [{ key: 'folder', label: 'Folder', kind: 'string' }],
      grantedFolderSetting: 'folder',
    },
    initialize: async (c) => {
      ctx = c;
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: 'folder-probe',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
  };
  host.register(probe);
  await host.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(
    new TextDecoder().decode(await ctx!.local.readGrantedFile('points.geojson')),
    'C:\\Users\\me\\gis/points.geojson',
  );
  settings.update({ folder: 'C:\\' });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(ctx!.local.readGrantedFile('points.geojson'), /no grant/, 'a drive root grants nothing');
  settings.update({ folder: '/srv/gis' });
  await new Promise((r) => setImmediate(r));
  assert.equal(new TextDecoder().decode(await ctx!.local.readGrantedFile('x.csv')), '/srv/gis/x.csv');
  assert.deepEqual(grants, ['C:\\Users\\me\\gis', undefined, '/srv/gis']);
  await host.dispose();
});

test('manifest: grantedFolderSetting is for the filesystem transport and must name a string setting', () => {
  const usgs = createProvider();
  const base = { ...usgs.manifest, settings: [{ key: 'folder', label: 'Folder', kind: 'string' as const }] };
  assert.equal(
    manifestSchema.parse({ ...base, transport: 'filesystem', allowedHosts: [], grantedFolderSetting: 'folder' }).ok,
    true,
  );
  assert.equal(manifestSchema.parse({ ...base, grantedFolderSetting: 'folder' }).ok, false, 'not for http');
  assert.equal(
    manifestSchema.parse({ ...base, transport: 'filesystem', allowedHosts: [], grantedFolderSetting: 'nope' }).ok,
    false,
    'unknown setting',
  );
});

test('mqtt (ADR-003): a local provider gets the client scoped to its hosts and keys; a network provider gets none', async () => {
  const clock = new testing.VirtualClock();
  const calls: Array<{ providerId: string; hosts: string[]; secret: string | undefined }> = [];
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async (k) => (k === 'broker.password' ? 'pw' : 'not-yours'), has: async () => true },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
    mqtt: (providerId, hosts, _trusted, resolveSecret) => ({
      connect: async (opts) => {
        calls.push({ providerId, hosts, secret: await resolveSecret(opts.credential?.key ?? '') });
        return { close: () => undefined, dropped: 0 };
      },
    }),
  });
  const usgs = createProvider();
  const contexts: Record<string, import('@worldview/provider-sdk').ProviderContext> = {};
  const make = (id: string, transport: 'http' | 'local-process'): import('@worldview/provider-sdk').WorldProvider => ({
    manifest: {
      ...usgs.manifest,
      id,
      transport,
      allowedHosts: ['127.0.0.1'],
      credentials: [{ key: 'broker.password', label: 'Broker password', required: false, kind: 'token' }],
    },
    initialize: async (c) => {
      contexts[id] = c;
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: id,
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
  });
  host.register(make('local-mqtt', 'local-process'));
  host.register(make('remote-http', 'http'));
  await host.start();
  assert.equal(contexts['remote-http']!.mqtt, undefined, 'MQTT is a local transport');
  assert.ok(contexts['local-mqtt']!.mqtt);
  await contexts['local-mqtt']!.mqtt!.connect(
    { host: '127.0.0.1', subscriptions: [{ topic: 'a' }], credential: { key: 'broker.password' } },
    { onMessage: () => undefined },
  );
  await contexts['local-mqtt']!.mqtt!.connect(
    { host: '127.0.0.1', subscriptions: [{ topic: 'a' }], credential: { key: 'other.key' } },
    { onMessage: () => undefined },
  );
  assert.deepEqual(calls, [
    { providerId: 'local-mqtt', hosts: ['127.0.0.1'], secret: 'pw' },
    { providerId: 'local-mqtt', hosts: ['127.0.0.1'], secret: undefined },
  ]);
  await host.dispose();
});

test('unregister stops a running provider, drops its settings watchers and its Source Health entry; the id can come back (ADR-013 amendment)', async () => {
  const clock = new testing.VirtualClock();
  const settings = new testing.MemorySettings({});
  let watchers = 0;
  const counted = {
    get: () => settings.get(),
    set: (v: Record<string, never>) => settings.set(v),
    onChange: (l: (v: Record<string, never>) => void) => {
      watchers++;
      const off = settings.onChange(l);
      return () => {
        watchers--;
        off();
      };
    },
  };
  const hub = new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] });
  const host = new ProviderHost({
    clock,
    loggerHub: hub,
    fetchImpl: fakeFetch(() => new Response('{}')),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => counted as never,
  });
  // A local manifest with a trustedHostSetting, so the host keeps a settings watcher for it.
  const local = createReadsb().manifest;
  assert.ok(local.trustedHostSetting, 'the readsb manifest names a trusted-host setting');
  const stops: string[] = [];
  const probe = (): import('@worldview/provider-sdk').WorldProvider => ({
    manifest: { ...local, id: 'defined-source', enabledByDefault: true },
    initialize: async () => {},
    start: async () => {},
    stop: async () => {
      stops.push('stop');
    },
    health: async () => ({
      providerId: 'defined-source',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
  });
  host.register(probe(), { connector: 'rest-json', definitionFile: 'defined.json' });
  assert.equal(host.health.get('defined-source')!.meta.connector, 'rest-json');
  assert.equal(host.health.get('defined-source')!.meta.definitionFile, 'defined.json');
  await host.start();
  assert.equal(watchers, 2, 'the trusted-host watcher and the setup watcher');
  assert.equal(await host.unregister('defined-source'), true);
  assert.deepEqual(stops, ['stop']);
  assert.equal(watchers, 0, 'the settings watcher is dropped');
  assert.equal(host.manifest('defined-source'), undefined);
  assert.equal(host.health.get('defined-source'), undefined);
  assert.equal(await host.unregister('defined-source'), false);
  host.register(probe(), { enabled: false });
  assert.equal(host.list().find((p) => p.manifest.id === 'defined-source')!.enabled, false);
  await host.dispose();
});

test('a source stopped or taken out while it is still starting never goes on to run, poll or keep a listener', async () => {
  const clock = new testing.VirtualClock();
  const opened: Array<{ closed: boolean }> = [];
  let release!: () => void;
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async () => 'tok', has: async () => true },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
    listen: () => async (options) => {
      const record = { closed: false };
      opened.push(record);
      // Opening takes a while, so the source can be stopped meanwhile.
      await new Promise((r) => setImmediate(r));
      return {
        port: options.port,
        received: 0,
        refused: {},
        close: async () => {
          record.closed = true;
        },
      };
    },
  });
  const usgs = createProvider();
  const calls: string[] = [];
  let context: import('@worldview/provider-sdk').ProviderContext | undefined;
  const probe: import('@worldview/provider-sdk').WorldProvider = {
    manifest: {
      ...usgs.manifest,
      id: 'slow-start',
      transport: 'local-process',
      allowedHosts: [],
      enabledByDefault: true,
      credentials: [{ key: 'ingest.token', label: 'Token', required: true, kind: 'token' }],
    },
    initialize: async (c) => {
      context = c;
    },
    start: async () => {
      calls.push('start');
      await new Promise<void>((r) => (release = r));
    },
    stop: async () => {
      calls.push('stop');
    },
    query: async () => {
      calls.push('query');
      return { observations: [] };
    },
    health: async () => ({
      providerId: 'slow-start',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'configured',
    }),
  };
  host.register(probe);
  const starting = host.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['start']);
  // Two listeners at once: the second is refused while the first is opening.
  const listen = context!.local.listen!;
  const results = await Promise.allSettled([
    listen({ port: 47311, path: '/a', credential: { key: 'ingest.token' } }, () => ({ status: 202 })),
    listen({ port: 47312, path: '/b', credential: { key: 'ingest.token' } }, () => ({ status: 202 })),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal(await host.unregister('slow-start'), true);
  release();
  await starting;
  assert.deepEqual(calls, ['start', 'stop'], 'the start that finished after unregister stopped the provider itself');
  assert.equal(host.list().length, 0);
  assert.ok(
    opened.every((o) => o.closed),
    'no listener outlives the source',
  );
  await assert.rejects(
    listen({ port: 47313, path: '/c', credential: { key: 'ingest.token' } }, () => ({ status: 202 })),
    /not running/,
    'a taken-out source cannot listen',
  );
  await host.dispose();
});

test('a listener opened while its source is being disabled is closed, and one closed through its own signal frees the slot', async () => {
  const clock = new testing.VirtualClock();
  const opened: Array<{ closed: boolean }> = [];
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: { get: async () => 'tok', has: async () => true },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
    listen: () => async (options) => {
      const record = { closed: false };
      opened.push(record);
      await new Promise((r) => setImmediate(r));
      const close = async () => {
        record.closed = true;
      };
      options.signal?.addEventListener('abort', () => void close(), { once: true });
      return { port: options.port, received: 0, refused: {}, close };
    },
  });
  const usgs = createProvider();
  let context: import('@worldview/provider-sdk').ProviderContext | undefined;
  host.register({
    manifest: {
      ...usgs.manifest,
      id: 'listening',
      transport: 'local-process',
      allowedHosts: [],
      enabledByDefault: true,
      credentials: [{ key: 'ingest.token', label: 'Token', required: true, kind: 'token' }],
    },
    initialize: async (c) => {
      context = c;
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({
      providerId: 'listening',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'configured',
    }),
  });
  await host.start();
  const listen = context!.local.listen!;
  const abort = new AbortController();
  await listen({ port: 47311, path: '/a', credential: { key: 'ingest.token' }, signal: abort.signal }, () => ({
    status: 202,
  }));
  abort.abort();
  assert.equal(opened[0]!.closed, true);
  await listen({ port: 47311, path: '/a', credential: { key: 'ingest.token' } }, () => ({ status: 202 }));
  assert.equal(opened.length, 2, 'the aborted listener freed the one-per-source slot');
  await host.setEnabled('listening', false);
  await host.setEnabled('listening', true);
  const pending = listen({ port: 47312, path: '/b', credential: { key: 'ingest.token' } }, () => ({ status: 202 }));
  await host.setEnabled('listening', false);
  await assert.rejects(pending, /stopped while its listener opened/);
  assert.ok(
    opened.every((o) => o.closed),
    'nothing is left listening',
  );
  await host.dispose();
});

test('a listener source republishes its health after a refused push and after its credential changes (A3 of phase ingest)', async () => {
  const clock = new testing.VirtualClock();
  let credentialChanged: ((key: string) => void) | undefined;
  let refusedHook: ((status: number) => void) | undefined;
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    manualScheduling: true,
    sleep: async () => {},
    credentials: {
      get: async () => 'tok',
      has: async () => true,
      onChange: (l: (key: string) => void) => {
        credentialChanged = l;
        return () => undefined;
      },
    } as never,
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
    listen: (_id, _resolve, onRefused) => {
      refusedHook = onRefused;
      return async (options) => ({ port: options.port, received: 0, refused: {}, close: async () => undefined });
    },
  });
  const usgs = createProvider();
  let healthCalls = 0;
  host.register({
    manifest: {
      ...usgs.manifest,
      id: 'pushed',
      transport: 'local-process',
      allowedHosts: [],
      enabledByDefault: true,
      credentials: [{ key: 'ingest.token', label: 'Token', required: true, kind: 'token' }],
    },
    initialize: async () => {},
    start: async () => {},
    stop: async () => {},
    subscribe: async () => () => undefined,
    health: async () => {
      healthCalls++;
      return {
        providerId: 'pushed',
        status: 'LIVE',
        errorRate: 0,
        rateLimitState: { limited: false },
        credentialState: 'configured',
      };
    },
  });
  await host.start();
  assert.ok(refusedHook, 'the host hands the listener a refusal hook');
  const before = healthCalls;
  refusedHook!(401);
  refusedHook!(401);
  refusedHook!(429);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(healthCalls, before + 1, 'refusals coalesce into one publish within a second');
  credentialChanged!('ingest.token');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(healthCalls, before + 2, 'a changed token republishes health for a source with no poll');
  await host.dispose();
});

test('a moved view asks a paged bounds source for an early poll no sooner than its request budget allows', async (t) => {
  const policy = {
    intervalMs: 3_600_000,
    minIntervalMs: 5000,
    timeoutMs: 60_000,
    maxRetries: 1,
    maxRequestsPerMinute: 11,
  };
  assert.equal(viewportPollGapMs(policy, 0), 5000, 'nothing known yet: the minimum interval');
  assert.equal(viewportPollGapMs(policy, 1), 5455);
  assert.equal(viewportPollGapMs(policy, 5), 27_273, 'five pages at 11 a minute');
  assert.equal(viewportPollGapMs({ ...policy, maxRequestsPerMinute: 0 }, 5), 5000);

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const clock = { now: () => Date.now() };
  const polls: number[] = [];
  const usgs = createProvider();
  const host = new ProviderHost({
    clock: clock as never,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [new RingBufferSink()] }),
    fetchImpl: fakeFetch(() => new Response('{}')),
    sleep: async () => {},
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock as never, allowed),
    settingsStore: () => new testing.MemorySettings({}),
  });
  let ctx: import('@worldview/provider-sdk').ProviderContext | undefined;
  host.register({
    manifest: {
      ...usgs.manifest,
      id: 'paged-bounds',
      enabledByDefault: true,
      capabilities: { ...usgs.manifest.capabilities, boundsQuery: true },
      refreshPolicy: { ...usgs.manifest.refreshPolicy, ...policy },
    },
    initialize: async (c) => {
      ctx = c;
    },
    start: async () => {},
    stop: async () => {},
    query: async () => {
      polls.push(Date.now());
      // Five pages, as a paged definition sends them.
      for (let i = 0; i < 5; i++)
        await ctx!.http.request({
          url: `https://${usgs.manifest.allowedHosts[0]}/p${i}`,
          cacheKey: `p${i}-${polls.length}`,
        });
      return [];
    },
    health: async () => ({
      providerId: 'paged-bounds',
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
  });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  await host.start();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(polls.length, 1, 'the first poll');
  const view = (w: number) => host.setViewport({ west: w, south: 10, east: w + 20, north: 30 });
  view(0);
  view(10); // panning: each move asks again
  t.mock.timers.tick(6000);
  await flush();
  assert.equal(polls.length, 1, 'not after the 5 s minimum: the last poll used five of eleven requests a minute');
  view(20);
  t.mock.timers.tick(22_000);
  await flush();
  assert.equal(polls.length, 2, 'once the budget allows, one poll for the latest view');
  assert.ok(polls[1]! - polls[0]! >= 27_273);
  await host.dispose();
});

test('a source waiting for the operator reads NEEDS_SETUP, is not retried or logged as failing, and polls again when its settings change', async () => {
  const clock = new testing.VirtualClock();
  const settings = new testing.MemorySettings({});
  const sink = new RingBufferSink();
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [sink] }),
    fetchImpl: fakeFetch(() => new Response('{}')),
    sleep: async () => {},
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => settings,
  });
  const usgs = createProvider();
  let address: string | undefined;
  let polls = 0;
  let lastError: ProviderError | undefined;
  host.register({
    manifest: { ...usgs.manifest, id: 'needs-address', enabledByDefault: true },
    initialize: async (c) => {
      c.settings.onChange((v) => {
        address = typeof v['address'] === 'string' ? (v['address'] as string) : undefined;
      });
    },
    start: async () => {},
    stop: async () => {},
    query: async () => {
      polls++;
      if (!address) {
        lastError = new ProviderError('HOST_NOT_ALLOWED', 'Set the address in this source’s settings', { setup: true });
        throw lastError;
      }
      lastError = undefined;
      return [];
    },
    health: async () => ({
      providerId: 'needs-address',
      status: lastError?.setupRequired ? 'NEEDS_SETUP' : 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    }),
  });
  await host.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(polls, 1);
  assert.equal(host.health.get('needs-address')?.health.status, 'NEEDS_SETUP');
  assert.equal(host.health.connection().remoteTotal, 0, 'not counted against the connection');
  assert.ok(!sink.records.some((e) => e.message === 'poll failed'), 'not logged as a failure');
  assert.ok(sink.records.some((e) => e.message === 'waiting for setup'));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(polls, 1, 'not retried on a back-off');
  settings.update({ address: '192.168.1.20' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(polls, 2, 'asked again once the setting is there');
  assert.equal(host.health.get('needs-address')?.health.status, 'LIVE');
  await host.dispose();
});

test('a subscription that cannot reach its receiver reads OFFLINE, a missing setting NEEDS_SETUP — not ERROR', () => {
  assert.equal(subscribeFailureStatus(new ProviderError('OFFLINE', 'no AIS receiver at 127.0.0.1:10110')), 'OFFLINE');
  assert.equal(subscribeFailureStatus(new ProviderError('TIMEOUT', 'connect timed out')), 'OFFLINE');
  assert.equal(subscribeFailureStatus(new ProviderError('AUTH', 'refused')), 'AUTH_REQUIRED');
  assert.equal(
    subscribeFailureStatus(new ProviderError('HOST_NOT_ALLOWED', 'set an address', { setup: true })),
    'NEEDS_SETUP',
  );
  assert.equal(subscribeFailureStatus(new ProviderError('MALFORMED', 'bad frame')), 'ERROR');
});

test('a source refused for want of a key is not asked again on a view move or an online flap, only when a key arrives', async () => {
  const clock = new testing.VirtualClock();
  const sink = new RingBufferSink();
  let credentialListener: ((key: string) => void) | undefined;
  let hasKey = false;
  const host = new ProviderHost({
    clock,
    loggerHub: new LoggerHub({ level: 'debug', sinks: [sink] }),
    fetchImpl: fakeFetch(() => new Response('{}')),
    sleep: async () => {},
    credentials: {
      get: async () => (hasKey ? 'k' : undefined),
      has: async () => hasKey,
      onChange: (l: (key: string) => void) => {
        credentialListener = l;
        return () => undefined;
      },
    },
    cacheStore: (_id, allowed) => new testing.MemoryCache(clock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
  });
  const usgs = createProvider();
  let polls = 0;
  host.register({
    manifest: {
      ...usgs.manifest,
      id: 'needs-key',
      enabledByDefault: true,
      capabilities: { ...usgs.manifest.capabilities, boundsQuery: true },
      credentials: [{ key: 'needs.key', label: 'Key', kind: 'api-key', required: true }],
    },
    initialize: async () => {},
    start: async () => {},
    stop: async () => {},
    query: async () => {
      polls++;
      if (!hasKey) throw new ProviderError('AUTH', 'credential required', { retryable: false });
      return [];
    },
    health: async () => ({
      providerId: 'needs-key',
      status: hasKey ? 'LIVE' : 'AUTH_REQUIRED',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: hasKey ? 'present' : 'missing',
    }),
  });
  await host.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(polls, 1);
  host.setViewport({ west: 10, south: 10, east: 20, north: 20 });
  host.setOnline(false);
  host.setOnline(true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(polls, 1, 'neither the view nor the network asks a source that waits for a key');
  assert.equal(sink.records.filter((e) => e.message === 'poll failed').length, 1, 'said once');
  hasKey = true;
  credentialListener?.('needs.key');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(polls, 2, 'asked again when the key arrives');
  await host.dispose();
});
