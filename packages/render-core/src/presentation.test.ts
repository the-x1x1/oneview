import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentObjects, lodBand, diffFeatures, zoomToAltitudeM, altitudeToZoom, BUILT_IN_LENSES, type RenderFeature } from './index.js';
import type { WorldObject } from '@worldview/world-model';

function obj(id: string, type: string, lat: number, lon: number, props: Record<string, number | string> = {}): WorldObject {
  const o: WorldObject = { id, type, sourceRefs: [{ observationId: id, providerId: 'p', observedAt: '2026-09-21T00:00:00.000Z' }], position: { latitude: lat, longitude: lon }, observedAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z', freshness: 'LIVE', confidence: 0.9, labels: {}, properties: props, provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: '2026-09-21T00:00:00.000Z' } };
  if (typeof props['headingDegrees'] === 'number') o.motion = { headingDegrees: props['headingDegrees'] };
  return o;
}

test('lod bands and zoom/altitude round trip', () => {
  assert.equal(lodBand(1), 'global');
  assert.equal(lodBand(4), 'continental');
  assert.equal(lodBand(8), 'regional');
  assert.equal(lodBand(12), 'local');
  const z = 8;
  assert.ok(Math.abs(altitudeToZoom(zoomToAltitudeM(z)) - z) < 0.01);
});

test('presentation: aircraft aggregate to density at global zoom, icons when local, earthquakes sized by magnitude', () => {
  const objects: WorldObject[] = [];
  for (let i = 0; i < 500; i++) objects.push(obj(`aircraft:icao24:${i.toString(16).padStart(6, '0')}`, 'aircraft', 20 + (i % 10) * 0.01, -157 + Math.floor(i / 10) * 0.01, { headingDegrees: 90 }));
  objects.push(obj('earthquake:usgs:a', 'earthquake', 19.4, -155.3, { magnitude: 6.5, depthKm: 10 }));
  objects.push(obj('earthquake:usgs:b', 'earthquake', 38.4, 142.1, { magnitude: 2.0, depthKm: 400 }));

  const global = presentObjects({ objects, view: { center: { latitude: 20, longitude: -157 }, altitudeM: 20_000_000, zoom: 1, headingDegrees: 0, pitchDegrees: -90, bounds: { west: -180, south: -90, east: 180, north: 90 } } });
  assert.ok(global.stats.density >= 1, 'aircraft aggregated into density cells');
  assert.ok(!global.upsert.some((f) => f.objectId?.startsWith('aircraft')), 'no per-aircraft features at global zoom');
  const eqA = global.upsert.find((f) => f.objectId === 'earthquake:usgs:a')!;
  const eqB = global.upsert.find((f) => f.objectId === 'earthquake:usgs:b')!;
  assert.equal(eqA.style.styleClass, 'earthquake.shallow');
  assert.equal(eqB.style.styleClass, 'earthquake.deep');
  assert.ok((eqA.style.size ?? 0) > (eqB.style.size ?? 0));

  const local = presentObjects({ objects, view: { center: { latitude: 20.05, longitude: -156.75 }, altitudeM: 5000, zoom: 13, headingDegrees: 0, pitchDegrees: -90, bounds: { west: -157.2, south: 19.9, east: -156.4, north: 20.2 } }, selectedId: 'aircraft:icao24:000001', selectedTrack: [{ latitude: 20, longitude: -157 }, { latitude: 20.01, longitude: -157 }] });
  const icons = local.upsert.filter((f) => f.style.icon === 'aircraft');
  assert.equal(icons.length, 500, 'all aircraft as icons when local');
  assert.equal(icons[0]!.style.rotationDegrees, 90);
  const selected = local.upsert.find((f) => f.objectId === 'aircraft:icao24:000001')!;
  assert.equal(selected.style.selected, true);
  assert.ok(selected.priority > icons.find((f) => !f.style.selected)!.priority);
  assert.ok(local.upsert.some((f) => f.id === 'trail:aircraft:icao24:000001'));
  assert.equal(local.stats.hidden, 2, 'earthquakes outside the view are culled');
});

test('presentation: clustering at continental zoom and lens visibility', () => {
  const objects: WorldObject[] = [];
  for (let i = 0; i < 200; i++) objects.push(obj(`vessel:mmsi:${100000000 + i}`, 'vessel', 21 + (i % 20) * 0.001, -158 + Math.floor(i / 20) * 0.001));
  const r = presentObjects({ objects, view: { center: { latitude: 21, longitude: -158 }, altitudeM: 1_000_000, zoom: 4.5, headingDegrees: 0, pitchDegrees: -90, bounds: { west: -170, south: 10, east: -150, north: 30 } } });
  const clusters = r.upsert.filter((f) => f.geometry.kind === 'cluster');
  assert.ok(clusters.length >= 1 && clusters.length < 200, `clusters=${clusters.length}`);
  assert.equal(r.stats.clustered + r.upsert.filter((f) => f.objectId).length, 200);
  const hidden = presentObjects({ objects, view: r.stats && { center: { latitude: 21, longitude: -158 }, altitudeM: 1_000_000, zoom: 4.5, headingDegrees: 0, pitchDegrees: -90 }, visibleTypes: new Set(['aircraft']) });
  assert.equal(hidden.upsert.length, 0);
  assert.equal(hidden.stats.hidden, 200);
  assert.ok(BUILT_IN_LENSES.find((l) => l.id === 'aviation')!.objectTypes.includes('aircraft'));
});

test('diffFeatures emits only changes', () => {
  const a: RenderFeature = { id: 'x', geometry: { kind: 'point', position: { latitude: 1, longitude: 1 } }, style: { styleClass: 's' }, interactive: true, priority: 1, layer: 'l' };
  const prev = new Map([[a.id, a], ['gone', { ...a, id: 'gone' }]]);
  const d = diffFeatures(prev, [a, { ...a, id: 'new' }, { ...a, id: 'x', style: { styleClass: 's', selected: true } }]);
  assert.deepEqual(d.remove, ['gone']);
  assert.deepEqual(d.upsert.map((f) => f.id).sort(), ['new', 'x']);
});

test('diffFeatures: steady state, removals, additions and repeated ids', () => {
  const f = (id: string, lat: number, over: Partial<RenderFeature> = {}): RenderFeature => ({
    id, geometry: { kind: 'point', position: { latitude: lat, longitude: 0 } }, style: { styleClass: 's' }, interactive: true, priority: 1, layer: 'l', ...over,
  });
  // Steady state: same ids, some moved → only the moved ones are upserted, nothing removed.
  const previous = new Map([['a', f('a', 1)], ['b', f('b', 2)], ['c', f('c', 3)]]);
  const steady = diffFeatures(previous, [f('a', 1), f('b', 2.5), f('c', 3)]);
  assert.deepEqual(steady.upsert.map((x) => x.id), ['b']);
  assert.deepEqual(steady.remove, []);
  assert.equal(steady.index.size, 3, 'the diff hands back the frame index');

  // Removal and addition in one frame.
  const churn = diffFeatures(previous, [f('a', 1), f('d', 9)]);
  assert.deepEqual(churn.upsert.map((x) => x.id), ['d']);
  assert.deepEqual(churn.remove.sort(), ['b', 'c']);

  // A repeated id must not hide a removal (the last occurrence wins, like a map build).
  const repeated = diffFeatures(previous, [f('a', 1), f('a', 1), f('b', 2)]);
  assert.deepEqual(repeated.remove, ['c']);
  assert.equal(repeated.index.get('a')!.geometry.kind, 'point');

  // Structural comparison covers style and geometry fields, not object identity.
  assert.equal(diffFeatures(previous, [f('a', 1), f('b', 2), f('c', 3)]).upsert.length, 0);
  assert.equal(diffFeatures(previous, [f('a', 1, { style: { styleClass: 's', selected: true } }), f('b', 2), f('c', 3)]).upsert.length, 1);
  assert.equal(diffFeatures(previous, [f('a', 1, { priority: 5 }), f('b', 2), f('c', 3)]).upsert.length, 1);
  assert.equal(diffFeatures(previous, [f('a', 1, { geometry: { kind: 'circle', center: { latitude: 1, longitude: 0 }, radiusM: 10 } }), f('b', 2), f('c', 3)]).upsert.length, 1);

  // An empty frame removes everything; an empty previous upserts everything.
  assert.deepEqual(diffFeatures(previous, []).remove.sort(), ['a', 'b', 'c']);
  assert.equal(diffFeatures(new Map(), [f('a', 1)]).upsert.length, 1);
});
