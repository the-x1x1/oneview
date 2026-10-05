import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, lookAngles, subsolarPoint, toEcef, type WorldObject } from '@worldview/world-model';
import { fromEcef, satelliteNow, skyOverhead, sunlit } from './sky-overhead.js';

const T = Date.parse('2026-10-05T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function satellite(
  id: string,
  lat: number,
  lon: number,
  altitudeM: number,
  props: Record<string, unknown> = {},
): WorldObject {
  return {
    id: `satellite:norad:${id}`,
    type: 'satellite',
    labels: { name: `SAT ${id}` },
    position: { latitude: lat, longitude: lon, altitudeM },
    observedAt: iso(T),
    properties: { propagatedAt: iso(T), satelliteCategory: 'other', ...props },
    confidence: 0.9,
    freshness: 'LIVE',
    sourceRefs: [],
    provenance: { providerId: 'celestrak', sourceName: 'CelesTrak', origin: 'live', receivedAt: iso(T) },
  } as unknown as WorldObject;
}

test('ECEF back to latitude, longitude and height: to the millimetre, in orbit and at the poles', () => {
  for (const p of [
    { latitude: 45, longitude: 10, altitudeM: 400_000 },
    { latitude: -33.9, longitude: 151.2, altitudeM: 35_786_000 },
    { latitude: 89.999, longitude: -120, altitudeM: 800_000 },
    { latitude: 0, longitude: 180, altitudeM: 0 },
  ]) {
    const back = fromEcef(...toEcef(p));
    assert.ok(Math.abs(back.latitude - p.latitude) < 1e-9, JSON.stringify(back));
    assert.ok(Math.abs(((back.longitude - p.longitude + 540) % 360) - 180) < 1e-9);
    assert.ok(Math.abs(back.altitudeM! - p.altitudeM) < 0.001, `${back.altitudeM}`);
  }
});

test('a satellite carried along the chord to its next propagated position, no further than two spans', () => {
  const sat = satellite('1', 0, 0, 400_000, { nextPosition: [0, 3.6, 400_000, T + 60_000] });
  const half = satelliteNow(sat, T + 30_000)!;
  assert.ok(Math.abs(half.longitude - 1.8) < 0.01 && Math.abs(half.latitude) < 1e-6, JSON.stringify(half));
  // The chord dips a little under the orbit midway: 400 km less a few.
  assert.ok(half.altitudeM! < 400_000 && half.altitudeM! > 396_000, `${half.altitudeM}`);
  assert.ok(Math.abs(satelliteNow(sat, T + 150_000)!.longitude - 7.2) < 0.05, 'held at two spans');
  assert.deepEqual(satelliteNow(sat, T - 5_000), sat.position, 'not before its propagation');
  assert.deepEqual(satelliteNow(satellite('2', 1, 2, 500_000), T + 30_000), {
    latitude: 1,
    longitude: 2,
    altitudeM: 500_000,
  });
});

test("sunlit: the day side, the night side's shadow, and past the shadow's edge", () => {
  const s = subsolarPoint(T);
  const sun = toEcef({ latitude: s.latitude, longitude: s.longitude, altitudeM: 0 });
  const r = Math.hypot(...sun);
  const dir = [sun[0] / r, sun[1] / r, sun[2] / r] as const;
  const at = (lat: number, lon: number, alt: number) => toEcef({ latitude: lat, longitude: lon, altitudeM: alt });
  assert.equal(sunlit(at(s.latitude, s.longitude, 400_000), dir), true, 'under the Sun');
  assert.equal(sunlit(at(-s.latitude, s.longitude + 180, 400_000), dir), false, 'at local midnight, 400 km up');
  assert.equal(
    sunlit(at(-s.latitude, s.longitude + 180, 35_786_000), dir),
    false,
    'a geostationary satellite at local midnight, near an equinox, in the shadow',
  );
  // Near the terminator, 1,000 km up over the night side: still in the sunlight above the shadow.
  assert.equal(sunlit(at(0, s.longitude + 100, 1_000_000), dir), true);
});

test('what is above a place, highest first, with how many there are', () => {
  const home = { latitude: 21.3, longitude: -157.85 };
  const overhead = satellite('25544', 21.3, -157.85, 420_000);
  const low = satellite('2', 25, -150, 550_000);
  const far = satellite('3', -21.3, 22.15, 420_000);
  const answer = skyOverhead([far, low, overhead], home, T);
  assert.deepEqual(
    answer.satellites.map((s) => s.id),
    ['satellite:norad:25544', 'satellite:norad:2'],
  );
  assert.equal(answer.total, 2);
  const top = answer.satellites[0]!;
  assert.ok(top.elevationDeg > 89.9, `${top.elevationDeg}`);
  assert.ok(Math.abs(top.rangeM - 420_000) < 500);
  assert.equal(top.name, 'SAT 25544');
  assert.equal(top.category, 'other');
  const second = answer.satellites[1]!;
  assert.ok(second.azimuthDeg > 45 && second.azimuthDeg < 80, `${second.azimuthDeg}: north-east`);
  // 12:00 UTC is 02:00 in Honolulu: the Sun well down.
  assert.ok(answer.sunElevationDeg < -40, `${answer.sunElevationDeg}`);
  assert.equal(answer.at, iso(T));
  // Limits and a minimum elevation.
  assert.equal(skyOverhead([far, low, overhead], home, T, { limit: 1 }).satellites.length, 1);
  assert.equal(skyOverhead([far, low, overhead], home, T, { limit: 1 }).total, 2);
  assert.deepEqual(
    skyOverhead([far, low, overhead], home, T, { minElevationDeg: second.elevationDeg + 1 }).satellites.map(
      (s) => s.id,
    ),
    ['satellite:norad:25544'],
  );
  // Nothing that is not a satellite, nothing without a height.
  const plane = { ...overhead, id: 'aircraft:icao24:a', type: 'aircraft' } as WorldObject;
  const flat = { ...low, position: { latitude: 21.3, longitude: -157.85 } } as WorldObject;
  assert.equal(skyOverhead([plane, flat], home, T).total, 0);
  assert.ok(haversineMeters(home, { latitude: 25, longitude: -150 }) > 0);
});

test('a stale satellite is not "now"; without its propagation time, taken where it is', () => {
  const sat = satellite('1', 0, 0, 400_000, { nextPosition: [0, 3.6, 400_000, T + 60_000] });
  // Carried two one-minute spans, to T + 2 min; a minute past that it is still kept.
  assert.ok(satelliteNow(sat, T + 180_000), 'a minute behind, carried as far as it goes');
  assert.equal(satelliteNow(sat, T + 181_000), undefined, 'more than a minute behind');
  assert.equal(satelliteNow(sat, T + 11 * 60_000), undefined, 'propagated eleven minutes ago');
  // Counted as stale when it is near enough to be overhead, not drawn where it was.
  const answer = skyOverhead([sat], { latitude: 0, longitude: 3 }, T + 5 * 60_000);
  assert.equal(answer.total, 0);
  assert.equal(answer.stale, 1);
  assert.equal(skyOverhead([sat], { latitude: 0, longitude: 120 }, T + 5 * 60_000).stale, 0, 'not when far away');
  const bare = { ...sat, properties: { nextPosition: [0, 3.6, 400_000, T + 60_000] } } as WorldObject;
  assert.deepEqual(satelliteNow(bare, T + 30_000), sat.position, 'no propagatedAt: the element epoch is not used');
  const long = satellite('2', 0, 0, 400_000, { nextPosition: [0, 30, 400_000, T + 10 * 60_000] });
  assert.deepEqual(satelliteNow(long, T + 30_000), long.position, 'a span longer than two minutes is not carried');
});

test('the filters apply before anything is counted or cut, and the could-be-seen count is over them all', () => {
  // 02:00 in Honolulu: dark. Three overhead and sunlit-or-not, one Starlink, one low.
  const home = { latitude: 21.3, longitude: -157.85 };
  const sats = [
    satellite('a', 21.3, -157.85, 420_000, { satelliteCategory: 'station' }),
    satellite('b', 22, -157, 550_000, { satelliteCategory: 'starlink' }),
    satellite('c', 23, -156, 35_786_000, { satelliteCategory: 'comms' }),
    satellite('d', 30, -150, 550_000),
  ];
  const all = skyOverhead(sats, home, T, { limit: 1 });
  assert.equal(all.total, 4);
  assert.equal(all.satellites.length, 1);
  const noStarlink = skyOverhead(sats, home, T, { excludeCategories: ['starlink'] });
  assert.equal(noStarlink.total, 3);
  assert.ok(!noStarlink.satellites.some((s) => s.category === 'starlink'));
  const eye = skyOverhead(sats, home, T, { visibleOnly: true });
  assert.equal(eye.satellites.length, eye.visible, 'only those that could be seen');
  assert.equal(eye.total, 4, 'the count above the horizon stays');
  for (const s of eye.satellites) assert.ok(s.sunlit && s.elevationDeg >= 10);
  // The geostationary one is sunlit at local 02:00 outside eclipse season? Whatever it is, the
  // count is the same one the list was cut from.
  assert.equal(skyOverhead(sats, home, T).visible, eye.visible);
});

test('a whole catalogue in tens of milliseconds: what is past the horizon is put aside before it is worked out', () => {
  const sats: WorldObject[] = [];
  for (let i = 0; i < 30_000; i++) {
    const lat = ((i * 37) % 180) - 90;
    const lon = ((i * 113) % 360) - 180;
    sats.push(
      satellite(String(i), lat, lon, 550_000, {
        nextPosition: [lat, ((lon + 3.6 + 540) % 360) - 180, 550_000, T + 60_000],
      }),
    );
  }
  const home = { latitude: 21.3, longitude: -157.85 };
  // The tab asks every five seconds: the time that counts is a warm one (the first call also
  // compiles the code, 30–80 ms on its own), the best of three against a busy test machine.
  const answer = skyOverhead(sats, home, T + 30_000);
  let took = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    skyOverhead(sats, home, T + 30_000);
    took = Math.min(took, performance.now() - t0);
  }
  assert.ok(answer.total > 0 && answer.total < 2_000, `${answer.total}`);
  assert.ok(took < 60, `${took.toFixed(1)} ms for 30,000`);
  // The prefilter keeps everything a full pass would have found.
  let full = 0;
  for (const o of sats) {
    const p = satelliteNow(o, T + 30_000)!;
    if (lookAngles(home, p).elevationDeg >= 0) full++;
  }
  assert.equal(answer.total, full);
});

test('nothing above the horizon is put aside by the cheap test, carried two two-minute spans, down to −5°', () => {
  // Low orbits and a Molniya perigee coming over the horizon from every side, carried the
  // furthest the runtime carries anything (two spans of 120 s): the review of 2026-10-05 found
  // a fixed 16° margin dropped some of these.
  const now = T + 240_000;
  const orbits: Array<[number, number]> = [
    [200_000, 7_790],
    [400_000, 7_670],
    [500_000, 10_000],
    [20_200_000, 3_870],
  ];
  for (const [alt, speed] of orbits) {
    const stepDeg = ((speed * 120) / (6_371_000 + alt)) * (180 / Math.PI);
    for (const minEl of [0, -5]) {
      for (const bearing of [0, 90, 135, 270]) {
        for (let d = 5; d < 90; d += 0.25) {
          // Starting d degrees from the observer at (10, 20) and heading straight for it.
          const θ = (bearing * Math.PI) / 180;
          const lat = 10 + d * Math.cos(θ);
          const lon = 20 + (d * Math.sin(θ)) / Math.cos((10 * Math.PI) / 180);
          const nlat = 10 + (d - stepDeg) * Math.cos(θ);
          const nlon = 20 + ((d - stepDeg) * Math.sin(θ)) / Math.cos((10 * Math.PI) / 180);
          if (Math.abs(lat) > 89 || Math.abs(nlat) > 89) continue;
          const o = satellite(`${alt}-${bearing}-${d}`, lat, lon, alt, {
            nextPosition: [nlat, nlon, alt, T + 120_000],
          });
          const p = satelliteNow(o, now)!;
          const up = lookAngles({ latitude: 10, longitude: 20 }, p).elevationDeg >= minEl;
          const got = skyOverhead([o], { latitude: 10, longitude: 20 }, now, { minElevationDeg: minEl }).total;
          assert.equal(got, up ? 1 : 0, `${alt} m, ${bearing}°, ${d}° away, ≥ ${minEl}°`);
        }
      }
    }
  }
});

test('"could be seen" is decided on the elevation as sent, to a tenth', () => {
  // A geostationary satellite just under 10° from Honolulu at 02:00, sunlit or not: whatever
  // the runtime counts, the listed elevation agrees with it at the 10° line.
  const home = { latitude: 21.3, longitude: -157.85 };
  const geo = (lon: number) => satellite('g', 0, lon, 35_786_000);
  let lo = -157.85;
  let hi = -157.85 + 80;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lookAngles(home, geo(mid).position!).elevationDeg > 9.97) lo = mid;
    else hi = mid;
  }
  const a = skyOverhead([geo(lo)], home, T);
  const s = a.satellites[0]!;
  assert.equal(s.elevationDeg, 10);
  assert.equal(a.visible, s.sunlit && a.sunElevationDeg <= -6 ? 1 : 0);
  assert.equal(skyOverhead([geo(lo)], home, T, { visibleOnly: true }).satellites.length, a.visible);
});
