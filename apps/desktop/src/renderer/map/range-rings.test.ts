import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '@worldview/world-model';
import type { ViewState } from '@worldview/render-core';
import { RANGE_RINGS_LAYER, RANGE_RING_COUNT, rangeRingFeatures, ringSpacingM } from './range-rings.js';

const view = (bounds: ViewState['bounds']): ViewState => ({
  center: { latitude: 0, longitude: 0 },
  altitudeM: 1,
  zoom: 1,
  headingDegrees: 0,
  pitchDegrees: -90,
  ...(bounds ? { bounds } : {}),
});

test('spacing: a round step so the outer ring spans between a fifth and about half of the view', () => {
  // About 1,100 km tall, 800 km wide round the equator: rings every 50 km, out to 200 km.
  assert.equal(ringSpacingM(view({ west: -3.6, south: -5, east: 3.6, north: 5 })), 50_000);
  // A city: 20 km across.
  assert.equal(ringSpacingM(view({ west: -157.95, south: 21.25, east: -157.75, north: 21.4 })), 1_000);
  // The whole Earth: the widest step.
  assert.equal(ringSpacingM(view({ west: -180, south: -85, east: 180, north: 85 })), 1_000_000);
  // Across 180°.
  assert.equal(ringSpacingM(view({ west: 175, south: -20, east: -175, north: -12 })), 50_000);
  assert.equal(ringSpacingM(view(undefined)), undefined, 'nothing until the renderer says what the view shows');
  for (const b of [
    { west: 0, south: 0, east: 1, north: 1 },
    { west: 0, south: 40, east: 30, north: 60 },
  ]) {
    const s = ringSpacingM(view(b))!;
    const side = Math.min(
      (b.east - b.west) * 111_320 * Math.cos(((b.north + b.south) / 2) * (Math.PI / 180)),
      (b.north - b.south) * 111_320,
    );
    const outer = s * RANGE_RING_COUNT;
    assert.ok(outer >= side / 5 && outer <= side * 0.75, `outer ${outer} m for a ${Math.round(side)} m view`);
  }
});

test('the rings: four circles a spacing apart, each named at its top, on their own layer', () => {
  const center = { latitude: 21.3, longitude: -157.85, altitudeM: 9000 };
  const fs = rangeRingFeatures(center, 50_000);
  assert.ok(fs.every((f) => f.layer === RANGE_RINGS_LAYER && !f.interactive));
  const circles = fs.filter((f) => f.geometry.kind === 'circle');
  assert.deepEqual(
    circles.map((f) => (f.geometry.kind === 'circle' ? f.geometry.radiusM : 0)),
    [50_000, 100_000, 150_000, 200_000],
  );
  assert.deepEqual(circles[0]!.geometry.kind === 'circle' ? circles[0]!.geometry.center : null, {
    latitude: 21.3,
    longitude: -157.85,
  });
  const labels = fs.filter((f) => f.geometry.kind === 'point');
  assert.deepEqual(
    labels.map((f) => f.style.label),
    ['50.0 km', '100 km', '150 km', '200 km'],
  );
  const top = labels[1]!.geometry;
  assert.ok(top.kind === 'point');
  if (top.kind !== 'point') return;
  assert.equal(top.position.longitude, -157.85, 'due north');
  assert.ok(Math.abs(haversineMeters(center, top.position) - 100_000) < 1, 'on the ring');
  // Near a pole the label stops at the pole.
  const polar = rangeRingFeatures({ latitude: 89.5, longitude: 0 }, 100_000).find(
    (f) => f.id === 'range-ring:label:4',
  )!;
  assert.ok(polar.geometry.kind === 'point' && polar.geometry.position.latitude === 90);
});
