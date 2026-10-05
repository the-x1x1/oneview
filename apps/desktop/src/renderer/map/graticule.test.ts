import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RenderFeature, ViewState } from '@worldview/render-core';
import { GRATICULE_LAYER, formatGridLabel, graticuleExtent, graticuleFeatures, graticuleSpacing } from './graticule.js';

const view = (bounds: ViewState['bounds'], center = { latitude: 0, longitude: 0 }): ViewState => ({
  center,
  altitudeM: 1,
  zoom: 1,
  headingDegrees: 0,
  pitchDegrees: -90,
  ...(bounds ? { bounds } : {}),
});
const lines = (fs: RenderFeature[]) => fs.filter((f) => f.geometry.kind === 'line');
const labels = (fs: RenderFeature[]) => fs.filter((f) => f.geometry.kind === 'point').map((f) => f.style.label);

test('spacing: about a dozen lines across whatever the view spans', () => {
  assert.equal(graticuleSpacing(360), 30);
  assert.equal(graticuleSpacing(100), 10);
  assert.equal(graticuleSpacing(40), 5);
  assert.equal(graticuleSpacing(3), 0.25);
  assert.equal(graticuleSpacing(0.02), 0.005, 'no finer than the last step');
  assert.equal(graticuleSpacing(10_000), 30, 'no wider than the first');
});

test('labels: hemisphere letters, no letter on the equator, the prime meridian or 180°, decimals as the spacing needs', () => {
  assert.equal(formatGridLabel(30, 'lat', 10), '30°N');
  assert.equal(formatGridLabel(-60, 'lat', 30), '60°S');
  assert.equal(formatGridLabel(0, 'lat', 10), '0°');
  assert.equal(formatGridLabel(-150, 'lon', 30), '150°W');
  assert.equal(formatGridLabel(-180, 'lon', 30), '180°');
  assert.equal(formatGridLabel(21.25, 'lat', 0.25), '21.25°N');
  assert.equal(formatGridLabel(-157.5, 'lon', 0.5), '157.5°W');
  assert.equal(formatGridLabel(2e-7, 'lat', 0.1), '0.0°', 'float noise is not a hemisphere');
  assert.equal(formatGridLabel(-0.005, 'lat', 0.005), '0.005°S');
});

test('the whole world: twelve meridians, parallels from 60°S to 60°N as whole circles, every line on the grid layer', () => {
  const e = graticuleExtent(view({ west: -180, south: -90, east: 180, north: 90 }))!;
  assert.equal(e.spacing, 30);
  const fs = graticuleFeatures(e);
  assert.ok(fs.every((f) => f.layer === GRATICULE_LAYER && !f.interactive));
  const meridians = lines(fs).filter((f) => f.id.startsWith('graticule:lon:'));
  const parallels = lines(fs).filter((f) => f.id.startsWith('graticule:lat:'));
  assert.equal(meridians.length, 12);
  assert.deepEqual(
    parallels.map((f) => f.id),
    ['60°S', '30°S', '0°', '30°N', '60°N'].map((n) => `graticule:lat:${n}`),
  );
  const equator = parallels.find((f) => f.id === 'graticule:lat:0°')!.geometry;
  assert.ok(equator.kind === 'line');
  if (equator.kind !== 'line') return;
  assert.equal(equator.positions[0]!.longitude, -180);
  assert.equal(equator.positions.at(-1)!.longitude, 180, 'round to where it began, without a jump');
  assert.ok(equator.positions.length > 100, 'densified so it curves on the globe');
  assert.ok(labels(fs).includes('180°') && labels(fs).includes('0°') && labels(fs).includes('30°N'));
  // One label per line.
  assert.equal(labels(fs).length, 12 + 5);
});

test('a regional view: finer lines over just what is seen, labels near its middle', () => {
  const e = graticuleExtent(
    view({ west: -160.5, south: 18.6, east: -154.5, north: 22.4 }, { latitude: 20.5, longitude: -157.4 }),
  )!;
  assert.equal(e.spacing, 0.5);
  const fs = graticuleFeatures(e);
  const parallels = lines(fs).filter((f) => f.id.startsWith('graticule:lat:'));
  assert.equal(parallels[0]!.id, 'graticule:lat:18.5°N');
  assert.equal(parallels.at(-1)!.id, 'graticule:lat:22.5°N');
  const latLabel = fs.find((f) => f.id === 'graticule:label:lat:21.0°N')!;
  assert.ok(latLabel.geometry.kind === 'point');
  if (latLabel.geometry.kind === 'point')
    assert.equal(latLabel.geometry.position.longitude, -157.5, 'on the meridian nearest the middle');
  const lonLabel = fs.find((f) => f.id === 'graticule:label:lon:157.5°W')!;
  if (lonLabel.geometry.kind === 'point')
    assert.equal(lonLabel.geometry.position.latitude, 20.75, 'halfway to the next parallel');
});

test('a view across 180°: lines either side, cut at the antimeridian, named by where they are', () => {
  const e = graticuleExtent(
    view({ west: 170, south: -25, east: -170, north: -10 }, { latitude: -17.8, longitude: 178.6 }),
  )!;
  assert.equal(e.spacing, 2);
  const fs = graticuleFeatures(e);
  const ids = lines(fs).map((f) => f.id);
  assert.ok(
    ids.includes('graticule:lon:178°E') && ids.includes('graticule:lon:180°') && ids.includes('graticule:lon:178°W'),
  );
  // A parallel crossing 180° comes in two pieces, neither jumping across the map.
  const pieces = lines(fs).filter((f) => f.id.startsWith('graticule:lat:18°S'));
  assert.equal(pieces.length, 2);
  for (const p of pieces) {
    if (p.geometry.kind !== 'line') continue;
    for (let i = 1; i < p.geometry.positions.length; i++)
      assert.ok(Math.abs(p.geometry.positions[i]!.longitude - p.geometry.positions[i - 1]!.longitude) < 180);
  }
});

test('no bounds from the renderer: no grid; the same extent twice is the same grid', () => {
  assert.equal(graticuleExtent(view(undefined)), undefined);
  const a = graticuleExtent(view({ west: 0.1, south: 0.2, east: 40.3, north: 29.8 }))!;
  const b = graticuleExtent(view({ west: 0.4, south: 0.4, east: 40.6, north: 29.6 }))!;
  assert.deepEqual(a, b, 'a camera nudge does not redraw the grid');
  // Never nearer the poles than 85°.
  const polar = graticuleExtent(view({ west: -180, south: 60, east: 180, north: 90 }, { latitude: 80, longitude: 0 }))!;
  const fs = graticuleFeatures(polar);
  for (const f of lines(fs))
    if (f.geometry.kind === 'line') for (const p of f.geometry.positions) assert.ok(Math.abs(p.latitude) <= 85);
});
