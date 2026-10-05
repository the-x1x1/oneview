import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subsolarPoint } from '@worldview/world-model';
import { SKY_POINTS_LAYER, skyPointFeatures } from './sky-points.js';

test('day and night: where the Sun and the Moon stand overhead, named, never pick targets', () => {
  const at = Date.parse('2026-10-05T00:00:00Z');
  const [sun, moon] = skyPointFeatures(at);
  assert.equal(sun!.id, 'sky:sun');
  assert.deepEqual(sun!.geometry, { kind: 'point', position: subsolarPoint(at) });
  assert.equal(sun!.style.label, 'Sun overhead');
  // Astronomy Engine (GeoMoon → equator of date, less sidereal time; run outside the repo):
  // 22.419° N, 109.735° E. The low-precision series is within a few hundredths of a degree here.
  assert.equal(moon!.id, 'sky:moon');
  const p = (moon!.geometry as { position: { latitude: number; longitude: number } }).position;
  assert.ok(Math.abs(p.latitude - 22.419) < 0.1 && Math.abs(p.longitude - 109.735) < 0.15, JSON.stringify(p));
  assert.equal(moon!.style.label, 'Moon overhead · 34% lit');
  for (const f of [sun!, moon!]) {
    assert.equal(f.layer, SKY_POINTS_LAYER);
    assert.equal(f.interactive, false);
  }
});
