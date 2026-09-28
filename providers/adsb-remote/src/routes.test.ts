import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import { ROUTESET_URL, ROUTES_ATTRIBUTION, flightCallsign, parseRouteset, routesetBody } from './routes.js';
import { AdsbLolProvider } from './index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'adsb-lol');
/** INVENTED fixture in the published shape (fixtures/adsb-lol/README.md); `answer` is the response body. */
const routeset = JSON.parse(readFileSync(path.join(fixtures, 'routeset.json'), 'utf8')) as { answer: unknown[] };
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

test('routesetBody: one plane, position rounded', () => {
  assert.deepEqual(JSON.parse(routesetBody('TST123', { latitude: 21.123456, longitude: -157.987654 })), {
    planes: [{ callsign: 'TST123', lat: 21.123, lng: -157.988 }],
  });
  assert.deepEqual(JSON.parse(routesetBody('TST123')), { planes: [{ callsign: 'TST123', lat: 0, lng: 0 }] });
});

test('parseRouteset: origin, stop and destination in order, with what adsb.lol says of each', () => {
  const r = parseRouteset(routeset.answer, 'TST123', { attribution: 'a', positionSent: true });
  assert.ok(typeof r !== 'string');
  assert.equal(r.airlineCode, 'TST');
  assert.equal(r.flightNumber, '123');
  assert.equal(r.plausible, true);
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

test('parseRouteset: an airport it cannot describe keeps its code; unknown is an answer with no airports', () => {
  const partial = parseRouteset(routeset.answer, 'TST9', { positionSent: false });
  assert.ok(typeof partial !== 'string');
  assert.deepEqual(partial.airports[1], { code: 'ZZZZ', icao: 'ZZZZ' });
  assert.equal(partial.plausible, undefined, 'no position was sent: its plausibility says nothing');
  const unknown = parseRouteset(routeset.answer, 'TST404', { positionSent: true });
  assert.ok(typeof unknown !== 'string');
  assert.deepEqual(unknown.airports, []);
  assert.equal(unknown.airlineCode, undefined);
  assert.equal(parseRouteset({ planes: [] }, 'TST123', { positionSent: true }), 'routeset answer is not an array');
  assert.equal(
    parseRouteset(routeset.answer, 'OTH1', { positionSent: true }),
    'routeset answer has no row for the callsign',
  );
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

test('flightRoute: one POST for the selected callsign, attributed, remembered for half an hour', async () => {
  const { ctx, p } = provider(() => ({ body: JSON.stringify(routeset.answer) }));
  await p.initialize(ctx);
  await p.start();
  const route = await p.flightRoute(ask('TST123'));
  assert.equal(route?.airports.length, 3);
  assert.equal(route?.label, 'adsb.lol routes');
  assert.equal(route?.attribution, ROUTES_ATTRIBUTION);
  assert.equal(ctx.http.requests.length, 1);
  const req = ctx.http.requests[0]!;
  assert.equal(req.url, ROUTESET_URL);
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(String(req.body)), { planes: [{ callsign: 'TST123', lat: 30, lng: -140 }] });
  assert.match(req.cacheKey ?? '', /TST123$/, 'coalesced per callsign, not per URL');
  await p.flightRoute(ask('TST123'));
  assert.equal(ctx.http.requests.length, 1, 'answered from memory');
  ctx.clock.advance(31 * 60_000);
  await p.flightRoute(ask('TST123'));
  assert.equal(ctx.http.requests.length, 2, 'asked again after half an hour');
});

test('flightRoute: no request for a registration callsign; a failure is undefined and retried after a minute', async () => {
  let fail = true;
  const { ctx, p } = provider(() => (fail ? { status: 503, body: '' } : { body: JSON.stringify(routeset.answer) }));
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
