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
