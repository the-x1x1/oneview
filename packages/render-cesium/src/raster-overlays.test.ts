import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RasterOverlay } from '@worldview/world-model';
import { createFakeCesium, FakeViewer } from './testing/fake-cesium.js';
import { FRAME_HANDOVER_MS, RasterOverlays3D, overlaySeries } from './raster-overlays.js';

const radar = (time: string): RasterOverlay =>
  ({
    kind: 'wms',
    id: `radar@${time}`,
    name: 'Radar',
    url: 'https://example.invalid/wms',
    layers: 'reflectivity',
    parameters: { TIME: time },
    attribution: 'test',
  }) as unknown as RasterOverlay;
const topo: RasterOverlay = {
  kind: 'xyz',
  id: 'topo',
  name: 'Topo',
  url: 'https://example.invalid/{z}/{x}/{y}.png',
  attribution: 'test',
} as unknown as RasterOverlay;

function setup() {
  const cesium = createFakeCesium();
  const viewer = new FakeViewer(null as unknown as Element, undefined);
  // The basemap, which the stack controller keeps at index 0.
  viewer.imageryLayers.add(cesium.ImageryLayer.fromProviderAsync(Promise.resolve({} as never)));
  const timers: Array<() => void> = [];
  const overlays = new RasterOverlays3D(
    cesium,
    viewer,
    () => undefined,
    (fn) => {
      timers.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  );
  return { viewer, overlays, timers };
}

test('overlaySeries: two frames of one overlay are the same series; different overlays are not', () => {
  assert.equal(overlaySeries(radar('a')), overlaySeries(radar('b')));
  assert.notEqual(overlaySeries(radar('a')), overlaySeries(topo));
});

test('an unchanged overlay keeps its layer when another is added', () => {
  const { viewer, overlays } = setup();
  overlays.set([topo]);
  const first = viewer.imageryLayers.layers[1];
  overlays.set([topo, radar('a')]);
  assert.equal(viewer.imageryLayers.layers[1], first, 'same layer object, tiles kept');
  assert.equal(viewer.imageryLayers.layers.length, 3);
});

test('a new radar frame goes over the old one, which leaves after the handover', () => {
  const { viewer, overlays, timers } = setup();
  overlays.set([topo, radar('a')]);
  const old = viewer.imageryLayers.layers[2]!;
  overlays.set([topo, radar('b')]);
  assert.equal(viewer.imageryLayers.layers.length, 4, 'old frame still under the new one');
  assert.equal(viewer.imageryLayers.layers[2], old, 'directly beneath its successor');
  assert.equal(timers.length, 1);
  assert.ok(FRAME_HANDOVER_MS > 0);
  timers[0]!();
  assert.equal(viewer.imageryLayers.layers.length, 3);
  assert.ok(!viewer.imageryLayers.layers.includes(old));
});

test('a dropped overlay is removed at once', () => {
  const { viewer, overlays } = setup();
  overlays.set([topo, radar('a')]);
  overlays.set([topo]);
  assert.equal(viewer.imageryLayers.layers.length, 2);
});

test('imagery comparison: each source on its side of the divider, a new frame keeps its side, null draws all whole', () => {
  const { viewer, overlays } = setup();
  const snpp = (day: string) => ({ ...radar(day), providerId: 'snpp' }) as RasterOverlay;
  const noaa20 = { ...topo, providerId: 'noaa20' } as RasterOverlay;
  const other = { ...topo, id: 'other', url: 'https://example.invalid/other/{z}/{x}/{y}.png', providerId: 'x' };
  overlays.set([snpp('2026-09-27'), noaa20, other as RasterOverlay]);
  overlays.setSplit({ left: 'snpp', right: 'noaa20', position: 0.3 });
  const dir = (i: number) => viewer.imageryLayers.layers[i]!.splitDirection;
  assert.equal(viewer.scene.splitPosition, 0.3);
  assert.deepEqual([dir(1), dir(2), dir(3)], [-1, 1, 0], 'left, right, whole');
  // GIBS advances a day: the new frame lands on the left too, and so does the old one while it hands over.
  overlays.set([snpp('2026-09-28'), noaa20, other as RasterOverlay]);
  assert.deepEqual(
    viewer.imageryLayers.layers.slice(1).map((l) => l.splitDirection),
    [-1, -1, 1, 0],
    'new frame, retiring frame beneath it, then the others',
  );
  overlays.setSplit({ left: 'snpp', right: 'noaa20', position: 7 });
  assert.equal(viewer.scene.splitPosition, 1, 'clamped to the canvas');
  overlays.setSplit(null);
  assert.ok(viewer.imageryLayers.layers.slice(1).every((l) => l.splitDirection === 0));
});
