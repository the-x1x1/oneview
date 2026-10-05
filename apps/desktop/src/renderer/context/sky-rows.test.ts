import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skyPositionText, skyRows, skyTimeText } from './sky-rows.js';

const rows = (lat: number, lon: number, iso: string) =>
  Object.fromEntries(skyRows({ latitude: lat, longitude: lon }, Date.parse(iso)).map((r) => [r.label, r.value]));

test('Honolulu, an afternoon: the Sun high, then sunset, dusk, dawn and sunrise; the Moon and its times', () => {
  const now = '2026-10-05T00:00:00Z';
  const r = skyRows({ latitude: 21.3069, longitude: -157.8583 }, Date.parse(now));
  assert.deepEqual(
    r.map((x) => x.label),
    ['Sun', 'Sunset', 'Civil dusk', 'Civil dawn', 'Sunrise', 'Moon', 'Moon now', 'Moonset', 'Moonrise'],
  );
  const v = Object.fromEntries(r.map((x) => [x.label, x.value]));
  assert.equal(v['Sun'], '54° up, bearing 226° SW');
  // Astronomy Engine: sunset 04:16:07.7, dusk 04:38:20.8, dawn 16:01:39.3, sunrise 16:23:53.8.
  assert.equal(v['Sunset'], '04:16 UTC · in 4h 16m');
  assert.equal(v['Civil dusk'], '04:38 UTC · in 4h 38m');
  assert.equal(v['Civil dawn'], '16:02 UTC · in 16h 02m');
  assert.equal(v['Sunrise'], '16:24 UTC · in 16h 24m');
  assert.equal(v['Moon'], '34% lit, last quarter');
  assert.equal(v['Moon now'], '5° up, bearing 292° WNW');
  // Astronomy Engine: moonset 00:27:36, moonrise 11:43:54.
  assert.equal(v['Moonset'], '00:28 UTC · in 28m');
  assert.equal(v['Moonrise'], '11:44 UTC · in 11h 44m');
});

test('Longyearbyen: the midnight sun, and the polar night with the Moon up all day', () => {
  const june = rows(78.2232, 15.6267, '2026-06-21T00:00:00Z');
  assert.equal(june['Sun'], '12° up, bearing 014° NNE');
  assert.equal(june['Sunrise, sunset'], 'none for two days: the Sun stays up');
  assert.equal(june['Civil twilight'], 'none for two days: the Sun stays above 6° below the horizon');
  assert.equal(june['Sunrise'], undefined);
  assert.ok(june['Moonrise'], 'the Moon still rises and sets');

  const december = rows(78.2232, 15.6267, '2026-12-21T00:00:00Z');
  assert.equal(december['Sun'], '35° below the horizon, bearing 018° NNE');
  assert.equal(december['Sunrise, sunset'], 'none for two days: the Sun stays down');
  assert.equal(december['Civil twilight'], 'none for two days: the Sun stays more than 6° below the horizon');
  assert.equal(december['Moon'], '87% lit, waxing gibbous');
  assert.equal(december['Moonrise, moonset'], 'none for two days: the Moon stays up');
});

test('time and position text', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  assert.equal(skyTimeText(now + 29_000, now), '00:00 UTC · now');
  assert.equal(skyTimeText(now + 31_000, now), '00:01 UTC · in 1m');
  assert.equal(skyTimeText(now + 59 * 60_000, now), '00:59 UTC · in 59m');
  assert.equal(skyTimeText(now + 25 * 3_600_000 + 5 * 60_000, now), '01:05 UTC · in 25h 05m');
  assert.equal(skyPositionText({ altitudeDeg: 0.2, azimuthDeg: 359.7 }), 'on the horizon, bearing 000° N');
  assert.equal(skyPositionText({ altitudeDeg: -0.6, azimuthDeg: 90 }), '1° below the horizon, bearing 090° E');
});
