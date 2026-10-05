import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moonEvents,
  moonIllumination,
  moonPosition,
  sublunarPoint,
  sunEvents,
  sunPosition,
  type SkyEvent,
} from './sky.js';

/*
 * The expected values below were computed with Astronomy Engine (Don Cross, MIT licence,
 * github.com/cosinekitty/astronomy `source/js/astronomy.js`), run outside this repository:
 * SearchRiseSet for rising and setting (upper limb, standard refraction), SearchAltitude at −6°
 * for civil twilight, Equator + Horizon (topocentric, no refraction) for altitude and azimuth,
 * Illumination's phase_fraction and MoonPhase for the Moon. No Astronomy Engine code is
 * included. Over 800 random places and times (400 within 65° of the equator, 400 beyond it,
 * 2020–2032) this module agreed: Sun 0.012° in altitude, 0.025° in azimuth, its rising, setting
 * and twilight within 10 s below the polar circles (2 min beyond them, where the Sun crosses
 * the horizon at a slant); the Moon 0.27° in altitude, 0.66° in azimuth, its rising and setting
 * within 2.5 min (15 min beyond the polar circles), the lit fraction within 0.0024. A Moon that
 * only grazes the horizon — a few hundredths of a degree either side — can be found by one and
 * not the other; the fuzz met three such in 800.
 */

const at = (iso: string) => Date.parse(iso);
const HONOLULU = { latitude: 21.3069, longitude: -157.8583 };
const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };
const REYKJAVIK = { latitude: 64.1466, longitude: -21.9426 };
const QUITO = { latitude: -0.1807, longitude: -78.4678 };
const LONGYEARBYEN = { latitude: 78.2232, longitude: 15.6267 };

function near(actual: number, expected: number, tol: number, what: string) {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (±${tol})`);
}
function angle(actual: number, expected: number, tol: number, what: string) {
  near(((actual - expected + 540) % 360) - 180, 0, tol, what);
}
function events(list: SkyEvent[], expected: Record<string, string>, tolS: number, where: string) {
  assert.deepEqual(
    list.map((e) => e.kind).sort(),
    Object.keys(expected).sort(),
    `${where}: one of each kind in the day`,
  );
  for (const [kind, iso] of Object.entries(expected)) {
    const e = list.find((x) => x.kind === kind)!;
    near(e.at / 1000, at(iso) / 1000, tolS, `${where} ${kind}`);
  }
}

test('the Sun rises and sets, and civil twilight begins and ends, as Astronomy Engine has them', () => {
  events(
    sunEvents(at('2026-10-05T00:00:00Z'), HONOLULU, 24),
    {
      set: '2026-10-05T04:16:07.715Z',
      dusk: '2026-10-05T04:38:20.847Z',
      dawn: '2026-10-05T16:01:39.304Z',
      rise: '2026-10-05T16:23:53.844Z',
    },
    15,
    'Honolulu',
  );
  events(
    sunEvents(at('2026-12-21T00:00:00Z'), SYDNEY, 24),
    {
      set: '2026-12-21T09:05:25.495Z',
      dusk: '2026-12-21T09:34:34.088Z',
      dawn: '2026-12-21T18:11:57.669Z',
      rise: '2026-12-21T18:41:06.219Z',
    },
    15,
    'Sydney, midsummer',
  );
  events(
    sunEvents(at('2026-03-20T00:00:00Z'), REYKJAVIK, 24),
    {
      dawn: '2026-03-20T06:40:56.948Z',
      rise: '2026-03-20T07:28:37.349Z',
      set: '2026-03-20T19:43:25.166Z',
      dusk: '2026-03-20T20:31:21.900Z',
    },
    15,
    'Reykjavik, equinox',
  );
  events(
    sunEvents(at('2027-06-01T12:00:00Z'), QUITO, 24),
    {
      set: '2027-06-01T23:15:02.504Z',
      dusk: '2027-06-01T23:37:22.615Z',
      dawn: '2027-06-02T10:46:13.331Z',
      rise: '2027-06-02T11:08:33.939Z',
    },
    15,
    'Quito, on the equator',
  );
  // In time order.
  const h = sunEvents(at('2026-10-05T00:00:00Z'), HONOLULU, 24).map((e) => e.kind);
  assert.deepEqual(h, ['set', 'dusk', 'dawn', 'rise']);
});

test('polar day and polar night: nothing rises or sets', () => {
  // Longyearbyen at midsummer: the Sun stays up; at midwinter it stays more than 6° down.
  assert.deepEqual(sunEvents(at('2026-06-21T00:00:00Z'), LONGYEARBYEN), []);
  assert.ok(sunPosition(at('2026-06-21T00:00:00Z'), LONGYEARBYEN).altitudeDeg > 0, 'the midnight sun');
  assert.deepEqual(sunEvents(at('2026-12-21T00:00:00Z'), LONGYEARBYEN), []);
  // And the Moon, a week before full, stays up there all that day.
  assert.deepEqual(moonEvents(at('2026-12-21T00:00:00Z'), LONGYEARBYEN, 24), []);
  // But the Moon still rises and sets there at midsummer.
  events(
    moonEvents(at('2026-06-21T00:00:00Z'), LONGYEARBYEN, 24),
    { rise: '2026-06-21T10:29:19.466Z', set: '2026-06-21T22:04:52.797Z' },
    90,
    'Longyearbyen moon',
  );
});

test('the Moon rises and sets as Astronomy Engine has it, to a minute or so', () => {
  events(
    moonEvents(at('2026-10-05T00:00:00Z'), HONOLULU, 24),
    { set: '2026-10-05T00:27:36.345Z', rise: '2026-10-05T11:43:54.232Z' },
    60,
    'Honolulu',
  );
  events(
    moonEvents(at('2026-12-21T00:00:00Z'), SYDNEY, 24),
    { rise: '2026-12-21T06:05:50.670Z', set: '2026-12-21T16:13:00.063Z' },
    60,
    'Sydney',
  );
  events(
    moonEvents(at('2026-03-20T00:00:00Z'), REYKJAVIK, 24),
    { rise: '2026-03-20T07:13:40.773Z', set: '2026-03-20T22:58:16.503Z' },
    60,
    'Reykjavik',
  );
  events(
    moonEvents(at('2027-06-01T12:00:00Z'), QUITO, 24),
    { set: '2027-06-01T20:23:21.535Z', rise: '2027-06-02T08:51:00.610Z' },
    60,
    'Quito',
  );
});

test('where the Sun and Moon stand: altitude and bearing from the place', () => {
  const cases: Array<[string, { latitude: number; longitude: number }, string, number, number, number, number]> = [
    // place, time, Sun altitude, azimuth, Moon altitude, azimuth (Astronomy Engine, topocentric)
    ['Honolulu', HONOLULU, '2026-10-05T00:00:00Z', 54.297, 226.209, 4.9, 291.802],
    ['Sydney', SYDNEY, '2026-12-21T00:00:00Z', 63.22, 74.524, -69.875, 122.171],
    ['Reykjavik', REYKJAVIK, '2026-03-20T00:00:00Z', -23.748, 333.798, -15.113, 325.036],
    ['Quito', QUITO, '2027-06-01T12:00:00Z', 11.109, 67.456, 54.557, 63.03],
    ['Longyearbyen', LONGYEARBYEN, '2026-12-21T00:00:00Z', -34.695, 18.108, 25.597, 247.768],
  ];
  for (const [name, place, iso, sAlt, sAz, mAlt, mAz] of cases) {
    const s = sunPosition(at(iso), place);
    near(s.altitudeDeg, sAlt, 0.02, `${name} Sun altitude`);
    angle(s.azimuthDeg, sAz, 0.02, `${name} Sun azimuth`);
    const m = moonPosition(at(iso), place);
    near(m.altitudeDeg, mAlt, 0.3, `${name} Moon altitude`);
    angle(m.azimuthDeg, mAz, 0.3, `${name} Moon azimuth`);
  }
});

test("the Moon's lit fraction and phase", () => {
  const cases: Array<[string, number, number, string]> = [
    // time, phase_fraction, MoonPhase (elongation) — Astronomy Engine; the phase name is ours
    ['2026-10-05T00:00:00Z', 0.3396, 288.86, 'last quarter'],
    ['2026-12-21T00:00:00Z', 0.8657, 137.14, 'waxing gibbous'],
    ['2026-03-20T00:00:00Z', 0.0122, 12.34, 'new moon'],
    ['2027-06-01T12:00:00Z', 0.1418, 316.07, 'waning crescent'],
    ['2026-06-21T00:00:00Z', 0.4061, 79.03, 'first quarter'],
  ];
  for (const [iso, fraction, elongation, phase] of cases) {
    const m = moonIllumination(at(iso));
    near(m.fraction, fraction, 0.003, `${iso} fraction`);
    angle(m.elongationDeg, elongation, 0.3, `${iso} elongation`);
    assert.equal(m.phase, phase, iso);
    assert.equal(m.waxing, elongation < 180, `${iso} waxing`);
  }
  // At Astronomy Engine's quarters of October 2026 (SearchMoonQuarter), the names agree and
  // the fraction is what it should be.
  const quarters: Array<[string, string, number]> = [
    ['2026-10-03T13:25:33.710Z', 'last quarter', 0.5],
    ['2026-10-10T15:50:36.724Z', 'new moon', 0],
    ['2026-10-18T16:13:19.496Z', 'first quarter', 0.5],
    ['2026-10-26T04:12:15.538Z', 'full moon', 1],
  ];
  for (const [iso, phase, fraction] of quarters) {
    const m = moonIllumination(at(iso));
    assert.equal(m.phase, phase, iso);
    near(m.fraction, fraction, 0.003, `${iso} fraction`);
  }
});

test('events come within the window asked for and each to about a second', () => {
  const from = at('2026-10-05T00:00:00Z');
  const two = sunEvents(from, HONOLULU);
  assert.equal(two.length, 8, 'two days: two of each');
  assert.ok(two.every((e) => e.at >= from && e.at <= from + 48 * 3_600_000));
  const six = sunEvents(from, HONOLULU, 6);
  assert.deepEqual(
    six.map((e) => e.kind),
    ['set', 'dusk'],
  );
  // Asking again from a later moment finds the same instants.
  const again = sunEvents(from + 7 * 60_000 + 13_000, HONOLULU, 6);
  near(again[0]!.at, six[0]!.at, 2000, 'same sunset from a different start');
});

test('the point beneath the Moon, as Astronomy Engine has it (GeoMoon, equator of date, less sidereal time)', () => {
  const cases: Array<[string, number, number]> = [
    ['2026-10-05T00:00:00Z', 22.419, 109.735],
    ['2026-12-21T00:00:00Z', 21.566, -47.349],
    ['2027-06-01T12:00:00Z', 14.88, -46.636],
    ['2026-03-20T00:00:00Z', 7.256, -167.877],
  ];
  for (const [iso, lat, lon] of cases) {
    const p = sublunarPoint(at(iso));
    near(p.latitude, lat, 0.1, `${iso} latitude`);
    angle(p.longitude, lon, 0.15, `${iso} longitude`);
  }
});
