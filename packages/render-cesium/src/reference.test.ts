import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, zoomToAltitudeM, type ReferenceData, type ReferenceLine } from '@worldview/render-core';
import { ALWAYS_VISIBLE } from './horizon.js';
import { CesiumWorldRenderer } from './renderer.js';
import { ReferenceTileSource, tileBounds, zoomForLevel, type TileContext2D } from './reference-tiles.js';
import { createFakeCesium, fakeCanvasFactory } from './testing/fake-cesium.js';

function line(kind: 'country' | 'state', minZoom: number, coords: number[], dashed = false): ReferenceLine {
  const lons = coords.filter((_, i) => i % 2 === 0);
  const lats = coords.filter((_, i) => i % 2 === 1);
  return {
    kind,
    dashed,
    minZoom,
    coords: Float64Array.from(coords),
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
  };
}

/** A context that records what is drawn. */
function recorder() {
  const ops: string[] = [];
  const ctx: TileContext2D = {
    lineWidth: 1,
    strokeStyle: '',
    lineJoin: '',
    lineCap: '',
    clearRect: () => ops.push('clear'),
    beginPath: () => ops.push('begin'),
    moveTo: (x, y) => ops.push(`M${x.toFixed(1)},${y.toFixed(1)}`),
    lineTo: (x, y) => ops.push(`L${x.toFixed(1)},${y.toFixed(1)}`),
    stroke: () => ops.push(`stroke:${ctx.strokeStyle}`),
    setLineDash: (d) => ops.push(`dash:${d.join(',')}`),
  };
  return { ctx, ops };
}

const US_CANADA = line('country', 0, [-120, 49, -110, 49]);
const CA_NV = line('state', 2, [-120, 39, -114.6, 35]);
const KASHMIR = line('country', 0, [74, 34, 75, 35], true);

test('reference tiles: level L is web zoom L+1, bounds in the geographic scheme', () => {
  assert.equal(zoomForLevel(0), 1);
  assert.deepEqual(tileBounds(0, 0, 0), [-180, -90, 0, 90]);
  assert.deepEqual(tileBounds(1, 0, 0), [0, -90, 180, 90]);
  assert.deepEqual(tileBounds(0, 0, 1), [-180, 0, -90, 90]);
});

test('reference tiles: a tile draws the lines that cross it, states only from their zoom', () => {
  const src = new ReferenceTileSource([US_CANADA, CA_NV, KASHMIR]);
  // Level 0, western hemisphere: web zoom 1 — the country border, not yet the state line.
  assert.deepEqual(src.linesFor(0, 0, 0), [0]);
  // Level 1 (web zoom 2): the state line too.
  assert.deepEqual(src.linesFor(0, 0, 1).sort(), [0, 1]);
  // The eastern hemisphere has only Kashmir.
  assert.deepEqual(src.linesFor(1, 0, 0), [2]);
  // A tile of open ocean has nothing, and says so.
  const { ctx, ops } = recorder();
  assert.equal(src.draw(ctx, 0, 1, 2), 0, 'southern Pacific');
  assert.deepEqual(ops, ['clear']);
});

test('reference tiles: pixels are relative to the tile; dashed lines dash; an underlay goes first', () => {
  const src = new ReferenceTileSource([US_CANADA, KASHMIR]);
  const { ctx, ops } = recorder();
  // Level 2 tile x=1,y=0 covers 135°W..90°W, 45°N..90°N; 256 px over 45°.
  const drawn = src.draw(ctx, 1, 0, 2);
  assert.equal(drawn, 1);
  const px = (lon: number) => ((lon + 135) * 256) / 45;
  const py = (lat: number) => ((90 - lat) * 256) / 45;
  assert.ok(ops.includes(`M${px(-120).toFixed(1)},${py(49).toFixed(1)}`), ops.join(' '));
  assert.ok(ops.includes(`L${px(-110).toFixed(1)},${py(49).toFixed(1)}`));
  const strokes = ops.filter((o) => o.startsWith('stroke:'));
  assert.equal(strokes.length, 2, 'underlay then line');
  assert.match(strokes[0]!, /rgba\(0,0,0/);
  const east = recorder();
  src.draw(east.ctx, 2, 0, 1);
  assert.ok(east.ops.includes('dash:4,3'), 'Kashmir is dashed');
});

test('reference overlay (3D): borders become an imagery layer on top; names follow zoom and the horizon', async () => {
  const cesium = createFakeCesium();
  const scheduler = new ManualScheduler();
  let horizon = ALWAYS_VISIBLE;
  const renderer = new CesiumWorldRenderer({
    cesium,
    createCanvas: fakeCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    horizon: () => (p) => horizon(p),
  });
  const data: ReferenceData = {
    lines: [US_CANADA, CA_NV],
    labels: [
      { kind: 'country', name: 'Canada', lon: -100, lat: 60, minZoom: 1.7, maxZoom: 6, rank: 2 },
      { kind: 'state', name: 'Nevada', lon: -117, lat: 39, minZoom: 3.5, maxZoom: 9, rank: 2, country: 'USA' },
    ],
    attribution: 'Made with Natural Earth',
  };
  // Given before the globe exists: kept, and applied on mount.
  renderer.setReference(data, { borders: true, labels: true });
  await renderer.mount({
    ownerDocument: { createElement: () => ({ className: '', remove() {} }) },
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLElement);
  const viewer = cesium.viewers[0]!;
  assert.equal(cesium.canvasLayers.length, 1, 'one imagery layer for the borders');
  const layers = (viewer.imageryLayers as unknown as { layers: unknown[] }).layers;
  assert.equal(layers.at(-1), cesium.canvasLayers[0], 'above the basemap');

  const labels = () =>
    (viewer.scene.primitives.items as Array<{ items?: Array<{ text?: string; show: boolean }> }>)
      .flatMap((c) => c.items ?? [])
      .filter((i) => i.text === 'Canada' || i.text === 'Nevada');
  renderer.setView({
    center: { latitude: 45, longitude: -100 },
    altitudeM: zoomToAltitudeM(2.5, 45),
    zoom: 2.5,
    headingDegrees: 0,
    pitchDegrees: -90,
  });
  viewer.camera.changed.raise(1);
  viewer.scene.preRender.raise(undefined);
  const shown = () =>
    labels()
      .filter((l) => l.show)
      .map((l) => l.text);
  assert.deepEqual(shown(), ['Canada'], 'at zoom 2.5 the country is named, the state not yet');
  renderer.setView({
    center: { latitude: 39, longitude: -117 },
    altitudeM: zoomToAltitudeM(5, 39),
    zoom: 5,
    headingDegrees: 0,
    pitchDegrees: -90,
  });
  viewer.camera.changed.raise(1);
  viewer.scene.preRender.raise(undefined);
  assert.deepEqual(shown().sort(), ['Canada', 'Nevada']);
  horizon = () => false;
  renderer.setView({
    center: { latitude: 0, longitude: 80 },
    altitudeM: zoomToAltitudeM(5, 0),
    zoom: 5,
    headingDegrees: 0,
    pitchDegrees: -90,
  });
  viewer.scene.preRender.raise(undefined);
  assert.deepEqual(shown(), [], 'behind the Earth, nothing is named');

  // Switching borders off removes the layer; names stay.
  renderer.setReference(data, { borders: false, labels: true });
  assert.equal(cesium.canvasLayers[0]!.isDestroyed(), true);
  assert.equal(labels().length, 2);
  renderer.setReference(null, { borders: true, labels: true });
  assert.equal(labels().length, 0, 'no data, no names');
  renderer.dispose();
});
