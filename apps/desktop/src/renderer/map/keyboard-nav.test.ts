import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewState } from '@worldview/render-core';
import { haversineMeters } from '@worldview/world-model';
import { globeKeyView, MAX_ALTITUDE_M, MAX_PITCH_DEG, MIN_ALTITUDE_M } from './keyboard-nav.js';

const view = (over: Partial<ViewState> = {}): ViewState => ({
  center: { latitude: 21.3, longitude: -157.85 },
  altitudeM: 100_000,
  zoom: 8,
  headingDegrees: 0,
  pitchDegrees: -90,
  ...over,
});
const key = (
  k: string,
  shiftKey = false,
  extra: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {},
) => ({
  key: k,
  shiftKey,
  ...extra,
});

test('arrows move the view a fifth of its height towards that side of the screen', () => {
  const up = globeKeyView(view(), key('ArrowUp'))!;
  assert.ok(up.center!.latitude > 21.3 && Math.abs(up.center!.longitude + 157.85) < 1e-9, 'north, facing north');
  assert.ok(Math.abs(haversineMeters(view().center, up.center!) - 20_000) < 1, '20 km from 100 km up');
  const right = globeKeyView(view(), key('ArrowRight'))!;
  assert.ok(right.center!.longitude > -157.85, 'east');
  assert.equal(Object.keys(up).join(), 'center', 'height, heading and tilt kept');
  // Facing east, up the screen is east.
  const facingEast = globeKeyView(view({ headingDegrees: 90 }), key('ArrowUp'))!;
  assert.ok(facingEast.center!.longitude > -157.85 && Math.abs(facingEast.center!.latitude - 21.3) < 0.01);
  // Across the antimeridian, and never past the pole.
  const west = globeKeyView(view({ center: { latitude: 0, longitude: -179.9 } }), key('ArrowLeft'))!;
  assert.ok(west.center!.longitude > 179);
  const north = globeKeyView(view({ center: { latitude: 88.9, longitude: 0 }, altitudeM: 5_000_000 }), key('ArrowUp'))!;
  assert.ok(north.center!.latitude <= 89);
});

test('+ and − halve and double the height, within limits; Shift turns and tilts', () => {
  assert.deepEqual(globeKeyView(view(), key('+')), { altitudeM: 50_000 });
  assert.deepEqual(globeKeyView(view(), key('=')), { altitudeM: 50_000 }, '= is + without Shift');
  assert.deepEqual(globeKeyView(view(), key('-')), { altitudeM: 200_000 });
  assert.deepEqual(globeKeyView(view({ altitudeM: 150 }), key('+')), { altitudeM: MIN_ALTITUDE_M });
  assert.deepEqual(globeKeyView(view({ altitudeM: 30_000_000 }), key('-')), { altitudeM: MAX_ALTITUDE_M });
  assert.deepEqual(globeKeyView(view({ headingDegrees: 350 }), key('ArrowRight', true)), { headingDegrees: 5 });
  assert.deepEqual(globeKeyView(view(), key('ArrowLeft', true)), { headingDegrees: 345 });
  assert.deepEqual(globeKeyView(view(), key('ArrowUp', true)), { pitchDegrees: -80 });
  assert.deepEqual(globeKeyView(view({ pitchDegrees: -20 }), key('ArrowUp', true)), { pitchDegrees: MAX_PITCH_DEG });
  assert.deepEqual(
    globeKeyView(view(), key('ArrowDown', true)),
    { pitchDegrees: -90 },
    'no further than straight down',
  );
});

test('other keys, and keys with Ctrl, Alt or Cmd, are left alone', () => {
  assert.equal(globeKeyView(view(), key('h')), null);
  assert.equal(globeKeyView(view(), key('Enter')), null);
  assert.equal(globeKeyView(view(), key('ArrowUp', false, { ctrlKey: true })), null);
  assert.equal(globeKeyView(view(), key('+', false, { metaKey: true })), null, 'Cmd/Ctrl + is the window zoom');
  assert.equal(globeKeyView(view(), key('-', false, { altKey: true })), null);
});
