import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import { DigitrafficAisProvider } from './index.js';
import { DIGITRAFFIC_USER, METADATA_REFRESH_MS, locationsUrl, vesselsUrl } from './manifest.js';

const NOW = Date.parse('2026-09-28T10:00:30.000Z');
const collection = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const ship = (mmsi: number, at: number) => ({
  type: 'Feature',
  mmsi,
  geometry: { type: 'Point', coordinates: [24.95, 60.14] },
  properties: { mmsi, sog: 10, cog: 90, heading: 91, navStat: 0, timestampExternal: at },
});
const isVessels = (req: ProviderHttpRequest) => new URL(req.url).pathname.endsWith('/vessels');

async function setup(responder: testing.FixtureResponder) {
  const clock = new testing.VirtualClock(NOW);
  const ctx = testing.createFixtureContext({ providerId: 'digitraffic-ais', clock, responder });
  const p = new DigitrafficAisProvider();
  await p.initialize(ctx);
  await p.start();
  const poll = () => p.query({ signal: new AbortController().signal, background: true });
  return { p, ctx, clock, poll };
}

test('urls: positions of the last quarter hour on the whole minute; static data since a time', () => {
  assert.equal(locationsUrl(NOW), `https://meri.digitraffic.fi/api/ais/v1/locations?from=${NOW - 30_000 - 900_000}`);
  assert.equal(locationsUrl(NOW + 29_000), locationsUrl(NOW), 'retries within the minute ask the same');
  assert.equal(vesselsUrl(undefined), 'https://meri.digitraffic.fi/api/ais/v1/vessels');
  assert.equal(vesselsUrl(1234.9), 'https://meri.digitraffic.fi/api/ais/v1/vessels?from=1234');
});

test('provider: identifies itself, asks for static data once, then only what changed', async () => {
  const { ctx, clock, poll } = await setup((req) =>
    isVessels(req)
      ? { status: 200, body: JSON.stringify([{ mmsi: 230145250, name: 'TESTFERRY', timestamp: NOW - 60_000 }]) }
      : { status: 200, body: collection([ship(230145250, NOW - 10_000)]) },
  );
  const first = await poll();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.payload['name'], 'TESTFERRY');
  assert.equal(first[0]!.objectType, 'vessel');
  const [loc, meta] = ctx.http.requests;
  assert.equal(loc?.url, locationsUrl(NOW));
  assert.equal(meta?.url, vesselsUrl(undefined), 'the first static-data request takes the default day');
  for (const r of ctx.http.requests) {
    assert.equal(r.headers?.['Digitraffic-User'], DIGITRAFFIC_USER);
    assert.ok(r.cacheKey, 'one cache slot per endpoint, not one per minute');
  }

  // A minute later: positions only.
  clock.advance(60_000);
  const second = await poll();
  assert.equal(ctx.http.requests.length, 3);
  assert.equal(second[0]!.payload['name'], 'TESTFERRY', 'static data is remembered between polls');

  // A quarter of an hour on: static data again, from the newest row seen less five minutes.
  clock.advance(METADATA_REFRESH_MS);
  await poll();
  const again = ctx.http.requests.filter(isVessels);
  assert.equal(again.length, 2);
  assert.equal(again[1]!.url, vesselsUrl(NOW - 60_000 - 5 * 60_000));
});

test('provider: a static-data failure does not fail the poll and is retried in two minutes', async () => {
  let metaStatus = 503;
  const { ctx, clock, poll, p } = await setup((req) =>
    isVessels(req)
      ? { status: metaStatus, body: metaStatus === 200 ? JSON.stringify([{ mmsi: 230145250, name: 'LATE' }]) : '' }
      : { status: 200, body: collection([ship(230145250, NOW - 10_000)]) },
  );
  const obs = await poll();
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.payload['name'], undefined);
  assert.equal((await p.health()).status, 'LIVE');
  assert.ok((ctx.logger as testing.MemoryLogger).entries.some((e) => e.level === 'warn'));

  clock.advance(60_000);
  await poll();
  assert.equal(ctx.http.requests.filter(isVessels).length, 1, 'not asked again after one minute');

  metaStatus = 200;
  clock.advance(60_000);
  const later = await poll();
  assert.equal(ctx.http.requests.filter(isVessels).length, 2, 'asked again after two');
  assert.equal(later[0]!.payload['name'], 'LATE');
  assert.equal(p.knownStatics, 1);
});

test('provider: one observation per ship, the newest report; the snapshot is the answer', async () => {
  let features = [ship(230145250, NOW - 50_000), ship(230145250, NOW - 5_000), ship(276829000, NOW - 20_000)];
  const { poll } = await setup((req) =>
    isVessels(req) ? { status: 200, body: '[]' } : { status: 200, body: collection(features) },
  );
  const obs = await poll();
  assert.deepEqual(obs.map((o) => o.externalId).sort(), ['230145250', '276829000']);
  assert.equal(obs.find((o) => o.externalId === '230145250')!.observedAt, new Date(NOW - 5_000).toISOString());
  features = [ship(276829000, NOW - 1_000)];
  assert.deepEqual(
    (await poll()).map((o) => o.externalId),
    ['276829000'],
    'a ship gone from the window is gone',
  );
});

test('provider: an answer in which no feature is a ship is MALFORMED', async () => {
  const { poll } = await setup((req) =>
    isVessels(req) ? { status: 200, body: '[]' } : { status: 200, body: collection(['junk', { type: 'Feature' }]) },
  );
  await assert.rejects(poll(), (e: { code?: string }) => e.code === 'MALFORMED');
});
