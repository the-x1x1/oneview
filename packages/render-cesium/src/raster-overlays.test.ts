import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RasterOverlay } from '@worldview/world-model';
import { createFakeCesium, FakeEvent, FakeViewer } from './testing/fake-cesium.js';
import {
  FRAME_HANDOVER_CHECK_MS,
  FRAME_HANDOVER_MAX_MS,
  FRAME_HANDOVER_MS,
  LAYER_REPORT_MS,
  RasterOverlays3D,
  describeTileError,
  layerReport,
  overlaySeries,
  withBrightnessFade,
} from './raster-overlays.js';

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

test('the old frame waits for the globe to load the new one, and not past the cap', () => {
  const { viewer, overlays, timers } = setup();
  const globe = viewer.scene.globe as unknown as { tilesLoaded?: boolean };
  globe.tilesLoaded = false;
  overlays.set([topo, radar('a')]);
  const old = viewer.imageryLayers.layers[2]!;
  overlays.set([topo, radar('b')]);
  timers.shift()!();
  assert.ok(viewer.imageryLayers.layers.includes(old), 'tiles still loading: the old frame stays');
  timers.shift()!();
  assert.ok(viewer.imageryLayers.layers.includes(old));
  globe.tilesLoaded = true;
  timers.shift()!();
  assert.ok(!viewer.imageryLayers.layers.includes(old), 'gone once the new tiles are in');
  // A view that never finishes loading (always moving) still lets the old frame go.
  globe.tilesLoaded = false;
  overlays.set([topo, radar('c')]);
  const older = viewer.imageryLayers.layers[2]!;
  let checks = 0;
  while (timers.length && viewer.imageryLayers.layers.includes(older)) {
    timers.shift()!();
    checks++;
  }
  assert.ok(!viewer.imageryLayers.layers.includes(older));
  assert.equal(checks, 1 + (FRAME_HANDOVER_MAX_MS - FRAME_HANDOVER_MS) / FRAME_HANDOVER_CHECK_MS);
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

test('an overlay whose tiles fail says so once, with the status and zoom', async () => {
  const errors: string[] = [];
  const cesium = createFakeCesium();
  const viewer = new FakeViewer(null as unknown as Element, undefined);
  viewer.imageryLayers.add(cesium.ImageryLayer.fromProviderAsync(Promise.resolve({} as never)));
  const overlays = new RasterOverlays3D(cesium, viewer, (m) => errors.push(m));
  overlays.set([topo]);
  await new Promise((r) => setTimeout(r, 0));
  const provider = (viewer.imageryLayers.layers[1] as unknown as { provider?: { errorEvent: FakeEvent<unknown> } })
    .provider;
  assert.ok(provider?.errorEvent, 'the layer holds its provider');
  provider.errorEvent.raise({ level: 3, error: { statusCode: 400 }, message: 'Failed to obtain image tile' });
  provider.errorEvent.raise({ level: 4, error: { statusCode: 400 } });
  assert.deepEqual(errors, ['overlay: Topo: tiles are failing (HTTP 400, zoom 3)']);
  assert.equal(
    describeTileError({ message: 'SecurityError: tainted\nstack', level: 2 }),
    'SecurityError: tainted, zoom 2',
  );
  assert.equal(describeTileError({ error: new Error('canvas') }), 'canvas');
  assert.equal(describeTileError({ error: { statusCode: 404 }, level: 1, x: 0, y: 1 }), 'HTTP 404, tile 1/0/1');
  assert.equal(describeTileError(undefined), 'no detail');
  overlays.dispose();
});

test('hideAboveZoom: the layer is hidden from that zoom in, shown again further out, and frames keep it', () => {
  const { viewer, overlays } = setup();
  const rain = (t: string) => ({ ...radar(t), hideAboveZoom: 9 }) as RasterOverlay;
  overlays.set([topo, rain('a')]);
  const layer = viewer.imageryLayers.layers[2]!;
  assert.equal(layer.show, true, 'zoomed out: drawn');
  overlays.setZoom(10);
  assert.equal(layer.show, false, 'at a city: hidden');
  assert.equal(viewer.imageryLayers.layers[1]!.show, true, 'a layer without the limit stays');
  overlays.set([topo, rain('b')]);
  assert.equal(viewer.imageryLayers.layers[3]!.show, false, 'a new frame arrives hidden at this zoom');
  overlays.setZoom(8.5);
  assert.equal(viewer.imageryLayers.layers[3]!.show, true);
});

test('a faded tile goes back to Cesium as the kind of picture it came as (a bitmap stays a bitmap)', async () => {
  // Cesium decodes imagery to ImageBitmaps flipped at decode and uploads other sources with
  // UNPACK_FLIP_Y on: a canvas returned for a bitmap was flipped twice, upside down in its square.
  const g = globalThis as unknown as { ImageBitmap?: unknown; createImageBitmap?: unknown };
  const saved = { ImageBitmap: g.ImageBitmap, createImageBitmap: g.createImageBitmap };
  class FakeBitmap {
    constructor(
      readonly width: number,
      readonly height: number,
      readonly from?: unknown,
    ) {}
  }
  g.ImageBitmap = FakeBitmap;
  g.createImageBitmap = async (source: { width: number; height: number }) =>
    new FakeBitmap(source.width, source.height, source);
  try {
    const pixels = new Uint8ClampedArray(4 * 4).fill(255);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: () => ({ data: pixels }),
        putImageData: () => undefined,
      }),
    };
    const provider = { requestImage: async () => new FakeBitmap(2, 2) as unknown };
    withBrightnessFade(provider, { from: 10, to: 20 }, () => canvas as unknown as HTMLCanvasElement);
    const out = await provider.requestImage();
    assert.ok(out instanceof FakeBitmap, 'a bitmap in, a bitmap out');
    assert.equal((out as FakeBitmap).from, canvas, 'made from the faded canvas');
    const elementProvider = { requestImage: async () => ({ width: 2, height: 2 }) as unknown };
    withBrightnessFade(elementProvider, { from: 10, to: 20 }, () => canvas as unknown as HTMLCanvasElement);
    assert.equal(await elementProvider.requestImage(), canvas, 'an image element in, the canvas out');
  } finally {
    g.ImageBitmap = saved.ImageBitmap;
    g.createImageBitmap = saved.createImageBitmap;
  }
});

test('with no basemap layer (basemap "none") overlays still go in, from index 0', () => {
  const cesium = createFakeCesium();
  const viewer = new FakeViewer(null as unknown as Element, undefined);
  const overlays = new RasterOverlays3D(
    cesium,
    viewer,
    () => undefined,
    () => 0 as unknown as ReturnType<typeof setTimeout>,
  );
  assert.doesNotThrow(() => overlays.set([topo, radar('a')]));
  assert.equal(viewer.imageryLayers.layers.length, 2);
  assert.doesNotThrow(() => overlays.set([topo, radar('b')]), 'and a new frame is handed over');
  overlays.dispose();
});

test("the layer report: each overlay's place, visibility, opacity and tiles, said when it changes", async () => {
  const cesium = createFakeCesium();
  const viewer = new FakeViewer(null as unknown as Element, undefined);
  viewer.imageryLayers.add(cesium.ImageryLayer.fromProviderAsync(Promise.resolve({} as never)));
  const pending: Array<() => void> = [];
  const delays: number[] = [];
  const lines: string[] = [];
  const overlays = new RasterOverlays3D(
    cesium,
    viewer,
    () => undefined,
    () => 0 as unknown as ReturnType<typeof setTimeout>,
    {
      schedule: (fn, ms) => {
        delays.push(ms);
        pending.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      emit: (line) => lines.push(line),
    },
  );
  overlays.set([{ ...topo, providerId: 'topo-src', opacity: 0.85 } as RasterOverlay]);
  assert.equal(pending.length, 1, 'one report scheduled after the change');
  pending.shift()!();
  assert.deepEqual(lines, ['2 layers; topo-src@1 a0.85 ok0 fail0 blank0 L-1']);
  assert.equal(pending.length, 1, 'and checked again');
  pending.shift()!();
  assert.equal(lines.length, 1, 'unchanged: not said again');
  assert.deepEqual(
    delays,
    [LAYER_REPORT_MS / 4, LAYER_REPORT_MS, LAYER_REPORT_MS],
    'soon after a change, then once a minute',
  );
  overlays.set([]);
  pending.shift()!();
  assert.equal(pending.length, 0, 'no overlays: no more checks');
  assert.equal(
    layerReport(
      [{ providerId: 'a', index: 2, show: false, alpha: 1, tiles: { ok: 3, failed: 1, blank: 2, deepest: 5 } }],
      4,
    ),
    '4 layers; a@2 hidden a1 ok3 fail1 blank2 L5',
  );
  assert.equal(layerReport([], 1), '1 layers; no overlays');
});
