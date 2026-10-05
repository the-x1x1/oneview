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
  assert.ok(Math.abs(satelliteNow(sat, T + 10 * 60_000)!.longitude - 7.2) < 0.05, 'held at two spans');
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
  assert.equal(satelliteNow(sat, T + 11 * 60_000), undefined, 'propagated eleven minutes ago');
  const bare = { ...sat, properties: { nextPosition: [0, 3.6, 400_000, T + 60_000] } } as WorldObject;
  assert.deepEqual(satelliteNow(bare, T + 30_000), sat.position, 'no propagatedAt: the element epoch is not used');
  const long = satellite('2', 0, 0, 400_000, { nextPosition: [0, 30, 400_000, T + 10 * 60_000] });
  assert.deepEqual(satelliteNow(long, T + 60_000), long.position, 'a span longer than two minutes is not carried');
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
  const t0 = performance.now();
  const answer = skyOverhead(sats, home, T + 30_000);
  const took = performance.now() - t0;
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
