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
  // The category groups (categories.ts) are two more requests on the same cadence; these
  // tests count the configured groups' requests, so they leave them out. The category
  // groups have their own test below.
  const provider =
    opts.provider ?? new CelestrakProvider({ propagator: new CircularOrbitPropagator(), categoryGroups: [] });
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

  const again = new CelestrakProvider({ propagator: new CircularOrbitPropagator(), categoryGroups: [] });
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
  const { ctx, provider } = setup({ provider: new CelestrakProvider({ propagator, categoryGroups: [] }) });
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

test('categories: the military and gnss lists are fetched on the catalogue cadence and decide a category; a failed refresh keeps the last list', async () => {
  let militaryDown = false;
  // The lists are ordinary GP answers; here each is a one-object OMM array (invented values).
  const omm = (name: string, id: number) =>
    JSON.stringify([{ ...JSON.parse(body('normal.json'))[0], OBJECT_NAME: name, NORAD_CAT_ID: id }]);
  const { ctx } = setup({
    settings: { groups: ['active'] },
    responder: (req) => {
      if (req.url.includes('GROUP=military'))
        return militaryDown ? { status: 503, body: '' } : { status: 200, body: omm('LANDSAT 9', 49260) };
      if (req.url.includes('GROUP=gnss')) return { status: 200, body: omm('HST', 20580) };
      return { status: 200, body: body('normal.json') };
    },
  });
  const provider = new CelestrakProvider({ propagator: new CircularOrbitPropagator() });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: signal(), background: true });
  const urls = ctx.http.requests.map((r) => r.url);
  assert.deepEqual(urls, [
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=military&FORMAT=json',
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=gnss&FORMAT=json',
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json',
  ]);
  const category = (id: string) => obs.find((o) => o.externalId === id)?.payload['satelliteCategory'];
  assert.equal(category('49260'), 'military', 'on the military list (invented membership), whatever its name');
  assert.equal(category('20580'), 'navigation', 'on the gnss list (invented membership)');
  assert.equal(category('25544'), 'station');
  assert.equal(category('57001'), 'starlink');
  assert.equal(category('40697'), 'earth-observation', 'by name');
  assert.equal(obs.length, 12, 'the lists add no satellites of their own');

  // Within the two hours, nothing is asked for again.
  ctx.clock.advance(15_000);
  await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests.length, 3);

  // After them the lists are refreshed with the catalogue; one that fails is not retried
  // every poll, and the list it last gave stands.
  militaryDown = true;
  ctx.clock.advance(CATALOG_MAX_AGE_MS + 25 * 3600_000);
  const later = await provider.query({ signal: signal(), background: true });
  const asked = ctx.http.requests.length;
  assert.ok(asked > 3);
  assert.equal(later.length, 12, 'a failed category list does not fail the poll');
  assert.equal(later.find((o) => o.externalId === '49260')?.payload['satelliteCategory'], 'military');
  ctx.clock.advance(15_000);
  await provider.query({ signal: signal(), background: true });
  assert.equal(
    ctx.http.requests.filter((r) => r.url.includes('GROUP=military')).length,
    ctx.http.requests.slice(0, asked).filter((r) => r.url.includes('GROUP=military')).length,
    'the failed list is not asked for again on the next poll',
  );
});

test('objectTrack: one period of the selected satellite ahead, from the element set it carries', async () => {
  const { ctx, provider } = setup();
  await provider.initialize(ctx);
  await provider.start();
  const [iss] = (await provider.query({ signal: signal(), background: true })).filter((o) => o.externalId === '25544');
  const answer = await provider.objectTrack({
    objectId: 'satellite:norad:25544',
    objectType: 'satellite',
    externalId: '25544',
    properties: iss!.payload,
    time: { start: new Date(START - 3600_000).toISOString(), end: new Date(START).toISOString() },
    signal: signal(),
  });
  assert.ok(answer);
  assert.equal(answer.kind, 'prediction');
  assert.match(answer.label, /Predicted orbit/);
  assert.equal(answer.points[0]!.observedAt, new Date(START).toISOString());
  const spanMin = (Date.parse(answer.points.at(-1)!.observedAt) - START) / 60_000;
  assert.ok(Math.abs(spanMin - (iss!.payload['periodMinutes'] as number)) < 0.01);
  assert.equal(
    await provider.objectTrack({
      objectId: 'aircraft:icao24:abcdef',
      objectType: 'aircraft',
      properties: {},
      time: { start: new Date(START).toISOString(), end: new Date(START).toISOString() },
      signal: signal(),
    }),
    undefined,
  );
});
