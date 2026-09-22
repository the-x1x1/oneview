import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing } from '@worldview/provider-sdk';
import { AdsbLolProvider } from './index.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');
const envelope = (ac: unknown[]) => JSON.stringify({ ac, now: NOW, total: ac.length, msg: 'No error' });

test('provider: without bounds or homePosition the query is skipped, health explains why', async () => {
  const p = new AdsbLolProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW + 5000),
    responder: () => ({ status: 200, body: envelope([]) }),
  });
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({ signal: new AbortController().signal, background: true });
  assert.deepEqual(obs, []);
  assert.equal(ctx.http.requests.length, 0, 'no request without a centre');
  const h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.match(h.message ?? '', /no viewport bounds and no homePosition/);
});

test('provider: viewport bounds drive the endpoint; settings change is picked up', async () => {
  const p = new AdsbLolProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW + 5000),
    responder: () => ({
      status: 200,
      body: envelope([{ hex: 'a4b2c3', lat: 21.5, lon: -157.9, alt_baro: 3000, seen_pos: 1 }]),
    }),
  });
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -158.5, south: 20.9, east: -157.3, north: 21.8 },
  });
  assert.equal(obs.length, 1);
  assert.equal(ctx.http.requests[0]?.url, 'https://api.adsb.lol/v2/lat/21.40/lon/-157.90/dist/55');
  assert.equal((await p.health()).message, undefined);

  ctx.settings.update({ homePosition: { latitude: 19.74, longitude: -156.05, radiusNm: 60 } });
  await p.query({ signal: new AbortController().signal, background: true });
  assert.equal(ctx.http.requests[1]?.url, 'https://api.adsb.lol/v2/lat/19.74/lon/-156.05/dist/60');
  assert.equal(p.lastPointQuery?.radiusNm, 60);
});

test('provider: a feed where every row is unusable (other than missing positions) is MALFORMED; Mode S-only feeds are empty and LIVE', async () => {
  let body = envelope([
    { hex: 'a6c6d6', type: 'mode_s', flight: 'HAL22' },
    { hex: 'a6c6d7', type: 'mode_s' },
  ]);
  const p = new AdsbLolProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW + 5000),
    settings: { homePosition: { latitude: 21.32, longitude: -157.92 } },
    responder: () => ({ status: 200, body }),
  });
  await p.initialize(ctx);
  await p.start();
  assert.deepEqual(await p.query({ signal: new AbortController().signal, background: true }), []);
  assert.equal((await p.health()).status, 'LIVE');
  body = envelope([{ hex: 'zz', lat: 1, lon: 2 }, 'junk']);
  await assert.rejects(
    p.query({ signal: new AbortController().signal, background: true }),
    (e: { code?: string }) => e.code === 'MALFORMED',
  );
});
