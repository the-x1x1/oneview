import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPlacement, countryName, nearestPlaceText, nextPassRows, whatsHereRows } from './whats-here-text.js';

const MAUNA_KEA = { latitude: 19.8207, longitude: -155.468 };

test("What's here: the point's references, how far from home and the selection, the Sun and Moon", () => {
  const rows = whatsHereRows({
    position: MAUNA_KEA,
    nowMs: Date.parse('2026-10-05T00:00:00Z'),
    home: { latitude: 21.3069, longitude: -157.8583 },
    selection: { name: 'the selection', position: { latitude: 19.7241, longitude: -155.0868 } },
  });
  const v = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.deepEqual(
    rows.map((r) => r.label),
    ['Coordinates', 'DMS', 'MGRS', 'From home', 'From the selection', 'Sun', 'Sunset', 'Moon'],
  );
  assert.equal(v['Coordinates'], '19.82070° N 155.46800° W');
  assert.equal(v['DMS'], '19°49′14.5″ N 155°28′04.8″ W');
  // GeographicLib GeoConvert -m -p 0: 05QKB4148193528.
  assert.equal(v['MGRS'], '5Q KB 41481 93528');
  // GeodSolve -i: Honolulu → here 298,639.220 m, azi1 123.007°; Hilo → here 41,355.014 m, azi1 −74.950°.
  assert.equal(v['From home'], '299 km · 123° ESE');
  assert.equal(v['From the selection'], '41.4 km · 285° WNW');
  assert.equal(v['Sun'], '54° up, bearing 231° SW');
  assert.equal(v['Sunset'], '04:07 UTC · in 4h 07m');
  assert.equal(v['Moon'], '34% lit, last quarter · 2° up');
  assert.deepEqual(
    rows.filter((r) => r.copyable).map((r) => r.label),
    ['Coordinates', 'DMS', 'MGRS'],
    'the references are the ones to copy',
  );
});

test("What's here: UTM when chosen; the midnight sun; nothing from home when it is here", () => {
  const rows = whatsHereRows({
    position: { latitude: 78.2232, longitude: 15.6267 },
    nowMs: Date.parse('2026-06-21T00:00:00Z'),
    grid: 'utm',
    home: { latitude: 78.2232, longitude: 15.6267 },
  });
  const v = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  // GeoConvert -u -p 0: 33n 514279 8683355 (rounded; a grid reference is truncated, as the HUD's is).
  assert.equal(v['UTM'], '33X 514278mE 8683355mN');
  assert.equal(v['From home'], undefined, 'home is here');
  assert.equal(v['Sunrise, sunset'], 'none for two days: the Sun stays up');
  assert.equal(v['Moon'], '41% lit, first quarter · below the horizon');
});

test('the nearest town: how far and which way from it, then its region and country', () => {
  const hilo = {
    id: 'ne:city:US:hawaii:hilo',
    name: 'Hilo',
    kind: 'city' as const,
    position: { latitude: 19.72, longitude: -155.09 },
    countryCode: 'US',
    region: 'Hawaii',
    distanceM: 41_355,
    bearingDeg: 285.05,
  };
  assert.deepEqual(nearestPlaceText(hilo), { title: '41.4 km WNW of Hilo', subtitle: 'Hawaii, United States' });
  assert.deepEqual(nearestPlaceText({ ...hilo, distanceM: 640 }), { title: 'Hilo', subtitle: 'Hawaii, United States' });
  const { region: _r, countryCode: _c, ...bare } = hilo;
  assert.deepEqual(nearestPlaceText({ ...bare, distanceM: 1_240_000, bearingDeg: 200 }), {
    title: '1,240 km SSW of Hilo',
  });
  assert.equal(countryName('FI'), 'Finland');
  assert.equal(countryName('XKX'), 'XKX', 'not a code this system names: as given');
  assert.equal(countryName(undefined), undefined);
});

test('the card goes below and right of the point, flips where it would run off the map, and stays inside it', () => {
  const card = { width: 300, height: 200 };
  const map = { width: 1000, height: 700 };
  assert.deepEqual(cardPlacement({ x: 100, y: 100 }, card, map), { x: 112, y: 112 });
  assert.deepEqual(cardPlacement({ x: 900, y: 650 }, card, map), { x: 588, y: 438 }, 'flipped left and up');
  assert.deepEqual(cardPlacement({ x: 150, y: 690 }, { width: 300, height: 800 }, map), { x: 162, y: 8 });
  assert.deepEqual(cardPlacement(null, card, map), { x: 692, y: 56 }, 'from the palette: top right');
});

test("a selected satellite's next pass over the point, from its source's answer", () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const props = {
    passMinElevationDeg: 10,
    passDarkSkySunDeg: -6,
    passes: [
      {
        riseAt: '2026-10-05T03:10:00Z',
        riseAzimuthDeg: 300,
        culminationAt: '2026-10-05T03:13:00Z',
        culminationAzimuthDeg: 20,
        maxElevationDeg: 61.6,
        setAt: '2026-10-05T03:16:00Z',
        setAzimuthDeg: 100,
        visibleFrom: '2026-10-05T03:11:00Z',
        visibleUntil: '2026-10-05T03:15:30Z',
      },
    ],
  };
  assert.deepEqual(nextPassRows('ISS (ZARYA)', props, now), [
    { label: 'ISS (ZARYA) here', value: '2026-10-05 03:10:00 UTC · in 3h 10m · 62° max' },
    { label: 'To the eye', value: 'visible 03:11:00–03:15:30 UTC' },
  ]);
  assert.deepEqual(
    nextPassRows('ISS (ZARYA)', { ...props, passes: [], passesSearchedUntil: '2026-10-07T00:00:00Z' }, now),
    [{ label: 'ISS (ZARYA) here', value: 'No pass above 10° from here before 2026-10-07 00:00:00 UTC.' }],
  );
  assert.deepEqual(nextPassRows('ISS (ZARYA)', { satcatName: 'x' }, now), [], 'nothing about passes: nothing said');
});
