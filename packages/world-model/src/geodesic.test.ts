import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHALIC_RADIUS_M, EARTH_AREA_M2, geodesicInverse, geodesicPolygonArea } from './geodesic.js';

/*
 * Expected values from GeographicLib (github.com/geographiclib/geographiclib at 48959df),
 * built and run outside this repository: `GeodSolve -i -p 9` and `Planimeter -p 6`. No
 * GeographicLib code is included. Beyond these, the module was compared on 22,007 random
 * pairs (distance within 0.08 mm, bearings within 1e-4″; three nearly antipodal pairs took the
 * spherical fallback, within 0.07%) and 1,204 random polygons (areas as geodesic.ts states).
 */

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test('distance and bearings on the ellipsoid, as GeodSolve gives them', () => {
  const cases: Array<[number, number, number, number, number, number, number]> = [
    // lat1, lon1, lat2, lon2, azimuth 1, azimuth 2, metres
    [21.3069, -157.8583, 19.7241, -155.0868, 120.73221231939083, 121.70377450331532, 338024.627112449],
    [74.30175, -38.73084, -28.19294, 22.26159, 124.8972849649183, 165.38134553836926, 12188691.356695672],
    [0, 0, 0, 90, 90, 90, 10018754.171394622],
    [51.4778, -0.0015, 40.6413, -73.7781, -71.742862318341, -128.74267892900474, 5584539.269572129],
    [-33.9, 151.2, -33.9, 151.20001, 90.00000278872555, 89.99999721127445, 0.924929027],
    [89.9, 0, -89.9, 0, 180, 180, 19981592.662942927],
    // Across 180°.
    [-17.8, 178.6, -17.8, -178.6, 90.42805112914165, 89.57194887085835, 296863.676972532],
  ];
  for (const [la1, lo1, la2, lo2, az1, az2, s] of cases) {
    const g = geodesicInverse({ latitude: la1, longitude: lo1 }, { latitude: la2, longitude: lo2 });
    const what = `${la1},${lo1} → ${la2},${lo2}`;
    near(g.distanceM, s, 0.001, what);
    assert.ok(angle(g.initialBearingDeg, az1) < 1e-6, `${what} initial ${g.initialBearingDeg} vs ${az1}`);
    assert.ok(angle(g.finalBearingDeg, az2) < 1e-6, `${what} final ${g.finalBearingDeg} vs ${az2}`);
    assert.equal(g.approximate, undefined);
  }
  assert.deepEqual(geodesicInverse({ latitude: 10, longitude: 20 }, { latitude: 10, longitude: 20 }), {
    distanceM: 0,
    initialBearingDeg: 0,
    finalBearingDeg: 0,
  });
});

test('nearly antipodal points: the spherical answer, within 0.1%, and said to be approximate', () => {
  // GeodSolve: 19,944,127.4 m.
  const g = geodesicInverse({ latitude: 0, longitude: 0 }, { latitude: 0.5, longitude: 179.7 });
  assert.equal(g.approximate, true);
  assert.ok(Math.abs(g.distanceM - 19_944_127.4) / 19_944_127.4 < 0.001);
});

test('area on the ellipsoid, as Planimeter gives it; either way round; round a pole; across 180°', () => {
  const area = (ring: Array<[number, number]>) =>
    geodesicPolygonArea(ring.map(([latitude, longitude]) => ({ latitude, longitude })));
  const rel = (a: number, b: number) => Math.abs(a - b) / b;
  // A one-degree square on the equator: 12,308,778,361.5 m².
  assert.ok(
    rel(
      area([
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ]),
      12_308_778_361.5,
    ) < 1e-6,
  );
  // A small triangle off O'ahu, both orientations: 287,150,748.7 m² (here 287,151,230: the
  // edges are great circles on the authalic sphere, not the geodesics — 2 parts in a million).
  assert.ok(
    rel(
      area([
        [21.3, -157.9],
        [21.4, -157.7],
        [21.2, -157.6],
      ]),
      287_150_748.7,
    ) < 1e-5,
  );
  assert.ok(
    rel(
      area([
        [21.3, -157.9],
        [21.2, -157.6],
        [21.4, -157.7],
      ]),
      287_150_748.7,
    ) < 1e-5,
  );
  // Round the North Pole at 80° N: 2,507,270,031,169.9 m².
  assert.ok(
    rel(
      area([
        [80, 0],
        [80, 90],
        [80, 180],
        [80, -90],
      ]),
      2_507_270_031_169.9,
    ) < 1e-4,
  );
  // A box across 180°: 1,035,082,269,630.4 m².
  assert.ok(
    rel(
      area([
        [60, 170],
        [60, -170],
        [70, -170],
        [70, 170],
      ]),
      1_035_082_269_630.4,
    ) < 1e-4,
  );
  assert.equal(
    area([
      [0, 0],
      [1, 1],
    ]),
    0,
    'fewer than three points enclose nothing',
  );
  // The authalic sphere has the ellipsoid's area: 510,065,621.7 km² for WGS84.
  near(AUTHALIC_RADIUS_M, 6_371_007.181, 0.001, 'authalic radius');
  near(EARTH_AREA_M2 / 1e6, 510_065_621.72, 0.01, 'surface area');
});
