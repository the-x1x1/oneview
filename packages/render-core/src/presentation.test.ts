import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  presentObjects,
  lodBand,
  diffFeatures,
  zoomToAltitudeM,
  altitudeToZoom,
  BUILT_IN_LENSES,
  DEFAULT_RULES,
  restyleHover,
  type RenderFeature,
} from './index.js';
import type { WorldObject } from '@worldview/world-model';

function obj(
  id: string,
  type: string,
  lat: number,
  lon: number,
  props: Record<string, number | string> = {},
): WorldObject {
  const o: WorldObject = {
    id,
    type,
    sourceRefs: [{ observationId: id, providerId: 'p', observedAt: '2026-09-21T00:00:00.000Z' }],
    position: { latitude: lat, longitude: lon },
    observedAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    freshness: 'LIVE',
    confidence: 0.9,
    labels: {},
    properties: props,
    provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: '2026-09-21T00:00:00.000Z' },
  };
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

test('zoom/altitude follow the viewport: the same camera height is a lower zoom in a narrower window', () => {
  // A 584-pixel map showed Hawaii to California where the globe it replaced showed the whole
  // Earth: the conversion assumed 1,024 pixels whatever the window.
  const altitude = 25_000_000;
  const wide = altitudeToZoom(altitude, 20, 1024);
  const narrow = altitudeToZoom(altitude, 20, 584);
  assert.ok(Math.abs(wide - narrow - Math.log2(1024 / 584)) < 1e-9, `${wide} vs ${narrow}`);
  for (const px of [584, 1024, 1456]) {
    const z = altitudeToZoom(altitude, 20, px);
    assert.ok(Math.abs(zoomToAltitudeM(z, 20, px) - altitude) < 1, `round trip at ${px}px`);
  }
  assert.equal(altitudeToZoom(altitude, 20), wide, 'the default is still 1,024');
});

test('presentation: the overview draws every aircraft as its own point; icons when local; detail 2 never groups', () => {
  const objects: WorldObject[] = [];
  for (let i = 0; i < 500; i++)
    objects.push(
      obj(
        `aircraft:icao24:${i.toString(16).padStart(6, '0')}`,
        'aircraft',
        20 + (i % 10) * 0.01,
        -157 + Math.floor(i / 10) * 0.01,
        { headingDegrees: 90 },
      ),
    );
  objects.push(obj('earthquake:usgs:a', 'earthquake', 19.4, -155.3, { magnitude: 6.5, depthKm: 10 }));
  objects.push(obj('earthquake:usgs:b', 'earthquake', 38.4, 142.1, { magnitude: 2.0, depthKm: 400 }));

  const globalView = {
    center: { latitude: 20, longitude: -157 },
    altitudeM: 20_000_000,
    zoom: 1,
    headingDegrees: 0,
    pitchDegrees: -90,
    bounds: { west: -180, south: -90, east: 180, north: 90 },
  };
  const global = presentObjects({ objects, view: globalView });
  // The overview first replaced aircraft with a heatmap, then with counted cluster bubbles.
  // Both answer "roughly how many" and neither answers "where is each one", and the
  // operator's verdict on the bubbles was plain: every dot separate. A GPU point is cheap;
  // what made the map stutter was CPU work per camera frame, which is fixed elsewhere.
  assert.equal(global.stats.density, 0, 'no heatmap');
  assert.equal(global.stats.clustered, 0, 'no bubbles');
  const aircraftPoints = global.upsert.filter((f) => f.objectId?.startsWith('aircraft'));
  assert.equal(aircraftPoints.length, 500, 'five hundred aircraft, five hundred dots');
  assert.ok(aircraftPoints.every((f) => f.geometry.kind === 'point'));

  // Under pressure the governor makes each dot cheaper, and never fewer.
  const minimal = presentObjects({ objects, view: globalView, detail: 2 });
  assert.equal(minimal.stats.density, 0, 'the slowest machine still gets no heatmap');
  assert.equal(minimal.stats.clustered, 0);
  assert.equal(minimal.upsert.filter((f) => f.objectId?.startsWith('aircraft')).length, 500);

  const eqA = global.upsert.find((f) => f.objectId === 'earthquake:usgs:a')!;
  const eqB = global.upsert.find((f) => f.objectId === 'earthquake:usgs:b')!;
  assert.equal(eqA.style.styleClass, 'earthquake.shallow');
  assert.equal(eqB.style.styleClass, 'earthquake.deep');
  assert.ok((eqA.style.size ?? 0) > (eqB.style.size ?? 0));

  const local = presentObjects({
    objects,
    view: {
      center: { latitude: 20.05, longitude: -156.75 },
      altitudeM: 5000,
      zoom: 13,
      headingDegrees: 0,
      pitchDegrees: -90,
      bounds: { west: -157.2, south: 19.9, east: -156.4, north: 20.2 },
    },
    selectedId: 'aircraft:icao24:000001',
    selectedTrack: [
      { latitude: 20, longitude: -157 },
      { latitude: 20.01, longitude: -157 },
    ],
  });
  const icons = local.upsert.filter((f) => f.style.icon === 'aircraft');
  assert.equal(icons.length, 500, 'all aircraft as icons when local');
  assert.equal(icons[0]!.style.rotationDegrees, 90);
  const selected = local.upsert.find((f) => f.objectId === 'aircraft:icao24:000001')!;
  assert.equal(selected.style.selected, true);
  assert.ok(selected.priority > icons.find((f) => !f.style.selected)!.priority);
  assert.ok(local.upsert.some((f) => f.id === 'trail:aircraft:icao24:000001'));
  assert.equal(local.stats.hidden, 2, 'earthquakes outside the view are culled');
});

test('presentation: a tight crowd stays 200 separate points by default; clustering is opt-in; lens visibility', () => {
  const objects: WorldObject[] = [];
  for (let i = 0; i < 200; i++)
    objects.push(
      obj(`vessel:mmsi:${100000000 + i}`, 'vessel', 21 + (i % 20) * 0.001, -158 + Math.floor(i / 20) * 0.001),
    );
  const view = {
    center: { latitude: 21, longitude: -158 },
    altitudeM: 1_000_000,
    zoom: 4.5,
    headingDegrees: 0,
    pitchDegrees: -90,
    bounds: { west: -170, south: 10, east: -150, north: 30 },
  };
  // Two hundred vessels inside a few hundred metres, at continental zoom. They used to fold
  // into a count; the operator asked for every one to be its own dot.
  const r = presentObjects({ objects, view });
  assert.equal(r.stats.clustered, 0, 'nothing is grouped');
  assert.equal(r.upsert.filter((f) => f.geometry.kind === 'point').length, 200, 'every vessel is a point');

  // The clustering machinery is still there for a lens that genuinely wants it.
  const clusteringRules = DEFAULT_RULES.map((rule) =>
    rule.objectTypes.includes('vessel') ? { ...rule, clusterPx: 24 } : rule,
  );
  const opted = presentObjects({ objects, view, rules: clusteringRules });
  const clusters = opted.upsert.filter((f) => f.geometry.kind === 'cluster');
  assert.ok(clusters.length >= 1 && clusters.length < 200, `clusters=${clusters.length}`);
  assert.equal(opted.stats.clustered + opted.upsert.filter((f) => f.objectId).length, 200);
  const hidden = presentObjects({
    objects,
    view: r.stats && {
      center: { latitude: 21, longitude: -158 },
      altitudeM: 1_000_000,
      zoom: 4.5,
      headingDegrees: 0,
      pitchDegrees: -90,
    },
    visibleTypes: new Set(['aircraft']),
  });
  assert.equal(hidden.upsert.length, 0);
  assert.equal(hidden.stats.hidden, 200);
  assert.ok(BUILT_IN_LENSES.find((l) => l.id === 'aviation')!.objectTypes.includes('aircraft'));
});

test('diffFeatures emits only changes', () => {
  const a: RenderFeature = {
    id: 'x',
    geometry: { kind: 'point', position: { latitude: 1, longitude: 1 } },
    style: { styleClass: 's' },
    interactive: true,
    priority: 1,
    layer: 'l',
  };
  const prev = new Map([
    [a.id, a],
    ['gone', { ...a, id: 'gone' }],
  ]);
  const d = diffFeatures(prev, [a, { ...a, id: 'new' }, { ...a, id: 'x', style: { styleClass: 's', selected: true } }]);
  assert.deepEqual(d.remove, ['gone']);
  assert.deepEqual(d.upsert.map((f) => f.id).sort(), ['new', 'x']);
});

test('diffFeatures: steady state, removals, additions and repeated ids', () => {
  const f = (id: string, lat: number, over: Partial<RenderFeature> = {}): RenderFeature => ({
    id,
    geometry: { kind: 'point', position: { latitude: lat, longitude: 0 } },
    style: { styleClass: 's' },
    interactive: true,
    priority: 1,
    layer: 'l',
    ...over,
  });
  // Steady state: same ids, some moved → only the moved ones are upserted, nothing removed.
  const previous = new Map([
    ['a', f('a', 1)],
    ['b', f('b', 2)],
    ['c', f('c', 3)],
  ]);
  const steady = diffFeatures(previous, [f('a', 1), f('b', 2.5), f('c', 3)]);
  assert.deepEqual(
    steady.upsert.map((x) => x.id),
    ['b'],
  );
  assert.deepEqual(steady.remove, []);
  assert.equal(steady.index.size, 3, 'the diff hands back the frame index');

  // Removal and addition in one frame.
  const churn = diffFeatures(previous, [f('a', 1), f('d', 9)]);
  assert.deepEqual(
    churn.upsert.map((x) => x.id),
    ['d'],
  );
  assert.deepEqual(churn.remove.sort(), ['b', 'c']);

  // A repeated id must not hide a removal (the last occurrence wins, like a map build).
  const repeated = diffFeatures(previous, [f('a', 1), f('a', 1), f('b', 2)]);
  assert.deepEqual(repeated.remove, ['c']);
  assert.equal(repeated.index.get('a')!.geometry.kind, 'point');

  // Structural comparison covers style and geometry fields, not object identity.
  assert.equal(diffFeatures(previous, [f('a', 1), f('b', 2), f('c', 3)]).upsert.length, 0);
  assert.equal(
    diffFeatures(previous, [f('a', 1, { style: { styleClass: 's', selected: true } }), f('b', 2), f('c', 3)]).upsert
      .length,
    1,
  );
  assert.equal(diffFeatures(previous, [f('a', 1, { priority: 5 }), f('b', 2), f('c', 3)]).upsert.length, 1);
  assert.equal(
    diffFeatures(previous, [
      f('a', 1, { geometry: { kind: 'circle', center: { latitude: 1, longitude: 0 }, radiusM: 10 } }),
      f('b', 2),
      f('c', 3),
    ]).upsert.length,
    1,
  );

  // An empty frame removes everything; an empty previous upserts everything.
  assert.deepEqual(diffFeatures(previous, []).remove.sort(), ['a', 'b', 'c']);
  assert.equal(diffFeatures(new Map(), [f('a', 1)]).upsert.length, 1);
});

test('presentation: with cullToView off, what is drawn does not depend on where the camera is', () => {
  // Culling to the view in presentation made the visible set a function of the exact camera,
  // so every pan re-ran presentation over every object and points churned in and out at the
  // edges. The renderers cull on the GPU for free; the desktop shell turns this off and only
  // re-presents when data or the LOD band changes.
  const objects = [obj('aircraft:icao24:aaa', 'aircraft', 21, -157), obj('aircraft:icao24:bbb', 'aircraft', -33, 151)];
  const at = (lat: number, lon: number) => ({
    center: { latitude: lat, longitude: lon },
    altitudeM: 2_000_000,
    zoom: 4,
    headingDegrees: 0,
    pitchDegrees: -90,
    bounds: { west: lon - 10, south: lat - 10, east: lon + 10, north: lat + 10 },
  });
  const hawaii = presentObjects({ objects, view: at(21, -157), cullToView: false });
  const sydney = presentObjects({ objects, view: at(-33, 151), cullToView: false });
  assert.equal(hawaii.upsert.length, 2, 'the aircraft over Sydney is kept while looking at Hawaii');
  assert.deepEqual(
    diffFeatures(new Map(hawaii.upsert.map((f) => [f.id, f])), sydney.upsert).upsert,
    [],
    'a pan changes nothing',
  );

  // The default is unchanged for callers that rely on it.
  assert.equal(presentObjects({ objects, view: at(21, -157) }).upsert.length, 1);
});

test('restyleHover: a hover change restyles exactly what a full presentation pass would, and nothing else', () => {
  const objects: WorldObject[] = [
    obj('aircraft:a', 'aircraft', 21, -157, { headingDegrees: 90 }),
    obj('aircraft:b', 'aircraft', 21.5, -157.5),
    obj('earthquake:c', 'earthquake', 19.4, -155.3, { magnitude: 5.1 }),
    obj('satellite:d', 'satellite', 0, 10),
  ];
  // An object drawn from its geometry rather than a position.
  const alert = obj('weather-alert:e', 'weather-alert', 0, 0);
  delete (alert as { position?: unknown }).position;
  alert.geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [-156, 20],
        [-155, 20],
        [-155, 21],
        [-156, 20],
      ],
    ],
  };
  objects.push(alert);
  const ids = objects.map((o) => o.id);
  for (const zoom of [1, 12]) {
    const view = {
      center: { latitude: 20, longitude: -157 },
      altitudeM: 1_000_000,
      zoom,
      headingDegrees: 0,
      pitchDegrees: -90,
      bounds: { west: -180, south: -90, east: 180, north: 90 },
    };
    const pass = (hoveredId: string | null) =>
      new Map(
        presentObjects({ objects, view, hoveredId, selectedId: 'aircraft:b', cullToView: false }).upsert.map(
          (f) => [f.id, f] as const,
        ),
      );
    assert.ok(pass(null).has('obj:weather-alert:e'), 'the geometry-drawn object is part of the frame');
    assert.ok(pass(null).has('obj:aircraft:a'));
    for (const from of [null, ...ids]) {
      for (const to of [null, ...ids]) {
        const before = pass(from);
        const after = pass(to);
        const patch = new Map(restyleHover(before, from, to).map((f) => [f.id, f] as const));
        for (const [id, f] of after) {
          assert.deepEqual(patch.get(id) ?? before.get(id), f, `zoom ${zoom}: ${from} → ${to}, ${id}`);
        }
        assert.equal(before.size, after.size);
        assert.ok(patch.size <= 2);
      }
    }
  }
  assert.deepEqual(restyleHover(new Map(), 'aircraft:a', 'aircraft:b'), [], 'nothing presented, nothing to restyle');
});
