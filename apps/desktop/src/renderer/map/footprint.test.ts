import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '@worldview/world-model';
import { FOOTPRINT_LAYER, footprintAngleDeg, footprintFeatures, footprintRing } from './footprint.js';

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test('footprint angle: the ISS and a geostationary satellite, at the horizon and 10° up', () => {
  // ISS at 420 km: the horizon is acos(R / (R + h)) = 20.26° of arc away (2,252 km); 10° up,
  // acos(R cos 10° / (R + h)) − 10° = 12.50°.
  near(footprintAngleDeg(420_000, 0)!, 20.256, 0.001, 'ISS horizon');
  near(footprintAngleDeg(420_000, 10)!, 12.497, 0.001, 'ISS 10°');
  // Geostationary, 35,786 km: 81.31° and 71.44° — most of a hemisphere.
  near(footprintAngleDeg(35_786_000, 0)!, 81.308, 0.001, 'GEO horizon');
  near(footprintAngleDeg(35_786_000, 10)!, 71.441, 0.001, 'GEO 10°');
  assert.equal(footprintAngleDeg(0, 0), undefined, 'on the ground: none');
  assert.equal(footprintAngleDeg(Number.NaN, 0), undefined);
});

test('footprint ring: every point the same distance from the point beneath', () => {
  const center = { latitude: 51.6, longitude: -0.1 };
  const ring = footprintRing(center, 12.5);
  assert.ok(Math.abs(ring[0]!.latitude - ring.at(-1)!.latitude) < 1e-9, 'closed');
  assert.ok(Math.abs(ring[0]!.longitude - ring.at(-1)!.longitude) < 1e-9);
  for (const p of ring) near(haversineMeters(center, p) / 1000, 12.5 * 111.195, 1, 'radius');
});

test('footprint features: two rings and their names, on their own layer, cut at 180° and round a pole', () => {
  const iss = { latitude: 10, longitude: 0, altitudeM: 420_000 };
  const fs = footprintFeatures(iss);
  assert.ok(fs.every((f) => f.layer === FOOTPRINT_LAYER && f.interactive === false));
  const lines = fs.filter((f) => f.geometry.kind === 'line');
  assert.deepEqual(
    lines.map((f) => f.id),
    ['footprint:0', 'footprint:10'],
  );
  assert.equal(lines[0]!.style.lineStyle, 'dashed', 'the horizon is the fainter, dashed ring');
  const labels = fs.filter((f) => f.geometry.kind === 'point').map((f) => f.style.label);
  assert.deepEqual(labels, ['horizon', '10° up']);
  // Over Fiji the rings cross 180°: each comes in pieces that never jump across the map.
  const fiji = footprintFeatures({ latitude: -17, longitude: 179, altitudeM: 420_000 }).filter(
    (f) => f.geometry.kind === 'line',
  );
  assert.ok(fiji.length > 2);
  for (const f of fiji)
    if (f.geometry.kind === 'line')
      for (let i = 1; i < f.geometry.positions.length; i++)
        assert.ok(Math.abs(f.geometry.positions[i]!.longitude - f.geometry.positions[i - 1]!.longitude) < 180);
  // Near the North Pole the label goes on the ring's south side, which exists.
  const polar = footprintFeatures({ latitude: 80, longitude: 30, altitudeM: 800_000 });
  const label = polar.find((f) => f.id === 'footprint:label:0')!;
  assert.ok(label.geometry.kind === 'point' && label.geometry.position.latitude < 80);
  assert.equal(footprintFeatures({ latitude: 0, longitude: 0 }).length, 0, 'no altitude: no footprint');
});
