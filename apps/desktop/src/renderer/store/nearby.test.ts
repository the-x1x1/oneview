import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardBounds, nearbyOrder } from './nearby.js';

const o = (id: string, latitude: number, longitude: number) => ({ id, position: { latitude, longitude } });

test('the keyboard meets objects in view nearest the middle first', () => {
  const objects = [
    o('far', 21.9, -157.9),
    o('near', 21.31, -157.86),
    o('mid', 21.5, -157.9),
    { id: 'nowhere' },
    o('outside', 30, -150),
  ];
  const bounds = { west: -158.5, south: 20.8, east: -157.2, north: 22 };
  assert.deepEqual(nearbyOrder(objects, { latitude: 21.3, longitude: -157.85 }, bounds), ['near', 'mid', 'far']);
  assert.deepEqual(
    nearbyOrder(objects, { latitude: 21.3, longitude: -157.85 }, undefined).at(-1),
    'outside',
    'no bounds: all',
  );
  // A view across the antimeridian (west > east) holds both sides of 180°.
  const fiji = [o('east', -17, 179.9), o('west', -17, -179.9), o('away', -17, 170)];
  assert.deepEqual(
    nearbyOrder(fiji, { latitude: -17, longitude: 180 }, { west: 179, south: -18, east: -179, north: -16 }).sort(),
    ['east', 'west'],
  );
});

test("the flat map's bounds clamped at 180° are rebuilt round its unwrapped centre", () => {
  const b = { west: 170, south: -20, east: 180, north: -14 };
  // Dragged east past 180°: the centre reads 185°, the view runs 170°..200° (−160°).
  assert.deepEqual(keyboardBounds({ latitude: -17, longitude: 185 }, b), {
    west: 170,
    south: -20,
    east: -160,
    north: -14,
  });
  // Not clamped: as given.
  const plain = { west: -158.5, south: 20.8, east: -157.2, north: 22 };
  assert.equal(keyboardBounds({ latitude: 21.3, longitude: -157.85 }, plain), plain);
  // Clamped both sides: the whole width of the world.
  assert.deepEqual(keyboardBounds({ latitude: 0, longitude: 0 }, { west: -180, south: -80, east: 180, north: 80 }), {
    west: -180,
    south: -80,
    east: 180,
    north: 80,
  });
  const fiji = [o('east', -17, 179.9), o('west', -17, -175), o('away', -17, 150)];
  assert.deepEqual(
    nearbyOrder(fiji, { latitude: -17, longitude: 185 }, keyboardBounds({ latitude: -17, longitude: 185 }, b)).sort(),
    ['east', 'west'],
  );
});
