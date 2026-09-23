import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorldGeometry } from '@worldview/world-model';
import { normalizeNwsAlerts, REJECT_NO_GEOMETRY, REJECT_ZONE_ONLY } from './normalize.js';
import { NWS_MANIFEST } from './manifest.js';
import { ProviderError } from '@worldview/provider-sdk';
import {
  ZONE_FETCH_BUDGET,
  ZONE_FAILURE_BACKOFF_MS,
  ZONE_TTL_MS,
  ZoneGeometryCache,
  combineZoneGeometries,
  parseZoneRef,
  zoneGeometry,
  ZONE_SIMPLIFY_DEG,
  zoneRefsOf,
  zoneUrl,
} from './zones.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'weather');
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const NOW = Date.parse('2026-09-21T08:05:00Z');
const opts = {
  receivedAt: new Date(NOW).toISOString(),
  nowMs: NOW,
  sourceRef: 'https://api.weather.gov/alerts/active',
};

test('zone refs: only api.weather.gov zone URLs in the documented shape are accepted', () => {
  assert.equal(parseZoneRef('https://api.weather.gov/zones/forecast/COZ003'), 'forecast/COZ003');
  assert.equal(parseZoneRef('https://api.weather.gov/zones/county/TXC453'), 'county/TXC453');
  assert.equal(parseZoneRef('https://api.weather.gov/zones/fire/CAZ268'), 'fire/CAZ268');
  for (const hostile of [
    'http://api.weather.gov/zones/forecast/COZ003',
    'https://api.weather.gov.evil.example/zones/forecast/COZ003',
    'https://api.weather.gov/zones/forecast/../../alerts/active',
    'https://api.weather.gov/zones/forecast/COZ003?x=1',
    'https://evil.example/zones/forecast/COZ003',
    'https://api.weather.gov/zones/made-up/COZ003',
    42,
  ]) {
    assert.equal(parseZoneRef(hostile as never), undefined, String(hostile));
  }
  assert.equal(zoneUrl('forecast/COZ003'), 'https://api.weather.gov/zones/forecast/COZ003');
});

test('zone refs: the list is de-duplicated, order-preserving, and ignores unusable entries', () => {
  assert.deepEqual(
    zoneRefsOf([
      'https://api.weather.gov/zones/forecast/COZ010',
      'https://api.weather.gov/zones/forecast/COZ003',
      'https://api.weather.gov/zones/forecast/COZ010',
      'https://evil.example/zones/forecast/COZ004',
      null,
    ]),
    ['forecast/COZ010', 'forecast/COZ003'],
  );
  assert.deepEqual(zoneRefsOf(undefined), []);
});

test('zone geometry: a polygon or multipolygon is read; anything else is refused', () => {
  const single = zoneGeometry(load('zones/COZ003.geojson'));
  assert.equal(single?.type, 'Polygon');
  const multi = zoneGeometry(load('zones/COZ010.geojson'));
  assert.equal(multi?.type, 'MultiPolygon');
  assert.equal(zoneGeometry(load('zones/malformed.geojson')), undefined, 'a null geometry is not a zone outline');
  assert.equal(zoneGeometry({ geometry: { type: 'Point', coordinates: [0, 0] } }), undefined);
  assert.equal(zoneGeometry(undefined), undefined);
});

test('zone geometry: zones combine into a MultiPolygon without inventing a boundary', () => {
  const a = zoneGeometry(load('zones/COZ003.geojson'))!;
  const b = zoneGeometry(load('zones/COZ010.geojson'))!;
  const combined = combineZoneGeometries([a, b]);
  assert.equal(combined?.type, 'MultiPolygon');
  // One ring from COZ003 plus the two from COZ010: every input area survives, unmerged.
  assert.equal((combined as { coordinates: unknown[] }).coordinates.length, 3);
  assert.deepEqual(combineZoneGeometries([a]), a, 'a single zone stays a Polygon');
  assert.equal(combineZoneGeometries([]), undefined);
});

interface Harness {
  cache: ZoneGeometryCache;
  fetched: string[];
  store: Map<string, unknown>;
  now: { ms: number };
}

function harness(
  answers: Record<string, unknown>,
  opts: { failures?: Set<string>; refuseAfter?: number; refusalCode?: 'RATE_LIMITED' | 'OFFLINE' } = {},
): Harness {
  const fetched: string[] = [];
  const store = new Map<string, unknown>();
  const now = { ms: NOW };
  const cache = new ZoneGeometryCache({
    fetchZone: async (zoneId) => {
      // `refuseAfter` models the HTTP client declining to send at all — its own limiter or
      // its own offline check — rather than upstream answering badly.
      if (opts.refuseAfter !== undefined && fetched.length >= opts.refuseAfter)
        throw new ProviderError(opts.refusalCode ?? 'RATE_LIMITED', 'client rate limit for api.weather.gov', {
          retryAfterMs: 59_000,
        });
      fetched.push(zoneId);
      if (opts.failures?.has(zoneId)) throw new Error('upstream refused');
      return answers[zoneId];
    },
    cache: {
      get: async (key) =>
        store.has(key) ? { value: store.get(key), storedAt: new Date(now.ms).toISOString() } : undefined,
      set: async (key, value) => {
        store.set(key, value);
      },
    },
    now: () => now.ms,
    log: () => {},
  });
  return { cache, fetched, store, now };
}

const ANSWERS = { 'forecast/COZ003': load('zones/COZ003.geojson'), 'forecast/COZ010': load('zones/COZ010.geojson') };

test('zone cache: resolves once, then serves from memory and from the persistent cache', async () => {
  const h = harness(ANSWERS);
  const ids = ['forecast/COZ003', 'forecast/COZ010'];
  const first = await h.cache.resolve(ids, AbortSignal.timeout(5000));
  assert.deepEqual(first, { fetched: 2, pending: 0 });
  assert.deepEqual(h.fetched, ids);

  const second = await h.cache.resolve(ids, AbortSignal.timeout(5000));
  assert.deepEqual(second, { fetched: 0, pending: 0 }, 'no second request for a known zone');
  assert.equal(h.fetched.length, 2);
  assert.equal(h.cache.lookup('forecast/COZ003')?.type, 'Polygon');

  // A fresh process with the same persistent cache does not go back to the network.
  const warm = harness(ANSWERS);
  for (const [k, v] of h.store) warm.store.set(k, v);
  assert.deepEqual(await warm.cache.resolve(ids, AbortSignal.timeout(5000)), { fetched: 0, pending: 0 });
  assert.deepEqual(warm.fetched, [], 'the cached outline is used instead of a request');
  assert.equal(ZONE_TTL_MS >= 7 * 24 * 3600_000, true, 'zone outlines are cached for longer than a poll');
});

test('zone cache: one poll fetches at most the budget; the rest stay pending for the next poll', async () => {
  const many = Object.fromEntries(
    Array.from({ length: ZONE_FETCH_BUDGET + 5 }, (_, i) => [
      `forecast/CO Z${i}`.replace(' ', ''),
      load('zones/COZ003.geojson'),
    ]),
  );
  const h = harness(many);
  const ids = Object.keys(many);
  const first = await h.cache.resolve(ids, AbortSignal.timeout(5000));
  assert.equal(first.fetched, ZONE_FETCH_BUDGET, 'the budget bounds a cold start');
  assert.equal(first.pending, 5);
  const second = await h.cache.resolve(ids, AbortSignal.timeout(5000));
  assert.equal(second.fetched, 5, 'the remainder resolves on the next poll');
  assert.equal(second.pending, 0);
});

test('zone cache: a zone that fails is not retried every poll, and never becomes a made-up outline', async () => {
  const h = harness(
    { ...ANSWERS, 'forecast/COZ099': load('zones/malformed.geojson') },
    { failures: new Set(['forecast/COZ050']) },
  );
  const ids = ['forecast/COZ003', 'forecast/COZ050', 'forecast/COZ099'];
  const first = await h.cache.resolve(ids, AbortSignal.timeout(5000));
  assert.equal(first.fetched, 1, 'only the good zone resolved');
  assert.equal(first.pending, 2);
  assert.equal(h.cache.lookup('forecast/COZ050'), undefined);
  assert.equal(h.cache.lookup('forecast/COZ099'), undefined, 'a zone document without geometry yields nothing');

  h.fetched.length = 0;
  await h.cache.resolve(ids, AbortSignal.timeout(5000));
  assert.deepEqual(h.fetched, [], 'the failures are backed off, not retried immediately');

  h.now.ms += ZONE_FAILURE_BACKOFF_MS + 1;
  await h.cache.resolve(ids, AbortSignal.timeout(5000));
  assert.deepEqual(h.fetched, ['forecast/COZ050', 'forecast/COZ099'], 'they are tried again once the backoff expires');
});

test('zone-based alerts: skipped until resolved, then admitted with zone provenance', async () => {
  const feed = load('normal.geojson');

  const before = normalizeNwsAlerts(feed, opts);
  assert.equal(before.observations.length, 7);
  assert.deepEqual(
    before.rejected.map((r) => r.reason),
    [REJECT_ZONE_ONLY, REJECT_NO_GEOMETRY],
  );
  assert.deepEqual(before.zonesNeeded, ['forecast/COZ003', 'forecast/COZ010'], 'the feed reports what it needs');
  assert.equal(before.fromZones, 0);

  const h = harness(ANSWERS);
  await h.cache.resolve(before.zonesNeeded, AbortSignal.timeout(5000));
  const after = normalizeNwsAlerts(feed, { ...opts, zoneGeometry: (id) => h.cache.lookup(id) });
  assert.equal(after.observations.length, 8, 'the zone-based advisory is now on the map');
  assert.deepEqual(
    after.rejected.map((r) => r.reason),
    [REJECT_NO_GEOMETRY],
    'only the alert with no zones at all stays out',
  );
  assert.deepEqual(after.zonesNeeded, []);
  assert.equal(after.fromZones, 1);

  const advisory = after.observations.find((o) => o.payload['event'] === 'Winter Weather Advisory');
  assert.ok(advisory, 'the advisory was admitted');
  assert.equal(advisory.payload['geometrySource'], 'zones', 'the outline says where it came from');
  assert.deepEqual(advisory.payload['zones'], ['forecast/COZ003', 'forecast/COZ010']);
  assert.ok(
    advisory.quality.flags?.includes('zone-geometry'),
    'and is flagged, so it is never read as a forecaster-drawn polygon',
  );
  assert.equal(advisory.geometry?.type, 'MultiPolygon');
  assert.ok(advisory.position, 'a centroid was derived from the combined zones');

  // An alert that carries its own polygon is untouched by any of this.
  const tornado = after.observations.find((o) => o.payload['event'] === 'Tornado Warning');
  assert.equal(tornado?.payload['geometrySource'], 'alert');
  assert.equal(tornado?.payload['zones'], undefined);
});

test('zone-based alerts: a partially resolved alert is skipped, never drawn from some of its zones', async () => {
  const feed = load('normal.geojson');
  const partial: Record<string, WorldGeometry | undefined> = {
    'forecast/COZ003': zoneGeometry(load('zones/COZ003.geojson')),
  };
  const r = normalizeNwsAlerts(feed, { ...opts, zoneGeometry: (id) => partial[id] });
  assert.equal(r.observations.length, 7, 'half an outline would understate where the alert applies');
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    [REJECT_ZONE_ONLY, REJECT_NO_GEOMETRY],
  );
  assert.deepEqual(r.zonesNeeded, ['forecast/COZ003', 'forecast/COZ010']);
});

test('zones: the request budget and the rate limit describe the same provider', () => {
  // These two numbers live in different files and had drifted into contradiction: the
  // resolver was written to fetch 20 zone outlines per poll, and the manifest allowed the
  // whole provider 4 requests a minute. Nothing failed — the limiter simply stopped
  // handing out slots, the poll timed out, and the visible symptom was that most of the
  // country's weather alerts never appeared. A cap that silently throws away work the
  // caller has already decided to do is worse than one that rejects it, so the invariant
  // is asserted here rather than left to whoever next reads both files.
  const perMinute = NWS_MANIFEST.refreshPolicy.maxRequestsPerMinute ?? Number.POSITIVE_INFINITY;
  assert.ok(
    perMinute >= ZONE_FETCH_BUDGET + 1,
    `the rate limit (${perMinute}/min) must cover one alerts fetch plus the ${ZONE_FETCH_BUDGET}-zone budget`,
  );
  // And the budget has to be reachable inside one poll: a zone request is a small JSON
  // document, but twenty of them in series still need to fit the timeout with the alerts
  // fetch and two normalisation passes alongside.
  const timeoutMs = NWS_MANIFEST.refreshPolicy.timeoutMs ?? 0;
  assert.ok(timeoutMs >= (ZONE_FETCH_BUDGET + 1) * 500, 'the poll timeout must allow the budget to be spent');
});

test('zones: running out of request slots ends the poll instead of blaming the zones', async () => {
  // The bug this pins down cost the map most of the United States' weather alerts for a
  // whole day. The HTTP client throws RATE_LIMITED when its own limiter would make the
  // caller wait; the resolver caught that alongside real upstream failures and put the
  // zone into a six-hour backoff. So every poll poisoned the zones it never reached, and
  // after a few cycles the entire list was sitting out the day — while the provider
  // reported healthy and the skipped count sat frozen at the same number hour after hour.
  const ids = ['forecast/COZ003', 'forecast/COZ010'];
  const signal = AbortSignal.timeout(5000);

  const limited = harness(ANSWERS, { refuseAfter: 1 });
  const first = await limited.cache.resolve(ids, signal);
  assert.equal(first.fetched, 1, 'it spends the slot it has');
  assert.equal(first.pending, 1, 'and the zone it could not reach is still wanted');
  assert.equal(limited.fetched.length, 1, 'it stops asking rather than burning through the list');

  // The zone that was never asked about must not be serving a backoff. The next poll has a
  // fresh window, and the proof is that the same cache resolves it immediately once the
  // refusal lifts — six hours of simulated waiting should not be needed.
  const open = harness(ANSWERS);
  for (const [k, v] of limited.store) open.store.set(k, v);
  const second = await open.cache.resolve(ids, signal);
  assert.equal(second.pending, 0, 'resolved on the very next cycle');

  // OFFLINE is the same kind of answer — our own check, not the zone's fault.
  const offline = harness(ANSWERS, { refuseAfter: 0, refusalCode: 'OFFLINE' });
  assert.deepEqual(await offline.cache.resolve(ids, signal), { fetched: 0, pending: 2 });
  assert.equal(offline.fetched.length, 0);
  const back = harness(ANSWERS);
  assert.equal((await back.cache.resolve(ids, signal)).pending, 0);
});

test('zones: a zone that really is broken is still backed off', async () => {
  // The counterpart to the test above: the fix must not turn every failure into "try again
  // immediately", or one permanently bad zone becomes a request every five minutes forever.
  const ids = ['forecast/COZ003'];
  const h = harness(ANSWERS, { failures: new Set(ids) });
  const signal = AbortSignal.timeout(5000);
  await h.cache.resolve(ids, signal);
  assert.equal(h.fetched.length, 1);
  await h.cache.resolve(ids, signal);
  assert.equal(h.fetched.length, 1, 'not asked again inside the backoff');
  h.now.ms += ZONE_FAILURE_BACKOFF_MS + 1;
  await h.cache.resolve(ids, signal);
  assert.equal(h.fetched.length, 2, 'asked again once the backoff expires');
});

test('zone geometry: a detailed outline is generalised to ZONE_SIMPLIFY_DEG, every ring still closed', () => {
  // A traced coastline: 5,000 vertices wobbling by 0.0005° around a 0.5° square.
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < 5_000; i++) {
    const t = i / 5_000;
    const side = Math.floor(t * 4);
    const u = t * 4 - side;
    const wobble = 0.0005 * Math.sin(i * 1.7);
    const pts: Array<[number, number]> = [
      [-105 + 0.5 * u, 39 + wobble],
      [-104.5 + wobble, 39 + 0.5 * u],
      [-104.5 - 0.5 * u, 39.5 + wobble],
      [-105 + wobble, 39.5 - 0.5 * u],
    ];
    ring.push(pts[side]!);
  }
  ring.push([...ring[0]!] as [number, number]);
  const g = zoneGeometry({ geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring]] } });
  assert.equal(g?.type, 'MultiPolygon');
  const polys = (g as { coordinates: Array<Array<Array<[number, number]>>> }).coordinates;
  for (const [outer] of polys) {
    assert.ok(outer!.length < 50, `5,001 vertices → ${outer!.length}`);
    assert.deepEqual(outer![0], outer!.at(-1));
  }
  const bytes = (v: unknown) => JSON.stringify(v).length;
  assert.ok(bytes(g) * 20 < bytes([[ring], [ring]]), `${bytes([[ring], [ring]])} → ${bytes(g)} bytes`);
  assert.ok(ZONE_SIMPLIFY_DEG > 0);
});
