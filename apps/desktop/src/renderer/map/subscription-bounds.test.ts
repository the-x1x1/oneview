import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundsContain, isValidBounds } from '@worldview/world-model';
import { BOUNDED_SUBSCRIPTION_MIN_ZOOM, containsBounds, nextSubscriptionBounds } from './subscription-bounds.js';

const view = (west: number, south: number, east: number, north: number, zoom = 8) => ({
  bounds: { west, south, east, north },
  zoom,
});

test('subscription bounds: the whole world below the regional band, however the camera moves', () => {
  // Rotating or zooming a globe-wide view changes its bounds every frame. None of that may
  // change the subscription: every new one is a full snapshot and a replaced mirror.
  for (const zoom of [0, 1, 2.9, 3, 4.5, BOUNDED_SUBSCRIPTION_MIN_ZOOM - 0.01])
    assert.equal(nextSubscriptionBounds(undefined, view(-90, -60, 90, 60, zoom)), undefined, `zoom ${zoom}`);
  assert.equal(nextSubscriptionBounds(undefined, { zoom: 12 }), undefined, 'no bounds to go by');
});

test('subscription bounds: a pan or zoom inside the current subscription keeps it — the same object', () => {
  const first = nextSubscriptionBounds(undefined, view(-158, 19, -155, 22))!;
  assert.ok(first.west < -158 && first.east > -155 && first.south < 19 && first.north > 22, 'padded past the view');
  assert.equal(nextSubscriptionBounds(first, view(-157.5, 19.5, -154.5, 22.5)), first, 'small pan');
  assert.equal(nextSubscriptionBounds(first, view(-157, 20, -156, 21, 10)), first, 'zoomed in a little');
  const moved = nextSubscriptionBounds(first, view(-150, 19, -147, 22))!;
  assert.notEqual(moved, first, 'a pan out of it asks for the new region');
  assert.ok(moved.west < -150 && moved.east > -147);
  // Zoomed far in, a continent-sized subscription is narrowed.
  const wide = nextSubscriptionBounds(undefined, view(-130, 20, -60, 55, 6))!;
  assert.notEqual(nextSubscriptionBounds(wide, view(-100, 40, -99, 41, 12)), wide);
});

test('subscription bounds: across the antimeridian and at the poles', () => {
  const fiji = nextSubscriptionBounds(undefined, view(176, -20, -178, -15))!;
  assert.ok(isValidBounds(fiji), JSON.stringify(fiji));
  assert.ok(fiji.west > fiji.east, 'still a box that crosses 180°');
  for (const lon of [177, 179.9, -179.9, -178.5])
    assert.ok(boundsContain(fiji, { latitude: -17, longitude: lon }), `${lon}`);
  assert.equal(nextSubscriptionBounds(fiji, view(178, -19, -179, -16)), fiji, 'a pan over the line stays inside');
  // A view padded past the whole width is the full width, not a wrapped sliver.
  const wideView = nextSubscriptionBounds(undefined, view(-170, 60, 170, 85))!;
  assert.deepEqual([wideView.west, wideView.east], [-180, 180]);
  assert.equal(wideView.north, 90);
  assert.ok(
    containsBounds({ west: 170, east: -170, south: -10, north: 10 }, { west: 175, east: -175, south: -5, north: 5 }),
  );
  assert.ok(
    !containsBounds({ west: 170, east: -170, south: -10, north: 10 }, { west: 160, east: 175, south: -5, north: 5 }),
  );
});
