import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewState } from './contract.js';
import { destinationPoint } from './motion.js';
import { viewForMode } from './view-handover.js';

const base: ViewState = {
  center: { latitude: 32.164, longitude: 131.329 },
  altitudeM: 255_000,
  zoom: 7,
  headingDegrees: 0,
  pitchDegrees: -69,
};

test('2D to 3D: the camera goes behind the middle of the 2D view, so the globe looks at it', () => {
  const v = viewForMode(base, '3D');
  // Heading north, tilted 21° from straight down: the camera sits south of the middle.
  assert.ok(v.center.latitude < base.center.latitude);
  assert.deepEqual(v.focus, base.center);
  const groundM = base.altitudeM / Math.tan((69 * Math.PI) / 180);
  const ahead = destinationPoint(v.center, base.headingDegrees, groundM);
  assert.ok(Math.abs(ahead.latitude - base.center.latitude) < 1e-6);
  assert.ok(Math.abs(ahead.longitude - base.center.longitude) < 1e-6);
});

test('3D to 2D: the 2D map centres on the ground the globe was looking at', () => {
  const globe: ViewState = { ...base, center: { latitude: 31.8, longitude: 131.33 }, focus: base.center };
  const v = viewForMode(globe, '2D');
  assert.deepEqual(v.center, base.center);
  assert.equal(v.focus, undefined);
});

test('the round trip keeps the middle of the screen, and straight down changes nothing', () => {
  const there = viewForMode(base, '3D');
  assert.deepEqual(viewForMode(there, '2D').center, base.center);
  const down = { ...base, pitchDegrees: -90 };
  assert.deepEqual(viewForMode(down, '3D'), down);
  const noFocus = { ...base };
  assert.equal(viewForMode(noFocus, '2D'), noFocus, 'nothing to correct: the same view');
});
