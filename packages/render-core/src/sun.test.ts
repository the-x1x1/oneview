import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightRing, subsolarPoint, sunElevationDeg } from './sun.js';

/**
 * Reference instants (UTC) of the 2026 equinox and solstices, as published by the US Naval
 * Observatory: 20 March 14:46, 21 June 08:24, 21 December 20:50. At each, the Sun's
 * declination is 0 or ±23.44° (the obliquity of the ecliptic). The subsolar longitude
 * follows from the time of day and the equation of time on that date (−7.5 min in March,
 * −1.6 min in June, +1.9 min in December): 15° per hour from Greenwich noon.
 */
const EQUINOX = Date.parse('2026-03-20T14:46:00Z');
const JUNE = Date.parse('2026-06-21T08:24:00Z');
const DECEMBER = Date.parse('2026-12-21T20:50:00Z');

function expectedLongitude(utcMs: number, equationOfTimeMin: number): number {
  const d = new Date(utcMs);
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + equationOfTimeMin / 60;
  return -15 * (hours - 12);
}

test('subsolar point: on the equator at the March equinox', () => {
  const p = subsolarPoint(EQUINOX);
  assert.ok(Math.abs(p.latitude) < 0.05, `declination ${p.latitude}`);
  assert.ok(Math.abs(p.longitude - expectedLongitude(EQUINOX, -7.5)) < 0.3, `longitude ${p.longitude}`);
});

test('subsolar point: on the Tropic of Cancer at the June solstice', () => {
  const p = subsolarPoint(JUNE);
  assert.ok(Math.abs(p.latitude - 23.44) < 0.05, `declination ${p.latitude}`);
  assert.ok(Math.abs(p.longitude - expectedLongitude(JUNE, -1.6)) < 0.3, `longitude ${p.longitude}`);
});

test('subsolar point: on the Tropic of Capricorn at the December solstice', () => {
  const p = subsolarPoint(DECEMBER);
  assert.ok(Math.abs(p.latitude + 23.44) < 0.05, `declination ${p.latitude}`);
  assert.ok(Math.abs(p.longitude - expectedLongitude(DECEMBER, 1.9)) < 0.3, `longitude ${p.longitude}`);
});

test('sun elevation: overhead at the subsolar point, set at its antipode', () => {
  const p = subsolarPoint(JUNE);
  assert.ok(Math.abs(sunElevationDeg(JUNE, p) - 90) < 1e-6);
  assert.ok(Math.abs(sunElevationDeg(JUNE, { latitude: -p.latitude, longitude: p.longitude + 180 }) + 90) < 1e-6);
  // Midsummer: the North Pole has the Sun all day at the height of the declination.
  assert.ok(Math.abs(sunElevationDeg(JUNE, { latitude: 90, longitude: 0 }) - 23.44) < 0.05);
});

function assertEdgeAt(ring: Array<[number, number]>, at: number, elevation: number, poles: number): void {
  const closing = ring.filter(([, lat]) => Math.abs(lat) === 90);
  assert.equal(closing.length, poles, 'ring closes along one pole');
  for (const [lon, lat] of ring) {
    if (Math.abs(lat) === 90) continue;
    const h = sunElevationDeg(at, { latitude: lat, longitude: lon });
    assert.ok(Math.abs(h - elevation) < 0.01, `edge point ${lon},${lat} has the Sun at ${h}°`);
  }
  assert.deepEqual(ring[0], ring[ring.length - 1], 'closed');
}

function ringArea(ring: Array<[number, number]>): number {
  let a = 0;
  for (let i = 1; i < ring.length; i++) a += ring[i - 1]![0] * ring[i]![1] - ring[i]![0] * ring[i - 1]![1];
  return a / 2;
}

test('night ring: June solstice — the terminator, closed along the South Pole, counter-clockwise', () => {
  const ring = nightRing(JUNE);
  assertEdgeAt(ring, JUNE, 0, 2);
  assert.ok(
    ring.filter(([, lat]) => Math.abs(lat) === 90).every(([, lat]) => lat === -90),
    'the South Pole is in the night',
  );
  const lons = ring.map(([lon]) => lon);
  assert.ok(Math.abs(Math.max(...lons) - Math.min(...lons) - 360) < 1e-6, 'spans the whole world, unfolded');
  assert.ok(ringArea(ring) > 0, 'counter-clockwise');
});

test('night ring: December solstice — closed along the North Pole', () => {
  const ring = nightRing(DECEMBER);
  assertEdgeAt(ring, DECEMBER, 0, 2);
  assert.ok(ring.filter(([, lat]) => Math.abs(lat) === 90).every(([, lat]) => lat === 90));
  assert.ok(ringArea(ring) > 0);
});

test('night ring: at the equinox the terminator crosses the equator 90° either side of the subsolar meridian', () => {
  const ring = nightRing(EQUINOX);
  // The declination is held a millidegree off zero, so the edge is within 0.01° of the Sun's horizon.
  assertEdgeAt(ring, EQUINOX, 0, 2);
  const sun = subsolarPoint(EQUINOX);
  // The terminator crosses the equator 90° either side of the subsolar meridian.
  const nearEquator = ring.filter(([, lat]) => Math.abs(lat) < 2);
  assert.ok(nearEquator.length >= 2);
  for (const [lon] of nearEquator) {
    const off = Math.abs(((((lon - sun.longitude) % 360) + 540) % 360) - 180);
    assert.ok(Math.abs(off - 90) < 2.5, `crosses the equator ${off}° from the subsolar meridian`);
  }
});

test('night ring: a twilight band clear of both poles is a closed blob of continuous longitudes', () => {
  // At the equinox the past-civil-twilight region (Sun below −6°) is a cap of radius 84°
  // round the antisolar point on the equator: no pole in it.
  const ring = nightRing(EQUINOX, -6);
  assertEdgeAt(ring, EQUINOX, -6, 0);
  const lons = ring.map(([lon]) => lon);
  assert.ok(Math.max(...lons) - Math.min(...lons) < 180, 'one piece, not a band round the world');
  assert.ok(ringArea(ring) > 0);
});
