import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '@worldview/world-model';
import { CircularOrbitPropagator, gmstRadians } from './circular-orbit-propagator.js';
import type { GpElements } from './elements.js';

const ISS: GpElements = {
  noradId: 25544,
  name: 'ISS (ZARYA)',
  epoch: '2026-09-21T03:12:34.123Z',
  meanMotion: 15.49812345,
  eccentricity: 0.0006703,
  inclination: 51.6416,
  raan: 247.4627,
  argPerigee: 130.536,
  meanAnomaly: 325.0288,
};
const GEO: GpElements = {
  noradId: 41866,
  name: 'GOES 16',
  epoch: '2026-09-20T12:00:00.000Z',
  meanMotion: 1.00271234,
  eccentricity: 0.0001111,
  inclination: 0.0456,
  raan: 270.1234,
  argPerigee: 120.4567,
  meanAnomaly: 240.1234,
};

test('GMST: J2000.0 epoch is ≈ 18.697h (280.46°)', () => {
  const j2000 = Date.UTC(2000, 0, 1, 12);
  const deg = (gmstRadians(j2000) * 180) / Math.PI;
  assert.ok(Math.abs(deg - 280.46) < 0.01, String(deg));
});

test('circular propagation is deterministic and physically plausible for LEO', () => {
  const p = new CircularOrbitPropagator();
  const at = Date.parse('2026-09-21T08:00:00Z');
  const a = p.propagate(ISS, at)!;
  const b = p.propagate(ISS, at)!;
  assert.deepEqual(a, b);
  assert.ok(Math.abs(a.latitude) <= 51.65, `lat ${a.latitude}`);
  assert.ok(a.altitudeM > 380_000 && a.altitudeM < 460_000, `alt ${a.altitudeM}`);
  assert.ok(Math.abs(a.speedMps - 7660) < 40, `speed ${a.speedMps}`);
  assert.ok(a.headingDegrees !== undefined && a.headingDegrees >= 0 && a.headingDegrees < 360);
  // One full period later the sub-satellite point has moved west by Earth's rotation (~23°) but latitude repeats.
  const period = (1440 / ISS.meanMotion) * 60_000;
  const later = p.propagate(ISS, at + period)!;
  assert.ok(Math.abs(later.latitude - a.latitude) < 0.05, `${later.latitude} vs ${a.latitude}`);
  const dLon = ((a.longitude - later.longitude + 540) % 360) - 180;
  assert.ok(Math.abs(dLon - 23.3) < 0.5, `westward drift ${dLon}`);
  // 60 s of motion covers ≈ 460 km along the ground track.
  const step = p.propagate(ISS, at + 60_000)!;
  const d = haversineMeters(a, step);
  assert.ok(d > 400_000 && d < 480_000, `ground distance ${d}`);
});

test('a geostationary element set stays near-equatorial and nearly fixed in longitude', () => {
  const p = new CircularOrbitPropagator();
  const at = Date.parse('2026-09-21T08:00:00Z');
  const a = p.propagate(GEO, at)!;
  const b = p.propagate(GEO, at + 3600_000)!;
  assert.ok(Math.abs(a.latitude) < 0.1);
  assert.ok(a.altitudeM > 35_700_000 && a.altitudeM < 35_900_000, String(a.altitudeM));
  assert.ok(Math.abs(a.longitude - b.longitude) < 0.2, `${a.longitude} vs ${b.longitude}`);
});

test('invalid inputs propagate to undefined', () => {
  const p = new CircularOrbitPropagator();
  assert.equal(p.propagate({ ...ISS, meanMotion: 0 }, Date.now()), undefined);
  assert.equal(p.propagate(ISS, Number.NaN), undefined);
  assert.equal(p.propagate({ ...ISS, meanMotion: 25 }, Date.now()), undefined, 'orbit inside the Earth');
});
