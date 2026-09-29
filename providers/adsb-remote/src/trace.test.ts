import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import { parseTrace, thin, traceUrl } from './trace.js';
import { AdsbLolProvider } from './index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'adsb-lol');
/** INVENTED fixtures in the published shapes (fixtures/adsb-lol/README.md). */
const traceBody = readFileSync(path.join(fixtures, 'trace-full.json'), 'utf8');
const milBody = readFileSync(path.join(fixtures, 'mil.json'), 'utf8');
const NOW = 1790496000000; // the fixtures' reference time, 2026-09-27T08:00:00Z
const START = NOW - 3600_000; // the trace's `timestamp`

test('traceUrl: the tar1090 path by the last two hex digits; ICAO addresses only', () => {
  assert.equal(traceUrl('AE5F01'), 'https://adsb.lol/data/traces/01/trace_full_ae5f01.json');
  assert.equal(traceUrl('~a5b5c5'), undefined, 'non-ICAO (TIS-B) addresses are not looked up');
  assert.equal(traceUrl('../../x'), undefined);
});

test('parseTrace: seconds after timestamp → ISO times; feet → metres; ground → 0; bad rows dropped', () => {
  const points = parseTrace(JSON.parse(traceBody), { fromMs: 0, toMs: NOW, maxPoints: 100, hex: 'ae5f01' });
  assert.ok(Array.isArray(points));
  assert.equal(points.length, 5, 'non-numeric latitude, non-array row and latitude 95 dropped');
  assert.deepEqual(points[0], {
    observedAt: new Date(START).toISOString(),
    latitude: 39.0875,
    longitude: -75.0207,
    altitudeM: 1516.4,
  });
  assert.equal(points[1]!.observedAt, new Date(START + 60_500).toISOString());
  assert.equal(points[2]!.altitudeM, 0, '"ground"');
  assert.equal(points[3]!.altitudeM, undefined, 'null altitude stays unknown');
  assert.equal(points[4]!.altitudeM, 914.4);
});

test('parseTrace: window, thinning, and refusals', () => {
  const body = JSON.parse(traceBody);
  const windowed = parseTrace(body, { fromMs: START + 100_000, toMs: START + 250_000, maxPoints: 100 });
  assert.deepEqual(
    (windowed as { observedAt: string }[]).map((p) => p.observedAt),
    [new Date(START + 120_200).toISOString(), new Date(START + 240_000).toISOString()],
  );
  const two = parseTrace(body, { fromMs: 0, toMs: NOW, maxPoints: 2 }) as { observedAt: string }[];
  assert.equal(two.length, 2);
  assert.equal(two[1]!.observedAt, new Date(START + 300_000).toISOString(), 'the newest point is kept');
  assert.equal(
    parseTrace(body, { fromMs: 0, toMs: NOW, maxPoints: 9, hex: 'abcdef' }),
    'trace is for another aircraft',
  );
  assert.equal(
    parseTrace({ icao: 'ae5f01', trace: [] }, { fromMs: 0, toMs: NOW, maxPoints: 9 }),
    'trace has no timestamp',
  );
  assert.equal(parseTrace([], { fromMs: 0, toMs: NOW, maxPoints: 9 }), 'trace is not an object');
  assert.equal(
    parseTrace({ timestamp: 1, trace: 'x' }, { fromMs: 0, toMs: NOW, maxPoints: 9 }),
    'trace has no "trace" array',
  );
});

test('thin: at most max, evenly, newest kept', () => {
  assert.deepEqual(thin([1, 2, 3, 4, 5, 6, 7], 3), [1, 4, 7]);
  assert.deepEqual(thin([1, 2], 5), [1, 2]);
  assert.deepEqual(thin([1, 2, 3], 0), []);
});

function provider() {
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW),
    responder: (req) => {
      if (req.url.includes('/data/traces/')) return { body: traceBody };
      if (req.url.endsWith('/v2/mil')) return { body: milBody };
      if (req.url.includes('/v2/lat/'))
        return { body: JSON.stringify({ ac: [], now: NOW, total: 0, msg: 'No error' }) };
      return { status: 404, body: '' };
    },
  });
  return { ctx, p: new AdsbLolProvider() };
}

const request = (over: Partial<Parameters<AdsbLolProvider['objectTrack']>[0]> = {}) => ({
  objectId: 'aircraft:icao24:ae5f01',
  objectType: 'aircraft',
  externalId: 'ae5f01',
  properties: { icao24: 'ae5f01' },
  time: { start: new Date(NOW - 6 * 3600_000).toISOString(), end: new Date(NOW).toISOString() },
  signal: new AbortController().signal,
  ...over,
});

test("objectTrack: the selected aircraft's adsb.lol history, labelled and attributed, cached for a minute", async () => {
  const { ctx, p } = provider();
  await p.initialize(ctx);
  await p.start();
  const answer = await p.objectTrack(request());
  assert.ok(answer);
  assert.equal(answer.kind, 'history');
  assert.equal(answer.label, 'adsb.lol history');
  assert.match(answer.attribution ?? '', /adsb\.lol contributors \(ODbL 1\.0\)/);
  assert.equal(answer.points.length, 5);
  assert.equal(ctx.http.requests.length, 1);
  assert.equal(ctx.http.requests[0]!.url, 'https://adsb.lol/data/traces/01/trace_full_ae5f01.json');
  // Another window within the minute: answered from memory, cut to the window.
  const narrow = await p.objectTrack(
    request({ time: { start: new Date(START + 100_000).toISOString(), end: new Date(NOW).toISOString() } }),
  );
  assert.equal(narrow?.points.length, 3);
  assert.equal(ctx.http.requests.length, 1, 'no second request inside a minute');
  ctx.clock.advance(61_000);
  await p.objectTrack(request());
  assert.equal(ctx.http.requests.length, 2, 'asked again after a minute');
});

test('objectTrack: nothing for other types, non-ICAO addresses, or a failed request', async () => {
  const { ctx, p } = provider();
  await p.initialize(ctx);
  await p.start();
  assert.equal(await p.objectTrack(request({ objectType: 'vessel' })), undefined);
  assert.equal(
    await p.objectTrack(request({ externalId: 'nonicao-a5b5c5', properties: {} })),
    undefined,
    'no ICAO address, no lookup',
  );
  assert.equal(ctx.http.requests.length, 0);
  const missing = await p.objectTrack(request({ externalId: 'abcdef', properties: { icao24: 'abcdef' } }));
  assert.equal(missing, undefined, 'a 404 (or a trace for another aircraft) leaves the track alone');
});

test('the /v2/mil fixture normalises with every aircraft tagged military', async () => {
  const { ctx, p } = provider();
  await p.initialize(ctx);
  await p.start();
  // First poll of a wide view is the point query (empty here); the military list comes next,
  // once the request budget has a token for it again (START_PER_MIN, one per 15 s).
  await p.query({
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -180, south: -85, east: 180, north: 85 },
    center: { latitude: 40, longitude: -40 },
  });
  ctx.clock.advance(15_000);
  const second = await p.query({
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -180, south: -85, east: 180, north: 85 },
    center: { latitude: 40, longitude: -40 },
  });
  const mil = second.filter((o) => o.externalId?.startsWith('ae5f0'));
  assert.equal(mil.length, 3, 'the Mode S row without a position is not an aircraft on the map');
  assert.ok(mil.every((o) => o.payload['military'] === true));
  assert.equal(mil.find((o) => o.externalId === 'ae5f03')?.payload['category'], 'A7');
});
