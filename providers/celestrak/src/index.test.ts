import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProviderError,
  testing,
  type ProviderHttp,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
} from '@worldview/provider-sdk';
import { CelestrakProvider, mapUpstreamError, parseSettings, restoreEntry, CATALOG_MAX_AGE_MS } from './index.js';
import { CircularOrbitPropagator } from './circular-orbit-propagator.js';
import { SatelliteJsPropagator } from './satellite-js-propagator.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'celestrak');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
const START = Date.parse('2026-09-21T08:05:00Z');
const signal = () => new AbortController().signal;

function setup(
  opts: {
    settings?: Record<string, string | number | string[]>;
    responder?: testing.FixtureResponder;
    provider?: CelestrakProvider;
  } = {},
) {
  const ctx = testing.createFixtureContext({
    providerId: 'celestrak',
    clock: new testing.VirtualClock(START),
    settings: opts.settings ?? { groups: ['stations'] },
    responder:
      opts.responder ??
      ((req) => ({ status: 200, body: req.url.includes('FORMAT=tle') ? body('normal.tle') : body('normal.json') })),
  });
  const provider = opts.provider ?? new CelestrakProvider({ propagator: new CircularOrbitPropagator() });
  return { ctx, provider };
}

test('catalog is fetched once per 2 h; positions are re-propagated on every poll', async () => {
  const { ctx, provider } = setup();
  await provider.initialize(ctx);
  await provider.start();
  const first = await provider.query({ signal: signal(), background: true });
  assert.equal(first.length, 12);
  assert.equal(ctx.http.requests.length, 1);
  assert.equal(ctx.http.requests[0]?.url, 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json');

  ctx.clock.advance(15_000);
  const second = await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 1, 'no upstream request within the reuse window');
  const issA = first.find((o) => o.externalId === '25544')!;
  const issB = second.find((o) => o.externalId === '25544')!;
  assert.equal(issA.id, issB.id, 'observation identity follows the element set, not the propagation tick');
  assert.notEqual(issA.position?.longitude, issB.position?.longitude, 'position moved between polls');
  assert.equal(issB.payload['propagatedAt'], '2026-09-21T08:05:15.000Z');
  assert.equal((await provider.health()).status, 'LIVE');
  assert.equal((await provider.health()).cacheAgeMs, 0);

  ctx.clock.advance(CATALOG_MAX_AGE_MS);
  await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 2, 'refetched after the reuse window');
  assert.equal(provider.catalogAge('stations'), 0);
});

test('a cached catalog survives provider restarts through ProviderCache', async () => {
  const { ctx, provider } = setup();
  await provider.initialize(ctx);
  await provider.start();
  await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 1);
  const stored = await ctx.cache.get('catalog:stations:json');
  assert.ok(stored && restoreEntry(stored.value)?.elements.length === 12);

  const again = new CelestrakProvider({ propagator: new CircularOrbitPropagator() });
  await again.initialize(ctx);
  await again.start();
  ctx.clock.advance(60_000);
  const obs = await again.query({ signal: signal(), background: true });
  assert.equal(obs.length, 12);
  assert.equal(ctx.http.requests.length, 1, 'second instance reused the cached catalog');
  assert.equal(restoreEntry({ group: 'x', format: 'json', fetchedAt: 'nope', elements: [] }), undefined);
  assert.equal(
    restoreEntry({ group: 'x', format: 'json', fetchedAt: new Date(START).toISOString(), elements: [{ noradId: 1 }] }),
    undefined,
  );
});

test('stale bodies from the network layer are used but not re-requested for 10 min, and surface as STALE health', async () => {
  const { ctx, provider } = setup();
  let serveStale = false;
  const inner: ProviderHttp = ctx.http;
  const wrapped: ProviderHttp = {
    async request(req: ProviderHttpRequest): Promise<ProviderHttpResponse> {
      const res = await inner.request(req);
      return serveStale ? { ...res, fromCache: true, stale: true, ageMs: 3 * 3600_000 } : res;
    },
  };
  const staleCtx = { ...ctx, http: wrapped };
  await provider.initialize(staleCtx);
  await provider.start();
  await provider.query({ signal: signal(), background: true });
  ctx.clock.advance(CATALOG_MAX_AGE_MS + 1);
  serveStale = true;
  const obs = await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 2);
  assert.equal(obs[0]?.provenance.origin, 'cached');
  const h = await provider.health();
  assert.equal(h.status, 'STALE');
  assert.equal(h.cacheAgeMs, 3 * 3600_000);
  ctx.clock.advance(60_000);
  await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 2, 'no retry within retryAfterStaleMs');
  ctx.clock.advance(10 * 60_000);
  await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 3, 'retried after the gap');
});

test('HTTP 403 from CelesTrak is a rate-limit signal; 429 keeps the server retry-after', () => {
  const blocked = mapUpstreamError(new ProviderError('AUTH', 'HTTP 403', { httpStatus: 403 }));
  assert.equal(blocked.code, 'RATE_LIMITED');
  assert.equal(blocked.retryAfterMs, 2 * 3600_000);
  const unauthorized = mapUpstreamError(new ProviderError('AUTH', 'HTTP 401', { httpStatus: 401 }));
  assert.equal(unauthorized.code, 'AUTH');
  const rate = mapUpstreamError(
    new ProviderError('RATE_LIMITED', 'HTTP 429', { httpStatus: 429, retryAfterMs: 45_000 }),
  );
  assert.equal(rate.retryAfterMs, 45_000);
  assert.equal(mapUpstreamError(new Error('x')).code, 'INTERNAL');
});

test('settings: unknown groups are dropped, maxObjects truncates each group, TLE format is honoured', async () => {
  assert.deepEqual(
    parseSettings({ groups: ['stations', 'bogus', 'stations', 'geo'], maxObjects: 999_999, format: 'tle' }),
    { groups: ['stations', 'geo'], maxObjects: 20_000, format: 'tle' },
  );
  assert.deepEqual(parseSettings({ groups: [], maxObjects: 0.5, format: 'xml' }), {});
  const { ctx, provider } = setup({ settings: { groups: ['stations', 'visual'], maxObjects: 3, format: 'tle' } });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 2);
  assert.ok(ctx.http.requests.every((r) => r.url.endsWith('&FORMAT=tle')));
  assert.equal(obs.length, 3, 'both groups carry the same 3 objects; dedupe keeps the first group');
  assert.equal(obs[0]?.payload['line2']?.toString().startsWith('2 '), true);
});

test('a missing propagator library surfaces as UNSUPPORTED, not as a crash', async () => {
  const propagator = new SatelliteJsPropagator(() => Promise.reject(new Error("Cannot find package 'satellite.js'")));
  const { ctx, provider } = setup({ provider: new CelestrakProvider({ propagator }) });
  await provider.initialize(ctx);
  await provider.start();
  await assert.rejects(
    provider.query({ signal: signal(), background: true }),
    (err: unknown) =>
      err instanceof ProviderError && err.code === 'UNSUPPORTED' && /satellite\.js is not available/.test(err.message),
  );
  assert.equal(ctx.http.requests.length, 0);
  assert.equal((await provider.health()).status, 'ERROR');
});

test('raising maxObjects takes effect on the next poll, from the catalog already held', async () => {
  const { ctx, provider } = setup({ settings: { groups: ['stations'], maxObjects: 4 } });
  await provider.initialize(ctx);
  await provider.start();
  assert.equal((await provider.query({ signal: signal(), background: true })).length, 4);
  (ctx.settings as testing.MemorySettings).update({ groups: ['stations'], maxObjects: 20_000 });
  const all = await provider.query({ signal: signal(), background: true });
  assert.equal(all.length, 12, 'every element set in the catalog');
  assert.equal(ctx.http.requests.length, 1, 'without fetching the catalog again (CelesTrak asks for once per 2 h)');
});
