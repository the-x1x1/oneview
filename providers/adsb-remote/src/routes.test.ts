import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import { ROUTES_ATTRIBUTION, flightCallsign, parseRoute, routeUrl } from './routes.js';
import { AdsbLolProvider } from './index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'adsb-lol');
const read = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8')) as Record<string, unknown>;
/** INVENTED route files in the published shape (fixtures/adsb-lol/README.md), keyed by callsign. */
const files = read('routes.json')['files'] as Record<string, unknown>;
/** RECORDED 2026-09-29: RYR7YT, Alicante → Weeze. */
const recorded = read('route-ryr7yt.json')['answer'];
const NOW = Date.parse('2026-09-28T08:00:00.000Z');

test('flightCallsign: airline flights only — never a registration flown as a callsign', () => {
  assert.equal(flightCallsign('baw123 '), 'BAW123');
  assert.equal(flightCallsign('DLH4AB'), 'DLH4AB');
  assert.equal(flightCallsign('RCH871'), 'RCH871');
  assert.equal(flightCallsign('N123AB'), undefined);
  assert.equal(flightCallsign('GABCD'), undefined);
  assert.equal(flightCallsign('DIABC'), undefined, 'three letters then a letter: a registration');
  assert.equal(flightCallsign('BAW12345'), undefined, 'longer than a callsign can be');
  assert.equal(flightCallsign(undefined), undefined);
});

test('routeUrl: the static file under the first two characters of the callsign', () => {
  assert.equal(routeUrl('RYR7YT'), 'https://vrs-standing-data.adsb.lol/routes/RY/RYR7YT.json');
  assert.equal(routeUrl('BAW123'), 'https://vrs-standing-data.adsb.lol/routes/BA/BAW123.json');
});

test('parseRoute: a recorded answer, origin and destination with what adsb.lol says of each', () => {
  const r = parseRoute(recorded, 'RYR7YT', { attribution: 'a' });
  assert.ok(typeof r !== 'string');
  assert.equal(r.airlineCode, 'RYR');
  assert.equal(r.flightNumber, '7YT');
  assert.equal(r.plausible, undefined, 'the file says nothing about the aircraft; the panel judges the fit');
  assert.deepEqual(
    r.airports.map((a) => [a.code, a.iata, a.city, a.countryCode]),
    [
      ['LEAL', 'ALC', 'Alicante', 'ES'],
      ['EDLV', 'NRN', 'Weeze', 'DE'],
    ],
  );
  assert.equal(r.airports[1]!.elevationM, 32.31);
});

test('parseRoute: origin, stop and destination in order', () => {
  const r = parseRoute(files['TST123'], 'TST123', { attribution: 'a' });
  assert.ok(typeof r !== 'string');
  assert.equal(r.attribution, 'a');
  assert.deepEqual(
    r.airports.map((a) => [a.code, a.iata, a.city, a.countryCode]),
    [
      ['PHNL', 'HNL', 'Honolulu', 'US'],
      ['KSFO', 'SFO', 'San Francisco', 'US'],
      ['EGLL', 'LHR', 'London', 'GB'],
    ],
  );
  assert.deepEqual(r.airports[2], {
    code: 'EGLL',
    icao: 'EGLL',
    iata: 'LHR',
    name: 'London Heathrow Airport',
    city: 'London',
    countryCode: 'GB',
    latitude: 51.47,
    longitude: -0.46,
    elevationM: 25.3,
  });
});

test('parseRoute: an airport it cannot describe keeps its code; unknown is an answer with no airports', () => {
  const partial = parseRoute(files['TST9'], 'TST9');
  assert.ok(typeof partial !== 'string');
  assert.deepEqual(partial.airports[1], { code: 'ZZZZ', icao: 'ZZZZ' });
  const unknown = parseRoute(files['TST404'], 'TST404');
  assert.ok(typeof unknown !== 'string');
  assert.deepEqual(unknown.airports, []);
  assert.equal(unknown.airlineCode, undefined);
  assert.equal(parseRoute([files['TST123']], 'TST123'), 'route answer is not an object');
  assert.equal(parseRoute(files['TST123'], 'OTH1'), 'route answer is for another callsign');
});

function provider(respond: (req: { url: string; body?: unknown }) => testing.FixtureResponse) {
  const ctx = testing.createFixtureContext({
    providerId: 'adsb-lol',
    clock: new testing.VirtualClock(NOW),
    responder: respond,
  });
  return { ctx, p: new AdsbLolProvider() };
}

const ask = (callsign: string) => ({
  objectId: 'aircraft:icao24:abc123',
  callsign,
  position: { latitude: 30, longitude: -140 },
  signal: new AbortController().signal,
});

const fileFor = (url: string): testing.FixtureResponse => {
  const callsign = /\/([A-Z0-9]+)\.json$/.exec(url)?.[1] ?? '';
  const body = callsign === 'RYR7YT' ? recorded : files[callsign];
  return body ? { body: JSON.stringify(body) } : { status: 404, body: 'Not Found' };
};

test("flightRoute: one GET of the callsign's file, no position sent, attributed, remembered for half an hour", async () => {
  const { ctx, p } = provider((req) => fileFor(req.url));
  await p.initialize(ctx);
  await p.start();
  const route = await p.flightRoute(ask('TST123'));
  assert.equal(route?.airports.length, 3);
  assert.equal(route?.label, 'adsb.lol routes');
  assert.equal(route?.attribution, ROUTES_ATTRIBUTION);
  assert.equal(ctx.http.requests.length, 1);
  const req = ctx.http.requests[0]!;
  assert.equal(req.url, 'https://vrs-standing-data.adsb.lol/routes/TS/TST123.json');
  assert.equal(req.method ?? 'GET', 'GET');
  assert.equal(req.body, undefined, 'the aircraft position goes nowhere');
  await p.flightRoute(ask('TST123'));
  assert.equal(ctx.http.requests.length, 1, 'answered from memory');
  ctx.clock.advance(31 * 60_000);
  await p.flightRoute(ask('TST123'));
  assert.equal(ctx.http.requests.length, 2, 'asked again after half an hour');
});

test('flightRoute: a callsign with no file is an answer with no airports, not a failure', async () => {
  const { ctx, p } = provider((req) => fileFor(req.url));
  await p.initialize(ctx);
  await p.start();
  const route = await p.flightRoute(ask('ZZZ9999'));
  assert.ok(route, 'answered');
  assert.deepEqual(route.airports, []);
  assert.equal(route.attribution, ROUTES_ATTRIBUTION);
  ctx.clock.advance(5 * 60_000);
  await p.flightRoute(ask('ZZZ9999'));
  assert.equal(ctx.http.requests.length, 1, 'remembered like any answer');
});

test('flightRoute: an empty answer (what the retired routeset endpoint gave) is unavailable, not a crash', async () => {
  const { ctx, p } = provider(() => ({ status: 200, body: '' }));
  await p.initialize(ctx);
  await p.start();
  assert.equal(await p.flightRoute(ask('RYR7YT')), undefined);
});

test('flightRoute: no request for a registration callsign; a failure is undefined and retried after a minute', async () => {
  let fail = true;
  const { ctx, p } = provider((req) => (fail ? { status: 503, body: '' } : fileFor(req.url)));
  await p.initialize(ctx);
  await p.start();
  assert.equal(await p.flightRoute(ask('N123AB')), undefined);
  assert.equal(ctx.http.requests.length, 0, 'a private aircraft is never looked up');
  assert.equal(await p.flightRoute(ask('TST123')), undefined, 'unavailable');
  fail = false;
  assert.equal(await p.flightRoute(ask('TST123')), undefined, 'the failure is remembered briefly');
  ctx.clock.advance(61_000);
  assert.equal((await p.flightRoute(ask('TST123')))?.airports.length, 3);
});

test('flightRoute: a short rate-limit pause is waited out once, then the route is asked again', async () => {
  let calls = 0;
  const { ctx, p } = provider((req) =>
    ++calls === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: '' } : fileFor(req.url),
  );
  const waits: number[] = [];
  p.routeRetryWait = async (ms) => {
    waits.push(ms);
  };
  await p.initialize(ctx);
  await p.start();
  const route = await p.flightRoute(ask('TST123'));
  assert.equal(route?.airports.length, 3, 'answered on the retry');
  assert.equal(waits.length, 1, 'one wait');
  assert.ok(waits[0]! >= 250 && waits[0]! <= 6_000, `a short wait: ${waits[0]}`);
});

test('flightRoute: the route host is outside the api.adsb.lol budget the position polls share', async () => {
  const { ctx, p } = provider((req) =>
    req.url.includes('vrs-standing-data')
      ? fileFor(req.url)
      : { body: JSON.stringify({ ac: [], now: NOW, total: 0, msg: 'No error' }) },
  );
  await p.initialize(ctx);
  await p.start();
  const before = p.budgetSummary();
  assert.equal((await p.flightRoute(ask('TST123')))?.airports.length, 3);
  const after = p.budgetSummary();
  assert.deepEqual(after, before, "a lookup spends nothing of the polls' budget");
  await p.query({
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -158.5, south: 20.9, east: -157.3, north: 21.8 },
  });
  assert.equal(ctx.http.requests.filter((r) => r.url.includes('api.adsb.lol')).length, 1, 'the poll goes as usual');
});
