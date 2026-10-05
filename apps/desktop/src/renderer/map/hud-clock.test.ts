import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorReadout, hudClock, nearReadout, rangeReadout } from './hud.js';

test('the HUD clock is the time of what the map shows', () => {
  const now = Date.parse('2026-10-04T06:14:27Z');
  const shown = Date.parse('2026-10-04T06:14:14Z');
  assert.deepEqual(hudClock(now, 'LIVE', shown), { atMs: now });
  assert.deepEqual(hudClock(now, undefined, shown), { atMs: now });
  assert.deepEqual(hudClock(now, 'PAUSED', shown), { atMs: shown, tag: 'PAUSED' });
  assert.deepEqual(hudClock(now, 'HISTORICAL', shown - 3_600_000), { atMs: shown - 3_600_000, tag: 'HISTORICAL' });
  assert.deepEqual(hudClock(now, 'REPLAY', Number.NaN), { atMs: now }, 'no moment known: now');
});

test('the cursor row: the ground under the pointer, a dash while it is off the map', () => {
  assert.equal(cursorReadout(null), '—');
  assert.equal(cursorReadout({ latitude: 21.307, longitude: -157.85831 }), '21.30700° N  157.85831° W');
  assert.equal(cursorReadout({ latitude: -33.9, longitude: 18.4 }), '33.90000° S   18.40000° E');
  // With a grid reference chosen, the pointer is given in it.
  assert.equal(cursorReadout({ latitude: 21.307, longitude: -157.85831 }, 'mgrs'), ' 4Q FJ 18415 56553');
  assert.equal(cursorReadout({ latitude: 21.307, longitude: -157.85831 }, 'utm'), ' 4Q 618415mE 2356553mN');
  assert.equal(cursorReadout(null, 'mgrs'), '—');
});

test('the range row: distance and bearing from the selection to the pointer, only when both are known', () => {
  const honolulu = { latitude: 21.3069, longitude: -157.8583 };
  assert.equal(rangeReadout(undefined, honolulu), undefined);
  assert.equal(rangeReadout(honolulu, null), undefined);
  // Honolulu to Hilo: 338.0 km leaving at 120.7° (GeographicLib's GeodSolve).
  assert.equal(rangeReadout(honolulu, { latitude: 19.7241, longitude: -155.0868 }), '338 km 121°');
  // Due north along the meridian: 10.3 km on the ellipsoid (10.4 on the mean sphere).
  assert.equal(rangeReadout(honolulu, { latitude: 21.4, longitude: -157.8583 }), '10.3 km 000°');
});

test('the NEAR row: where the middle of the view is from the nearest town, in capitals', () => {
  const hilo = {
    id: 'ne:city:US:hawaii:hilo',
    name: 'Hilo',
    kind: 'city' as const,
    position: { latitude: 19.72, longitude: -155.09 },
    distanceM: 41_355,
    bearingDeg: 285,
  };
  assert.equal(nearReadout(hilo), '41.4 KM WNW HILO');
  assert.equal(nearReadout({ ...hilo, distanceM: 400 }), 'HILO', 'within a kilometre: the town');
  assert.equal(nearReadout(null), undefined);
  assert.equal(nearReadout(undefined), undefined);
});
