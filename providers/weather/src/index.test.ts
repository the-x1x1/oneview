import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, testing } from '@worldview/provider-sdk';
import { NwsAlertsProvider, mapUpstreamError, nwsUserAgent, parseSettings } from './index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'weather');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
const START = Date.parse('2026-09-21T08:05:00Z');
const signal = () => new AbortController().signal;

function setup(settings: Record<string, string | string[]> = {}, responder?: testing.FixtureResponder) {
  const ctx = testing.createFixtureContext({ providerId: 'nws-alerts', clock: new testing.VirtualClock(START), settings, responder: responder ?? (() => ({ status: 200, body: body('normal.geojson') })) });
  return { ctx, provider: new NwsAlertsProvider() };
}

test('requests identify the app to api.weather.gov and ask for GeoJSON', async () => {
  const { ctx, provider } = setup({ contact: 'ops@example.invalid' });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: signal(), background: true });
  assert.equal(obs.length, 7);
  const req = ctx.http.requests[0]!;
  assert.equal(req.url, 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update');
  assert.equal(req.headers?.['User-Agent'], 'WorldView/0.1 (contact: ops@example.invalid)');
  assert.equal(req.headers?.['Accept'], 'application/geo+json');
  assert.equal(req.cacheKey, undefined, 'default cache key (the URL) keeps ETag revalidation stable');
  const log = ctx.logger.entries.find((e) => e.message === 'NWS alerts skipped');
  assert.deepEqual(log?.fields?.['zoneOnly'], 2);
  assert.deepEqual(log?.fields?.['rejected'], 0);
});

test('without a contact the User-Agent says so instead of pretending', () => {
  assert.equal(nwsUserAgent(undefined), 'WorldView/0.1 (contact: not configured)');
  assert.equal(nwsUserAgent('https://example.invalid/worldview'), 'WorldView/0.1 (contact: https://example.invalid/worldview)');
  assert.deepEqual(parseSettings({ contact: '  ops@example.invalid\r\nX-Injected: 1 ', areas: ['tx', 'OK', 'texas', 'TX', 7] }), { contact: 'ops@example.invalid X-Injected: 1', areas: ['TX', 'OK'] });
  assert.deepEqual(parseSettings({ contact: 42, areas: 'TX' }), {});
});

test('area setting narrows the feed; 403 is reported as a configuration problem', async () => {
  const { ctx, provider } = setup({ areas: ['TX', 'OK'] });
  await provider.initialize(ctx);
  await provider.start();
  assert.equal(provider.feedUrl(), 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&area=TX,OK');
  await provider.query({ signal: signal(), background: true });
  assert.equal(ctx.http.requests[0]?.url, provider.feedUrl());
  const forbidden = mapUpstreamError(new ProviderError('AUTH', 'HTTP 403', { httpStatus: 403 }));
  assert.equal(forbidden.code, 'HTTP_4XX');
  assert.match(forbidden.message, /User-Agent/);
  assert.equal(mapUpstreamError(new ProviderError('AUTH', 'HTTP 401', { httpStatus: 401 })).code, 'AUTH');
  assert.equal(mapUpstreamError(new TypeError('x')).code, 'INTERNAL');
});

test('a feed made only of zone-based alerts is a valid, empty poll (not MALFORMED)', async () => {
  const collection = JSON.parse(body('normal.geojson')) as { features: Array<{ geometry: unknown }> };
  collection.features = collection.features.filter((f) => f.geometry === null);
  const { ctx, provider } = setup({}, () => ({ status: 200, body: JSON.stringify(collection) }));
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: signal(), background: true });
  assert.equal(obs.length, 0);
  assert.equal((await provider.health()).status, 'LIVE');
});

test('a stale body from the network layer is marked cached and ages the health', async () => {
  const { ctx, provider } = setup();
  const inner = ctx.http;
  const http = { request: async (req: Parameters<typeof inner.request>[0]) => ({ ...(await inner.request(req)), fromCache: true, stale: true, ageMs: 20 * 60_000 }) };
  await provider.initialize({ ...ctx, http });
  await provider.start();
  const obs = await provider.query({ signal: signal(), background: true });
  assert.equal(obs[0]?.provenance.origin, 'cached');
  const h = await provider.health();
  assert.equal(h.status, 'STALE');
  assert.equal(h.cacheAgeMs, 20 * 60_000);
});
