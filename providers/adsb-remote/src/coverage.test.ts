import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing } from '@worldview/provider-sdk';
import { haversineMeters } from '@worldview/world-model';
import {
  CIRCLE_KEEP_MS,
  CIRCLE_MIN_REFRESH_MS,
  CoveragePlanner,
  MAX_CIRCLES,
  MIL_REFRESH_MS,
  POINT_EVERY,
  TYPE_KEEP_MS,
  TYPE_MIN_REFRESH_MS,
  militaryQueryUrl,
  typeQueryUrl,
} from './coverage.js';
import { pointQueryForBounds } from './bounds.js';
import { AdsbLolProvider } from './index.js';
import { RequestBudget } from './budget.js';
import { PRIOR_BASELINE, priorAircraft, tileContains, tilesForBounds, type Tile } from './tiles.js';

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
  for (let i = 0; i < 7; i++) {
    const r = p.next(disc, now)!;
    asked.push(r.kind === 'type' ? r.type : r.kind);
    if (r.kind === 'type') p.record(r.type, r.type === 'A320' ? 1600 : r.type === 'B738' ? 1400 : 16, now);
    if (r.kind === 'mil') p.recordMilitary(300, now);
    now += 10_000;
  }
  assert.deepEqual(
    asked,
    ['point', 'mil', 'A320', 'point', 'B738', 'C172', 'point'],
    `one in ${POINT_EVERY} is the point; the military list first, then types; all refreshed within a minute → point`,
  );
  // Ten minutes on, every answer is old: the military list is due, then the commonest types
  // score highest (age × √count).
  now = 600_000;
  assert.equal(p.next(disc, now)!.kind, 'mil', 'turn 7: the military list is due again');
  p.recordMilitary(300, now);
  const r = p.next(disc, now)!;
  assert.equal(r.kind, 'type');
  assert.equal((r as { type: string }).type, 'A320');
  // A type with 1/100 the aircraft waits ~10× as long: at equal age it loses to A320 and B738.
  p.record('A320', 1600, now);
  p.record('B738', 1400, now);
  assert.equal(p.nextType(now + TYPE_MIN_REFRESH_MS), 'C172', 'and wins once the big ones are fresh');
  assert.deepEqual(p.summary(now), { types: 3, oldestAgeMs: 550_000, military: true });
  assert.equal(p.summary(now + TYPE_KEEP_MS + 1).types, 0);
});

test('CoveragePlanner: the military list is asked for once a minute while wide, never while one disc covers the view', () => {
  const p = new CoveragePlanner(['A320']);
  for (let i = 0; i < 12; i++) assert.notEqual(p.next({ ...disc, clipped: false }, i * 10_000)?.kind, 'mil');
  const kinds: string[] = [];
  for (let t = 0; t < 120_000; t += 10_000) {
    const r = p.next(disc, t)!;
    kinds.push(r.kind);
    if (r.kind === 'mil') p.recordMilitary(250, t);
    if (r.kind === 'type') p.record(r.type, 1600, t);
  }
  assert.equal(
    kinds.filter((k) => k === 'mil').length,
    2,
    `two minutes → two military lists (every ${MIL_REFRESH_MS} ms)`,
  );
  assert.equal(kinds.length, 12, 'still exactly one request a poll');
  // A failed request waits its minute like an answered one; the count it had is kept.
  const q = new CoveragePlanner(['A320']);
  q.recordMilitary(250, 0);
  q.deferredMilitary(70_000);
  assert.equal(q.militaryDue(100_000), false);
  assert.equal(q.militaryDue(130_000), true);
  assert.equal(q.summary(130_000).military, true);
  assert.equal(new CoveragePlanner().summary(0).military, false);
});

test('militaryQueryUrl: the documented /v2/mil list', () => {
  assert.equal(militaryQueryUrl('https://api.adsb.lol/v2'), 'https://api.adsb.lol/v2/mil');
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
      // Invented rows in the published /v2/mil shape (this one without dbFlags, which the list implies).
      if (req.url.endsWith('/v2/mil')) return { body: envelope([row('eeeee1', 55.9, -11.2, 'C17')]) };
      return { body: envelope(pointRows), ...(serve.as ? { served: serve.as } : {}) };
    },
  });
  // The rotation, not the request budget, is what this test is about: every poll may ask.
  const p = new AdsbLolProvider({ types: ['A320', 'B738'], pacing: false });
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
  const withMil = await p.query(q);
  assert.deepEqual(ids(withMil), ['aaaaa1', 'eeeee1']);
  assert.equal(ctx.http.requests[1]!.url, 'https://api.adsb.lol/v2/mil', 'the military list first');
  assert.equal(withMil.find((o) => o.externalId === 'eeeee1')!.payload['military'], true, 'tagged military');
  assert.equal(withMil.find((o) => o.externalId === 'aaaaa1')!.payload['military'], false);
  ctx.clock.advance(10_000);
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1', 'ccccc1', 'eeeee1']);
  assert.equal(ctx.http.requests[2]!.url, 'https://api.adsb.lol/v2/type/A320');
  // The point query again: ccccc1 (inside the disc) is no longer in it — it has landed or
  // left — so the older type answer does not keep it on the map.
  ctx.clock.advance(10_000);
  pointRows = [row('aaaaa1', 40.2, -99.8)];
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1', 'eeeee1']);
  ctx.clock.advance(10_000);
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1', 'ddddd1', 'eeeee1']);
  assert.match((await p.health()).message ?? '', /military aircraft worldwide, and 2 common airliner/);
  // An answer served again from the cache hands back the same observations, not copies.
  const before = await p.query({ ...q, bounds: { west: -101, south: 39, east: -99, north: 41 } });
  serve.as = 'cache';
  ctx.clock.advance(10_000);
  const again = await p.query({ ...q, bounds: { west: -101, south: 39, east: -99, north: 41 } });
  const a1 = before.find((o) => o.externalId === 'aaaaa1');
  assert.ok(a1 && again.includes(a1), 'the very same observation object');
});

const CONUS = { west: -125, south: 24, east: -66, north: 50 };
const KANSAS = { latitude: 39, longitude: -98 };

test('CoveragePlanner: a regional view is asked for circle by circle — the centre first, then the busy areas, then the rest', () => {
  const tiles = tilesForBounds(CONUS, MAX_CIRCLES)!;
  const p = new CoveragePlanner(['A320']);
  const q = pointQueryForBounds(CONUS, 250, KANSAS)!;
  const view = { tiles, centre: KANSAS };
  const asked: Tile[] = [];
  let now = 0;
  for (let i = 0; i < tiles.length; i++) {
    const r = p.next(q, now, view)!;
    assert.equal(r.kind, 'circle', 'never a type or the military list while circles cover the view');
    const t = (r as { tile: Tile }).tile;
    asked.push(t);
    p.recordCircle(t.id, priorAircraft(t), now);
    now += 1_000;
  }
  assert.ok(tileContains(asked[0]!, KANSAS), 'the circle under the view centre first');
  const busy = tiles.filter((t) => priorAircraft(t) >= 300);
  const firstBusy = new Set(asked.slice(0, busy.length + 1).map((t) => t.id));
  for (const t of busy)
    assert.ok(firstBusy.has(t.id), `busy circle ${t.id} (${priorAircraft(t)}) in the first pass's lead`);
  // Everything was asked for within the last 30 s: nothing is due, the poll asks nothing.
  const pp = new CoveragePlanner();
  for (const t of tiles) pp.recordCircle(t.id, 10, 0);
  assert.equal(pp.next(q, CIRCLE_MIN_REFRESH_MS - 1, view), undefined);
  assert.equal(pp.next(q, CIRCLE_MIN_REFRESH_MS, view)?.kind, 'circle');
  // A failed circle waits its turn like an answered one, and is not reported as answered.
  const f = new CoveragePlanner();
  f.deferredCircle(tiles[0]!.id, 0);
  assert.deepEqual(f.circleSummary(tiles, 1_000), {
    circles: tiles.length,
    answered: 0,
    recent: 0,
    oldestAgeMs: undefined,
  });
});

test('CoveragePlanner + RequestBudget, 20 virtual minutes over the contiguous US: within budget, busy circles first and most often', () => {
  const tiles = tilesForBounds(CONUS, MAX_CIRCLES)!;
  const q = pointQueryForBounds(CONUS, 250, KANSAS)!;
  const view = { tiles, centre: KANSAS };
  const planner = new CoveragePlanner();
  const budget = new RequestBudget();
  // Each circle "holds" its prior count of aircraft — invented, for the test.
  const truth = new Map(tiles.map((t) => [t.id, priorAircraft(t)]));
  const total = [...truth.values()].reduce((a, b) => a + b, 0);
  const asks = new Map<string, number[]>();
  const shown = (now: number) =>
    tiles
      .filter((t) => (asks.get(t.id) ?? []).some((at) => now - at <= CIRCLE_KEEP_MS))
      .reduce((a, t) => a + truth.get(t.id)!, 0) / total;
  const coverageAt: Record<string, number> = {};
  let sent = 0;
  for (let now = 0; now < 20 * 60_000; now += 10_000) {
    for (const m of [1, 2, 3, 5, 10, 15, 19]) if (now === m * 60_000) coverageAt[`${m} min`] = shown(now);
    if (!budget.mayPoll(now)) continue;
    const r = planner.next(q, now, view);
    if (!r) continue;
    assert.equal(r.kind, 'circle');
    const t = (r as { tile: Tile }).tile;
    budget.sending(now);
    sent++;
    const at = asks.get(t.id) ?? [];
    if (at.length) assert.ok(now - at[at.length - 1]! >= CIRCLE_MIN_REFRESH_MS, 'never twice within 30 s');
    at.push(now);
    asks.set(t.id, at);
    planner.recordCircle(t.id, truth.get(t.id)!, now);
    budget.answered(now);
  }
  // Budget: 4 a minute rising to 6, never more than one a ten-second poll.
  assert.ok(sent <= 20 * 6, `${sent} requests in 20 min`);
  assert.ok(sent >= 20 * 4, `${sent} requests in 20 min: the budget is used`);
  // Every circle answered within the twenty minutes; the busy ones far more often than the empty ones.
  for (const t of tiles) assert.ok(asks.has(t.id), `circle ${t.id} never asked`);
  const busiest = Math.max(...[...truth.values()]);
  const busyAsks = Math.min(...tiles.filter((t) => truth.get(t.id) === busiest).map((t) => asks.get(t.id)!.length));
  const emptyAsks = Math.max(
    ...tiles.filter((t) => truth.get(t.id) === PRIOR_BASELINE).map((t) => asks.get(t.id)!.length),
  );
  assert.ok(busyAsks >= 2 * emptyAsks, `busiest circle asked ${busyAsks}×, an empty one ${emptyAsks}×`);
  // Share of the (invented) aircraft over the view held by current circle answers.
  assert.ok(coverageAt['2 min']! >= 0.4, `2 min: ${coverageAt['2 min']}`);
  assert.ok(coverageAt['5 min']! >= 0.85, `5 min: ${coverageAt['5 min']}`);
  assert.ok(coverageAt['10 min']! >= 0.97, `10 min: ${coverageAt['10 min']}`);
});

const circleRow = (hex: string, lat: number, lon: number) => row(hex, lat, lon);

test('provider: a regional view shows every circle it has asked for, one a poll within the budget; a newer circle drops what it no longer has', async () => {
  const EUROPE_CORE = { west: -12, south: 36, east: 30, north: 60 };
  const LONDON = { latitude: 51.47, longitude: -0.45 };
  const tiles = tilesForBounds(EUROPE_CORE, MAX_CIRCLES)!;
  const answers = new Map<string, unknown[]>();
  const urlOf = (t: Tile) =>
    `https://api.adsb.lol/v2/lat/${t.latitude.toFixed(2)}/lon/${t.longitude.toFixed(2)}/dist/250`;
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW),
    responder: (req) => {
      const t = tiles.find((x) => urlOf(x) === req.url);
      return { body: envelope(t ? (answers.get(t.id) ?? []) : []) };
    },
  });
  const p = new AdsbLolProvider();
  await p.initialize(ctx);
  await p.start();
  const q = { signal: new AbortController().signal, background: true, bounds: EUROPE_CORE, center: LONDON };
  const ids = (obs: { externalId?: string }[]) => obs.map((o) => o.externalId).sort();
  // Which circles the provider will ask for first and second: the same planner, on the same answers.
  const replica = new CoveragePlanner();
  const view = { tiles, centre: LONDON };
  const point = pointQueryForBounds(EUROPE_CORE, 250, LONDON)!;
  const first = (replica.next(point, NOW, view) as { tile: Tile }).tile;
  assert.equal(first, [...tiles].sort((x, y) => haversineMeters(x, LONDON) - haversineMeters(y, LONDON))[0]);
  replica.recordCircle(first.id, 2, NOW);
  const neighbour = (replica.next(point, NOW + 15_000, view) as { tile: Tile }).tile;
  const near = (pred: (p: { latitude: number; longitude: number }) => boolean) => {
    for (let dy = -4; dy <= 4; dy += 0.25)
      for (let dx = -6; dx <= 6; dx += 0.25) {
        const p = { latitude: first.latitude + dy, longitude: first.longitude + dx };
        if (pred(p)) return p;
      }
    throw new Error(`no such point near ${first.id}`);
  };
  const mid = near((p) => tileContains(first, p) && tileContains(neighbour, p));
  const away = near((p) => tileContains(first, p) && !tileContains(neighbour, p));
  answers.set(first.id, [
    circleRow('aaaaa1', away.latitude, away.longitude),
    circleRow('bbbbb1', mid.latitude, mid.longitude),
  ]);
  answers.set(neighbour.id, [circleRow('ccccc1', neighbour.latitude, neighbour.longitude)]);
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1']);
  assert.equal(ctx.http.requests[0]!.url, urlOf(first), 'the circle under the view centre');
  // Ten seconds on the budget (4 a minute to start) has no whole token: the poll asks nothing.
  ctx.clock.advance(10_000);
  assert.deepEqual(ids(await p.query(q)), ['aaaaa1', 'bbbbb1']);
  assert.equal(ctx.http.requests.length, 1);
  assert.equal(p.budgetSummary().withheld, 1);
  // Five more seconds: a token, and the next circle — the busiest of the rest, which overlaps the first.
  ctx.clock.advance(5_000);
  assert.deepEqual(
    ids(await p.query(q)),
    ['aaaaa1', 'ccccc1'],
    'bbbbb1 is inside the newer disc and not in its answer',
  );
  assert.equal(ctx.http.requests[1]!.url, urlOf(neighbour));
  assert.match(
    (await p.health()).message ?? '',
    /from 30 circles of 250 nm asked for in turn, busiest first: 2 answered, 2 in the last 2 min/,
  );
  // Zoomed in elsewhere for more than ten minutes, the circles' answers age out.
  const hawaii = {
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -158.5, south: 20.9, east: -157.3, north: 21.8 },
  };
  ctx.clock.advance(CIRCLE_KEEP_MS + 1_000);
  assert.deepEqual(ids(await p.query(hawaii)), []);
});

test('provider: a 429 fails the poll as RATE_LIMITED, halves the budget, and nothing is asked until its Retry-After', async () => {
  let limited = true;
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW),
    responder: () =>
      limited
        ? { status: 429, headers: { 'retry-after': '30' }, body: '' }
        : { body: envelope([row('aaaaa1', 21.4, -157.9)]) },
  });
  const p = new AdsbLolProvider();
  await p.initialize(ctx);
  await p.start();
  const q = {
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -158.5, south: 20.9, east: -157.3, north: 21.8 },
  };
  await assert.rejects(p.query(q), (e: { code?: string }) => e.code === 'RATE_LIMITED');
  assert.equal(ctx.http.requests[0]!.allowStale, false, 'never hidden behind the stale cache');
  assert.equal(p.budgetSummary().perMinute, 2);
  const h = await p.health();
  assert.equal(h.status, 'RATE_LIMITED');
  assert.match(h.message ?? '', /adsb\.lol asked for a pause: next request in 30 s, then 2 a minute/);
  limited = false;
  for (let t = 10_000; t < 30_000; t += 10_000) {
    ctx.clock.advance(10_000);
    assert.deepEqual(await p.query(q), [], 'nothing held yet, nothing asked');
    assert.equal(ctx.http.requests.length, 1);
  }
  ctx.clock.advance(40_000); // past the Retry-After, and a token at 2 a minute
  assert.equal((await p.query(q)).length, 1);
  assert.equal(ctx.http.requests.length, 2);
  assert.equal((await p.health()).status, 'LIVE');
});
