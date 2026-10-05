import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DARK_SKY_SUN_DEG,
  geodeticToEcef,
  isSunlit,
  lookAngles,
  lookAnglesAt,
  nextPasses,
  sunDirectionEcef,
  sunElevationAt,
} from './passes.js';
import { SatelliteJsPropagator, type SatelliteJsModule } from './satellite-js-propagator.js';
import { tleToElements, type GpElements } from './elements.js';

/**
 * The ISS element set printed as the worked example of the two-line format in most TLE
 * references (epoch 2008-09-20 12:25:40 UTC) — a real, published element set, so the passes
 * below are ones SGP4 predicts for that day, not invented geometry.
 */
const ISS_2008_L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS_2008_L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const START = Date.parse('2008-09-20T12:30:00Z');
const OBSERVER = { latitude: 40.0, longitude: -75.0 }; // near Philadelphia

/** The subset of satellite.js the reference checks use (independent look-angle code). */
interface LookAngleLib {
  propagate: SatelliteJsModule['propagate'];
  gstime: SatelliteJsModule['gstime'];
  twoline2satrec: SatelliteJsModule['twoline2satrec'];
  eciToEcf(eci: { x: number; y: number; z: number }, gmst: number): { x: number; y: number; z: number };
  geodeticToEcf(g: { longitude: number; latitude: number; height: number }): { x: number; y: number; z: number };
  ecfToLookAngles(
    observer: { longitude: number; latitude: number; height: number },
    ecf: { x: number; y: number; z: number },
  ): { azimuth: number; elevation: number; rangeSat: number };
}

async function load(): Promise<(SatelliteJsModule & LookAngleLib) | undefined> {
  try {
    return (await import('satellite.js')) as unknown as SatelliteJsModule & LookAngleLib;
  } catch {
    return undefined;
  }
}
const lib = await load();
const skip = lib ? false : 'satellite.js not installed here';

function iss(): GpElements {
  const e = tleToElements('ISS (ZARYA)', ISS_2008_L1, ISS_2008_L2);
  assert.ok(typeof e !== 'string', `the reference TLE parses (${String(e)})`);
  return e;
}

async function propagator(): Promise<SatelliteJsPropagator> {
  const p = new SatelliteJsPropagator(async () => lib!);
  await p.prepare();
  return p;
}

test('geodeticToEcef: WGS84 equator, pole and a point agree with satellite.js', { skip }, () => {
  const eq = geodeticToEcef(0, 0, 0);
  assert.ok(Math.abs(eq[0] - 6378.137) < 1e-9 && Math.abs(eq[1]) < 1e-9 && Math.abs(eq[2]) < 1e-9);
  const pole = geodeticToEcef(90, 0, 0);
  assert.ok(Math.abs(pole[2] - 6356.752314) < 1e-3, `polar radius ${pole[2]}`);
  const mine = geodeticToEcef(40, -75, 1000);
  const ref = lib!.geodeticToEcf({ latitude: 40 * (Math.PI / 180), longitude: -75 * (Math.PI / 180), height: 1 });
  assert.ok(Math.hypot(mine[0] - ref.x, mine[1] - ref.y, mine[2] - ref.z) < 0.01, 'within 10 m');
});

test('lookAngles: elevation and azimuth match satellite.js ecfToLookAngles along the ISS orbit', { skip }, () => {
  const satrec = lib!.twoline2satrec(ISS_2008_L1, ISS_2008_L2);
  const obs = {
    latitude: OBSERVER.latitude * (Math.PI / 180),
    longitude: OBSERVER.longitude * (Math.PI / 180),
    height: 0,
  };
  let compared = 0;
  for (let t = START; t < START + 6 * 3600_000; t += 7 * 60_000) {
    const date = new Date(t);
    const pv = lib!.propagate(satrec, date);
    const pos = pv?.position;
    if (!pos || typeof pos === 'boolean') continue;
    const gmst = lib!.gstime(date);
    const ref = lib!.ecfToLookAngles(obs, lib!.eciToEcf(pos, gmst));
    const geo = lib!.eciToGeodetic(pos, gmst);
    const mine = lookAngles(OBSERVER, {
      latitude: lib!.degreesLat(geo.latitude),
      longitude: lib!.degreesLong(geo.longitude),
      altitudeM: geo.height * 1000,
    });
    const refEl = ref.elevation * (180 / Math.PI);
    const refAz = ref.azimuth * (180 / Math.PI);
    // Through geodetic and back costs a little (satellite.js's iterative latitude); well under
    // anything that would move a rise time by a second.
    assert.ok(Math.abs(mine.elevationDeg - refEl) < 0.02, `elevation ${mine.elevationDeg} vs ${refEl}`);
    const dAz = Math.abs(((mine.azimuthDeg - refAz + 540) % 360) - 180);
    if (refEl > -80) assert.ok(dAz < 0.05, `azimuth ${mine.azimuthDeg} vs ${refAz}`);
    assert.ok(Math.abs(mine.rangeKm - ref.rangeSat) < 0.5, `range ${mine.rangeKm} vs ${ref.rangeSat}`);
    compared++;
  }
  assert.ok(compared > 40);
});

test(
  'nextPasses: the ISS over 40° N 75° W from the 2008 reference TLE — three passes, checked by a dense scan',
  { skip },
  async () => {
    const p = await propagator();
    const e = iss();
    const result = nextPasses(p, e, OBSERVER, START);
    assert.equal(result.alwaysAbove, false);
    assert.equal(result.passes.length, 3);
    let previousSet = START;
    for (const pass of result.passes) {
      assert.ok(pass.riseAt !== undefined && pass.setAt !== undefined, 'each pass rises and sets in the window');
      const rise = pass.riseAt!;
      const set = pass.setAt!;
      assert.ok(previousSet <= rise && rise < pass.culminationAt && pass.culminationAt < set);
      // Above 10° the ISS is in view for at most ~7 minutes (a pass straight overhead), and at
      // least a few tens of seconds.
      assert.ok(set - rise < 8 * 60_000 && set - rise > 20_000, `duration ${(set - rise) / 1000} s`);
      assert.ok(pass.maxElevationDeg >= 10 && pass.maxElevationDeg <= 90);
      // The rise and set are where the elevation is 10°, to the second: at most a second's
      // climb (~0.1° for a low pass, up to ~0.4° near overhead) either side.
      const riseEl = lookAnglesAt(p, e, OBSERVER, rise)!.elevationDeg;
      const setEl = lookAnglesAt(p, e, OBSERVER, set)!.elevationDeg;
      assert.ok(Math.abs(riseEl - 10) < 0.5 && riseEl >= 10 - 1e-9, `rise elevation ${riseEl}`);
      assert.ok(Math.abs(setEl - 10) < 0.5 && setEl < 10, `set elevation ${setEl}`);
      // Brute force, one-second steps across the pass: the peak is where the search says.
      let bestT = rise;
      let best = -90;
      for (let t = rise - 30_000; t <= set + 30_000; t += 1000) {
        const el = lookAnglesAt(p, e, OBSERVER, t)!.elevationDeg;
        if (el > best) {
          best = el;
          bestT = t;
        }
        if (t < rise) assert.ok(el < 10, 'not above 10° before the reported rise');
        if (t >= set) assert.ok(el < 10, 'not above 10° after the reported set');
      }
      assert.ok(Math.abs(best - pass.maxElevationDeg) < 0.1, `peak ${best} vs ${pass.maxElevationDeg}`);
      assert.ok(
        Math.abs(bestT - pass.culminationAt) <= 3000,
        `peak time off by ${(bestT - pass.culminationAt) / 1000} s`,
      );
      const az = lookAnglesAt(p, e, OBSERVER, rise)!.azimuthDeg;
      assert.ok(Math.abs(((az - pass.riseAzimuthDeg! + 540) % 360) - 180) < 0.5);
      previousSet = set;
    }
    // No pass was skipped: a 5-second scan from the start to the last set finds exactly these.
    let crossings = 0;
    let above = lookAnglesAt(p, e, OBSERVER, START)!.elevationDeg >= 10;
    for (let t = START; t <= previousSet; t += 5000) {
      const now = lookAnglesAt(p, e, OBSERVER, t)!.elevationDeg >= 10;
      if (now && !above) crossings++;
      above = now;
    }
    assert.equal(crossings, 3);
  },
);

test('nextPasses: none from the North Pole — the ISS never climbs that far north', { skip }, async () => {
  const p = await propagator();
  const r = nextPasses(p, iss(), { latitude: 89.9, longitude: 0 }, START, { horizonMs: 86_400_000 });
  assert.deepEqual(r.passes, []);
  assert.equal(r.alwaysAbove, false);
  assert.equal(r.searchedUntil, START + 86_400_000);
});

test(
  'nextPasses: a geostationary satellite overhead is always above; one on the far side never rises',
  { skip },
  async () => {
    const p = await propagator();
    // Invented element set for the test: a circular, equatorial, one-revolution-a-day orbit.
    const geo: GpElements = {
      noradId: 99001,
      name: 'TEST GEO (invented)',
      epoch: '2008-09-20T12:00:00.000Z',
      meanMotion: 1.00273791,
      eccentricity: 0.0001,
      inclination: 0.05,
      raan: 0,
      argPerigee: 0,
      meanAnomaly: 0,
      bstar: 0,
    };
    const at = p.propagate(geo, START)!;
    const under = nextPasses(p, geo, { latitude: 0, longitude: at.longitude }, START, { horizonMs: 86_400_000 });
    assert.equal(under.alwaysAbove, true);
    assert.deepEqual(under.passes, []);
    const opposite = ((at.longitude + 360) % 360) - 180;
    const far = nextPasses(p, geo, { latitude: 0, longitude: opposite }, START, { horizonMs: 86_400_000 });
    assert.equal(far.alwaysAbove, false);
    assert.deepEqual(far.passes, []);
  },
);

test('nextPasses: a pass in progress at the start has no rise; propagation failure ends the search', () => {
  // A fake propagator: straight overhead for the first two minutes, then gone below the horizon.
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const fake = {
    name: 'fake',
    propagate: (_e: GpElements, t: number) =>
      t - t0 < 120_000
        ? { latitude: 0, longitude: 0, altitudeM: 400_000, speedMps: 7600 }
        : t - t0 < 600_000
          ? { latitude: 0, longitude: 60, altitudeM: 400_000, speedMps: 7600 }
          : undefined,
  };
  const e = { meanMotion: 15.5 } as GpElements;
  const r = nextPasses(fake, e, { latitude: 0, longitude: 0 }, t0);
  assert.equal(r.passes.length, 1);
  assert.equal(r.passes[0]!.riseAt, undefined);
  assert.equal(r.passes[0]!.maxElevationDeg, 90);
  assert.ok(r.passes[0]!.setAt! > t0 + 100_000 && r.passes[0]!.setAt! <= t0 + 120_000);
  assert.ok(r.searchedUntil < t0 + 600_000, 'stopped where the propagator stopped');
});

test('visibility geometry: the shadow of the Earth and the Sun at the observer', () => {
  const sun: [number, number, number] = [1, 0, 0];
  // On the day side, beside the Earth, and deep in the shadow cylinder.
  assert.equal(isSunlit([7000, 0, 0], sun), true);
  assert.equal(isSunlit([0, 6800, 0], sun), true);
  assert.equal(isSunlit([-6800, 0, 0], sun), false);
  assert.equal(isSunlit([-6800, 0, 6300], sun), false, 'inside the 6,371 km cylinder');
  assert.equal(isSunlit([-6800, 0, 6500], sun), true, 'outside it: high over the night side, still lit');
  // The Sun overhead at the subsolar point, on the horizon 90° away, below it opposite.
  assert.ok(Math.abs(sunElevationAt({ latitude: 0, longitude: 0 }, sun) - 90) < 1e-9);
  assert.ok(Math.abs(sunElevationAt({ latitude: 0, longitude: 90 }, sun)) < 1e-9);
  assert.ok(sunElevationAt({ latitude: 0, longitude: 180 }, sun) < -89);
  // At the 2008 September equinox the Sun stands near 0° latitude; at 12:00 UTC near 0° longitude.
  const d = sunDirectionEcef(Date.parse('2008-09-22T12:00:00Z'));
  assert.ok(Math.abs(Math.asin(d[2]) * (180 / Math.PI)) < 0.5);
  assert.ok(Math.abs(Math.atan2(d[1], d[0]) * (180 / Math.PI)) < 2.5);
});

test(
  'nextPasses: a pass is visible only where the ISS is sunlit and the sky at the observer is dark',
  { skip },
  async () => {
    const p = await propagator();
    const e = iss();
    const { passes } = nextPasses(p, e, OBSERVER, START, { count: 12 });
    assert.equal(passes.length, 12);
    const seen = passes.filter((x) => x.visibleFrom !== undefined);
    // The evening passes after dusk; not the one at sunset, nor any in the small hours, when
    // the ISS crosses the night sky in the Earth's shadow.
    assert.deepEqual(
      seen.map((x) => new Date(x.visibleFrom!).toISOString()),
      ['2008-09-21T00:25:44.000Z', '2008-09-22T00:53:07.000Z', '2008-09-22T23:43:35.000Z'],
    );
    for (const x of passes) {
      if (x.visibleFrom === undefined) {
        assert.equal(x.visibleUntil, undefined);
        continue;
      }
      assert.ok(x.visibleFrom >= x.riseAt! && x.visibleUntil! <= x.setAt! && x.visibleFrom <= x.visibleUntil!);
      for (const t of [x.visibleFrom, x.visibleUntil!]) {
        assert.ok(sunElevationAt(OBSERVER, sunDirectionEcef(t)) <= DARK_SKY_SUN_DEG);
        const s = p.propagate(e, t)!;
        assert.ok(isSunlit(geodeticToEcef(s.latitude, s.longitude, s.altitudeM), sunDirectionEcef(t)));
      }
    }
    // A daytime pass is never visible.
    const day = passes.find((x) => sunElevationAt(OBSERVER, sunDirectionEcef(x.culminationAt)) > 0);
    assert.ok(day && day.visibleFrom === undefined);
  },
);

test('nextPasses: a pass a few seconds long between two samples is found', { skip }, async () => {
  const p = await propagator();
  const e = iss();
  // The 02:03 pass on 2008-09-21 peaks at 12.1°: with the threshold a hair under its exact
  // peak it is above for a few seconds only, between two 20 s samples.
  const low = nextPasses(p, e, OBSERVER, START, { count: 3 }).passes.find((x) => x.maxElevationDeg < 13)!;
  const peakEl = lookAnglesAt(p, e, OBSERVER, low.culminationAt)!.elevationDeg;
  const min = peakEl - 0.0005;
  const fine = nextPasses(p, e, OBSERVER, START, { count: 3, minElevationDeg: min, stepMs: 1000 });
  const brief = fine.passes.find((x) => x.setAt! - x.riseAt! < 20_000);
  assert.ok(brief, 'a pass of under 20 s at one-second sampling');
  const coarse = nextPasses(p, e, OBSERVER, START, { count: 3, minElevationDeg: min });
  const found = coarse.passes.find((x) => Math.abs(x.culminationAt - brief.culminationAt) < 2000);
  assert.ok(found, 'also found at 20 s sampling');
  assert.ok(Math.abs(found.riseAt! - brief.riseAt!) <= 1000 && Math.abs(found.setAt! - brief.setAt!) <= 1000);
  assert.ok(found.maxElevationDeg >= Math.floor(min * 10) / 10);
});
