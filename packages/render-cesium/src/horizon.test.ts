import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_VISIBLE, cameraMoved, horizonTest, WGS84_RADII, type Vec3 } from './horizon.js';

const R = WGS84_RADII.x;
const onSurface = (latDeg: number, lonDeg: number, altitudeM = 0): Vec3 => {
  // Spherical is close enough for which side of the horizon a point is on.
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const r = R + altitudeM;
  return { x: r * Math.cos(lat) * Math.cos(lon), y: r * Math.cos(lat) * Math.sin(lon), z: r * Math.sin(lat) };
};

test('horizon: the near side is seen, the far side is not, and the edge is where geometry says', () => {
  // A camera three Earth radii out over 0°, 0°: the horizon is acos(1/3) ≈ 70.5° away.
  const visible = horizonTest({ x: 3 * R, y: 0, z: 0 });
  assert.equal(visible(onSurface(0, 0)), true, 'straight below');
  assert.equal(visible(onSurface(0, 60)), true, 'well inside the horizon');
  assert.equal(visible(onSurface(0, 69)), true, 'just inside');
  assert.equal(visible(onSurface(0, 72)), false, 'just past it');
  assert.equal(visible(onSurface(0, 180)), false, 'the far side of the planet');
  assert.equal(visible(onSurface(-40, -100)), false);
});

test('horizon: a satellite above the limb is seen; one behind the Earth is not', () => {
  const visible = horizonTest({ x: 3 * R, y: 0, z: 0 });
  assert.equal(visible(onSurface(0, 90, R)), true, 'high over a point beyond the horizon, but clear of the disc');
  assert.equal(visible(onSurface(0, 180, R)), false, 'directly behind the Earth');
  assert.equal(visible(onSurface(0, 100, 35_786_000)), true, 'a geostationary satellite off to the side');
});

test('horizon: a camera below the surface has no horizon; camera movement has a tolerance', () => {
  assert.equal(horizonTest({ x: R * 0.5, y: 0, z: 0 }), ALWAYS_VISIBLE);
  assert.equal(cameraMoved(undefined, { x: 1, y: 2, z: 3 }), true);
  assert.equal(cameraMoved({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }), false);
  assert.equal(cameraMoved({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }), true);
});
