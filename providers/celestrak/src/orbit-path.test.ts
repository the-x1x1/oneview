import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '@worldview/world-model';
import { orbitPath, ORBIT_PATH_STEPS, MAX_PATH_MS } from './orbit-path.js';
import { CircularOrbitPropagator } from './circular-orbit-propagator.js';
import { SatelliteJsPropagator, type SatelliteJsModule } from './satellite-js-propagator.js';
import type { GpElements } from './elements.js';

/** The ISS element set of fixtures/celestrak/normal.tle (invented values, real format; see its README). */
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
  bstar: 0.0001027,
  line1: '1 25544U 98067A   26264.13372828  .00016717  00000+0  10270-3 0  9998',
  line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49812345563533',
};
const START = Date.parse('2026-09-21T08:00:00Z');

async function loadSatelliteJs(): Promise<SatelliteJsModule | undefined> {
  try {
    return (await import('satellite.js')) as SatelliteJsModule;
  } catch {
    return undefined;
  }
}
const satelliteJs = await loadSatelliteJs();

test(
  'orbitPath (SGP4): one period of the ISS — 1440 / 15.498 = 92.9 min — ends where it began, one Earth-turn west',
  {
    skip: satelliteJs ? false : 'satellite.js not installed here',
  },
  async () => {
    const p = new SatelliteJsPropagator(async () => satelliteJs!);
    await p.prepare();
    const path = orbitPath(p, ISS, START);
    assert.equal(path.length, ORBIT_PATH_STEPS + 1, 'both ends included');
    const first = path[0]!;
    const last = path[path.length - 1]!;
    const periodMs = Date.parse(last.observedAt) - Date.parse(first.observedAt);
    assert.ok(Math.abs(periodMs / 60_000 - 92.91) < 0.02, `period ${periodMs / 60_000} min`);
    // After one period the satellite is back at the same point of its orbit: same latitude,
    // and west by the Earth's rotation in 92.9 min (360° × 92.9 / 1436.07 ≈ 23.3°), give or
    // take the orbit plane's own drift (J2 nodal regression, ~0.3° a revolution for the ISS).
    assert.ok(Math.abs(last.latitude - first.latitude) < 0.5, `latitude ${first.latitude} → ${last.latitude}`);
    const west = (((first.longitude - last.longitude) % 360) + 360) % 360;
    assert.ok(Math.abs(west - 23.6) < 0.8, `moved ${west}° west`);
    // Geodetic latitude peaks a little above the 51.64° inclination (the ellipsoid's flattening).
    assert.ok(path.every((q) => Math.abs(q.latitude) <= 52 && q.altitudeM! > 350_000 && q.altitudeM! < 500_000));
    // Consecutive points ~31 s apart at ~7.66 km/s: ~240 km of ground track (at altitude, a bit more).
    const step = haversineMeters(path[0]!, path[1]!);
    assert.ok(step > 180_000 && step < 260_000, `step ${step} m`);
  },
);

test('orbitPath: deterministic propagator — step count, cut at a day, stops at a failed propagation', () => {
  const circular = new CircularOrbitPropagator();
  const path = orbitPath(circular, ISS, START, 10);
  assert.equal(path.length, 11);
  assert.equal(Date.parse(path[10]!.observedAt) - START, Math.round((1440 / ISS.meanMotion) * 60_000));
  const high = orbitPath(circular, { ...ISS, meanMotion: 0.5 }, START, 4);
  assert.equal(Date.parse(high[4]!.observedAt) - START, MAX_PATH_MS, 'a 48 h period is cut at 24 h');
  let calls = 0;
  const failing = {
    name: 'fails after three',
    propagate: (e: GpElements, at: number) => (++calls > 3 ? undefined : circular.propagate(e, at)),
  };
  assert.equal(orbitPath(failing, ISS, START, 10).length, 3, 'a decayed orbit ends the path');
});
