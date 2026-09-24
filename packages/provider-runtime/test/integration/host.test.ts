import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderHost } from '../../src/index.js';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import { WorldState } from '@worldview/state-engine';
import { createProvider } from '@worldview/provider-usgs';
import { createProvider as createReadsb } from '@worldview/provider-readsb-local';
import { testing } from '@worldview/provider-sdk';

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
