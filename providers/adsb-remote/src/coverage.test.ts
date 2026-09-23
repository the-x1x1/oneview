import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing } from '@worldview/provider-sdk';
import { CoveragePlanner, POINT_EVERY, TYPE_KEEP_MS, TYPE_MIN_REFRESH_MS, typeQueryUrl } from './coverage.js';
import { pointQueryForBounds } from './bounds.js';
import { AdsbLolProvider } from './index.js';

const disc = { latitude: 40, longitude: -100, radiusNm: 250, clipped: true };

test('CoveragePlanner: a view one point query covers gets it every poll', () => {
  const p = new CoveragePlanner(['A320', 'B738']);
  for (let i = 0; i < 5; i++) assert.equal(p.next({ ...disc, clipped: false }, i)?.kind, 'point');
  assert.equal(p.next(undefined, 0), undefined, 'no centre, no request');
});

test('CoveragePlanner: a wide view alternates the point query with types, commonest first, then the most overdue', () => {
  const p = new CoveragePlanner(['A320', 'B738', 'C172']);
  const asked: string[] = [];
  let now = 0;
  for (let i = 0; i < 6; i++) {
    const r = p.next(disc, now)!;
    asked.push(r.kind === 'point' ? 'point' : r.type);
    if (r.kind === 'type') p.record(r.type, r.type === 'A320' ? 1600 : r.type === 'B738' ? 1400 : 16, now);
    now += 10_000;
  }
  assert.deepEqual(
    asked,
    ['point', 'A320', 'B738', 'point', 'C172', 'point'],
    `one in ${POINT_EVERY} is the point; all types refreshed within a minute → point`,
  );
  // Ten minutes on, every answer is old: the commonest types score highest (age × √count).
  now = 600_000;
  p.next(disc, now); // the point turn? (turn 6 → point)
  const r = p.next(disc, now)!;
  assert.equal(r.kind, 'type');
  assert.equal((r as { type: string }).type, 'A320');
  // A type with 1/100 the aircraft waits ~10× as long: at equal age it loses to A320 and B738.
  p.record('A320', 1600, now);
  p.record('B738', 1400, now);
  assert.equal(p.nextType(now + TYPE_MIN_REFRESH_MS), 'C172', 'and wins once the big ones are fresh');
  assert.deepEqual(p.summary(now), { types: 3, oldestAgeMs: 560_000 });
  assert.equal(p.summary(now + TYPE_KEEP_MS + 1).types, 0);
});

test('typeQueryUrl: only ICAO type designators', () => {
  assert.equal(typeQueryUrl('https://api.adsb.lol/v2', 'A20N'), 'https://api.adsb.lol/v2/type/A20N');
  assert.throws(() => typeQueryUrl('https://api.adsb.lol/v2', '../x'));
});

test('pointQueryForBounds: a clipped disc goes to the view centre, not the middle of globe-wide bounds', () => {
  const world = { west: -180, south: -85, east: 180, north: 85 };
  assert.deepEqual(
    [pointQueryForBounds(world)!.latitude, pointQueryForBounds(world)!.longitude],
    [0, 0],
    'the middle of the world is the Gulf of Guinea',
  );
  const q = pointQueryForBounds(world, 250, { latitude: 39.87, longitude: -98.53 })!;
  assert.deepEqual([q.latitude, q.longitude, q.clipped], [39.9, -98.5, true]);
  const small = pointQueryForBounds({ west: -158.5, south: 20.9, east: -157.3, north: 21.8 }, 250, {
    latitude: 0,
    longitude: 0,
  })!;
  assert.deepEqual([small.latitude, small.longitude], [21.4, -157.9], 'a covered view keeps its own centre');
});

const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const row = (hex: string, lat: number, lon: number, t = 'A320') => ({
  hex,
  lat,
  lon,
  t,
  alt_baro: 35000,
  gs: 450,
  track: 90,
  seen_pos: 1,
});
const envelope = (ac: unknown[]) => JSON.stringify({ ac, now: NOW, total: ac.length, msg: 'No error' });

test('provider: zoomed out it fills in worldwide by type; the snapshot keeps every current answer, the disc wins inside it', async () => {
  let pointRows: unknown[] = [row('aaaaa1', 40, -100)];
  const serve: { as?: 'cache' } = {};
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW),
    responder: (req) => {
      if (req.url.includes('/type/A320'))
        return { body: envelope([row('bbbbb1', 51.5, -0.1), row('ccccc1', 40.1, -100.1)]) };
      if (req.url.includes('/type/B738')) return { body: envelope([row('ddddd1', 35.6, 139.7, 'B738')]) };
      return { body: envelope(pointRows), ...(serve.as ? { served: serve.as } : {}) };
    },
  });
  const p = new AdsbLolProvider({ types: ['A320', 'B738'] });
  await p.initialize(ctx);
  await p.start();
  const q = {
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -180, south: -85, east: 180, north: 85 },
    center: { latitude: 40, longitude: -100 },
  };
  const ids = (obs: { externalId?: string }[]) => obs.map((o) => o.externalId).sort();
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1']);
  assert.equal(
    ctx.http.requests[0]!.url,
    'https://api.adsb.lol/v2/lat/40.00/lon/-100.00/dist/250',
    'at the view centre',
  );
  ctx.clock.advance(10_000);
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1', 'ccccc1']);
  assert.equal(ctx.http.requests[1]!.url, 'https://api.adsb.lol/v2/type/A320');
  ctx.clock.advance(10_000);
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1', 'ccccc1', 'ddddd1']);
  // The point query again: ccccc1 (inside the disc) is no longer in it — it has landed or
  // left — so the older type answer does not keep it on the map.
  ctx.clock.advance(10_000);
  pointRows = [row('aaaaa1', 40.2, -99.8)];
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1', 'ddddd1']);
  assert.match((await p.health()).message ?? '', /2 common airliner and business-jet types worldwide/);
  // An answer served again from the cache hands back the same observations, not copies.
  const before = await p.query({ ...q, bounds: { west: -101, south: 39, east: -99, north: 41 } });
  serve.as = 'cache';
  ctx.clock.advance(10_000);
  const again = await p.query({ ...q, bounds: { west: -101, south: 39, east: -99, north: 41 } });
  const a1 = before.find((o) => o.externalId === 'aaaaa1');
  assert.ok(a1 && again.includes(a1), 'the very same observation object');
});
