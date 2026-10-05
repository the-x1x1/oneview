import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearbyOrder } from './nearby.js';

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
