import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SatelliteJsPropagator, toOmm, type SatelliteJsModule } from './satellite-js-propagator.js';
import type { GpElements } from './elements.js';

const ISS: GpElements = { noradId: 25544, name: 'ISS (ZARYA)', intlDesignator: '1998-067A', epoch: '2026-09-21T03:12:34.123Z', meanMotion: 15.49812345, eccentricity: 0.0006703, inclination: 51.6416, raan: 247.4627, argPerigee: 130.536, meanAnomaly: 325.0288, bstar: 0.0001027, line1: '1 25544U 98067A   26264.13372828  .00016717  00000+0  10270-3 0  9998', line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49812345563533' };

async function loadSatelliteJs(): Promise<SatelliteJsModule | undefined> {
  try { return (await import('satellite.js')) as SatelliteJsModule; } catch { return undefined; }
}
const satelliteJs = await loadSatelliteJs();
const skipReason = satelliteJs ? false : 'satellite.js is not installed in this environment (no registry access); SGP4 path verified against the typed shim only';

test('SGP4 through satellite.js: ISS position is plausible and heading is derived', { skip: skipReason }, async () => {
  const p = new SatelliteJsPropagator(async () => satelliteJs!);
  await p.prepare();
  assert.equal(p.ready, true);
  const state = p.propagate(ISS, Date.parse('2026-09-21T08:00:00Z'));
  assert.ok(state);
  assert.ok(Math.abs(state.latitude) <= 51.7);
  assert.ok(state.altitudeM > 380_000 && state.altitudeM < 460_000, String(state.altitudeM));
  assert.ok(Math.abs(state.speedMps - 7660) < 60);
  assert.ok(state.headingDegrees !== undefined);
  const ommOnly = { ...ISS };
  delete ommOnly.line1; delete ommOnly.line2;
  const viaOmm = p.propagate(ommOnly, Date.parse('2026-09-21T08:00:00Z'));
  assert.ok(viaOmm && Math.abs(viaOmm.latitude - state.latitude) < 0.5, 'OMM and TLE paths agree');
});

test('propagate() before prepare() is a programming error; a failed load reports the cause', async () => {
  const p = new SatelliteJsPropagator(() => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')));
  assert.throws(() => p.propagate(ISS, Date.now()), /prepare\(\)/);
  await assert.rejects(p.prepare(), /satellite\.js is not available: ERR_MODULE_NOT_FOUND/);
  assert.equal(p.ready, false);
});

test('a satrec with error ≠ 0 or a false position yields undefined and is cached per element set', async () => {
  let builds = 0;
  // A real SatRec carries ~90 fields of SGP4 state. These fakes carry only what the
  // propagator reads, so they are cast deliberately rather than declared complete.
  const satrec = (fields: Record<string, unknown>) => fields as unknown as ReturnType<SatelliteJsModule['twoline2satrec']>;
  const fake: SatelliteJsModule = {
    twoline2satrec: () => { builds++; return satrec({ satnum: '25544', error: 1, epochyr: 26, epochdays: 264, jdsatepoch: 0, no: 0, inclo: 0, nodeo: 0, ecco: 0, argpo: 0, mo: 0, bstar: 0 }); },
    json2satrec: () => { builds++; return satrec({ satnum: '1', error: 0, epochyr: 26, epochdays: 264, jdsatepoch: 0, no: 0, inclo: 0, nodeo: 0, ecco: 0, argpo: 0, mo: 0, bstar: 0 }); },
    // `false` is what satellite.js returns for a propagation that produced no position.
    propagate: () => ({ position: false, velocity: false }) as unknown as ReturnType<SatelliteJsModule['propagate']>,
    gstime: () => 0,
    eciToGeodetic: () => ({ longitude: 0, latitude: 0, height: 400 }),
    degreesLat: (r) => r,
    degreesLong: (r) => r,
  };
  const p = new SatelliteJsPropagator(async () => fake);
  await p.prepare();
  assert.equal(p.propagate(ISS, 1), undefined);
  assert.equal(p.propagate(ISS, 2), undefined);
  assert.equal(builds, 1, 'satrec construction is cached per NORAD id + epoch');
  const omm = { ...ISS };
  delete omm.line1; delete omm.line2;
  assert.equal(p.propagate(omm, 1), undefined, 'false position from propagate() → undefined');
  assert.equal(builds, 2);
});

test('toOmm reproduces CelesTrak field names (epoch without zone designator)', () => {
  const omm = toOmm(ISS);
  assert.equal(omm.NORAD_CAT_ID, 25544);
  assert.equal(omm.EPOCH, '2026-09-21T03:12:34.123');
  assert.equal(omm.OBJECT_ID, '1998-067A');
  assert.equal(omm.MEAN_MOTION, ISS.meanMotion);
  assert.equal(omm.BSTAR, 0.0001027);
  assert.equal(omm.CLASSIFICATION_TYPE, 'U');
});
