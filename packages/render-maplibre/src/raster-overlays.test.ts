import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler } from '@worldview/render-core';
import type { RasterOverlay } from '@worldview/world-model';
import { MapLibreWorldRenderer } from './renderer.js';
import { FRAME_HANDOVER_MS, heldRasterOverlay, planRasterOverlays } from './raster-overlays.js';
import { createFakeMapLibre, fakeImageCanvasFactory } from './testing/fake-maplibre.js';

/**
 * The 2D map keeps overlay layers by identity and hands a new radar or satellite frame over on
 * top of the old one, as the globe does (render-cesium raster-overlays.ts). Before, any change
 * to the overlay list removed and re-added every overlay, and the whole stack blinked to the
 * basemap each time a frame advanced.
 */
const radar = (time: string): RasterOverlay => ({
  kind: 'wms',
  id: `radar:${time}`,
  providerId: 'radar',
  name: 'Radar',
  attribution: 'test',
  url: 'https://radar.example/wms',
  layers: 'reflectivity',
  parameters: { TIME: time },
  frame: time,
});
const ir = (time: string): RasterOverlay => ({
  kind: 'wmts',
  id: `ir:${time}`,
  providerId: 'ir',
  name: 'Infrared',
  attribution: 'test',
  url: `https://gibs.example/ir/default/${time}/GoogleMapsCompatible_Level6/{TileMatrix}/{TileRow}/{TileCol}.png`,
  layer: 'ir',
  style: 'default',
  format: 'image/png',
  tileMatrixSet: 'GoogleMapsCompatible_Level6',
  webMercator: true,
  opacity: 0.55,
  frame: time,
});
const topo: RasterOverlay = {
  kind: 'xyz',
  id: 'topo',
  providerId: 'topo',
  name: 'Topo',
  attribution: 'test',
  url: 'https://topo.example/{z}/{x}/{y}.png',
};

test('plan: unchanged overlays are kept, a new frame retires its predecessor, a dropped one goes at once', () => {
  const held = [topo, ir('10:00'), radar('10:04')].map(heldRasterOverlay);
  assert.deepEqual(planRasterOverlays(held, [topo, ir('10:00'), radar('10:04')]), {
    keep: ['topo', 'ir:10:00', 'radar:10:04'],
    remove: [],
    retire: [],
    add: [],
  });
  const next = planRasterOverlays(held, [topo, ir('10:00'), radar('10:08')]);
  assert.deepEqual(next.keep, ['topo', 'ir:10:00']);
  assert.deepEqual(next.retire, ['radar:10:04']);
  assert.deepEqual(next.remove, []);
  assert.deepEqual(
    next.add.map((a) => [a.overlay.id, a.before]),
    [['radar:10:08', undefined]],
  );
  // The infrared advances under the radar: added beneath the radar's layer.
  const middle = planRasterOverlays(held, [topo, ir('10:10'), radar('10:04')]);
  assert.deepEqual(
    middle.add.map((a) => [a.overlay.id, a.before]),
    [['ir:10:10', 'radar:10:04']],
  );
  assert.deepEqual(middle.retire, ['ir:10:00']);
  // Dropped from the list: removed at once, no handover.
  assert.deepEqual(planRasterOverlays(held, [topo, radar('10:04')]).remove, ['ir:10:00']);
  // The same id with another descriptor (an opacity setting): replaced, not kept.
  const faded = planRasterOverlays(held, [topo, { ...ir('10:00'), opacity: 0.3 }, radar('10:04')]);
  assert.deepEqual(faded.remove, ['ir:10:00']);
  assert.deepEqual(
    faded.add.map((a) => a.overlay.id),
    ['ir:10:00'],
  );
  // A reorder keeps nothing and adds all again, in the new order.
  const reordered = planRasterOverlays(held, [radar('10:04'), topo, ir('10:00')]);
  assert.deepEqual(reordered.keep, []);
  assert.deepEqual(reordered.remove.sort(), ['ir:10:00', 'radar:10:04', 'topo']);
});

async function mounted() {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  const rasters = () => map.layers.map((l) => l.id).filter((id) => id.startsWith('wv-raster:'));
  // Pending handovers: neither cleared nor run yet.
  const handovers = () => timers.filter((t) => t.ms === FRAME_HANDOVER_MS && !t.cleared);
  const run = (t: { fn: () => void; cleared: boolean }) => {
    t.cleared = true;
    t.fn();
  };
  return { renderer, map, rasters, handovers, run };
}

test('2D: a new radar frame loads over the old one, which leaves after the handover; the others keep their layers', async () => {
  const { renderer, map, rasters, handovers, run } = await mounted();
  renderer.setOverlays([topo, ir('10:00'), radar('10:04')]);
  assert.deepEqual(rasters(), ['wv-raster:topo:layer', 'wv-raster:ir:10:00:layer', 'wv-raster:radar:10:04:layer']);
  const topoLayer = map.getLayer('wv-raster:topo:layer');
  const irSource = map.getSource('wv-raster:ir:10:00');

  renderer.setOverlays([topo, ir('10:00'), radar('10:08')]);
  assert.equal(map.getLayer('wv-raster:topo:layer'), topoLayer, 'the same layer object: its tiles are kept');
  assert.equal(map.getSource('wv-raster:ir:10:00'), irSource);
  assert.deepEqual(
    rasters(),
    ['wv-raster:topo:layer', 'wv-raster:ir:10:00:layer', 'wv-raster:radar:10:04:layer', 'wv-raster:radar:10:08:layer'],
    'the new frame right above the old',
  );
  assert.equal(handovers().length, 1);
  run(handovers()[0]!);
  assert.deepEqual(rasters(), ['wv-raster:topo:layer', 'wv-raster:ir:10:00:layer', 'wv-raster:radar:10:08:layer']);
  assert.equal(map.getSource('wv-raster:radar:10:04'), undefined);

  // The infrared advances beneath the radar: the new frame goes under the radar, over its predecessor.
  renderer.setOverlays([topo, ir('10:10'), radar('10:08')]);
  assert.deepEqual(rasters(), [
    'wv-raster:topo:layer',
    'wv-raster:ir:10:00:layer',
    'wv-raster:ir:10:10:layer',
    'wv-raster:radar:10:08:layer',
  ]);
  // Two frames in quick succession: each leaves in its turn, the newest stays.
  renderer.setOverlays([topo, ir('10:20'), radar('10:08')]);
  assert.equal(handovers().length, 2);
  for (const t of handovers()) run(t);
  assert.deepEqual(rasters(), ['wv-raster:topo:layer', 'wv-raster:ir:10:20:layer', 'wv-raster:radar:10:08:layer']);

  // Switched off: gone at once, no handover.
  renderer.setOverlays([topo, ir('10:20')]);
  assert.deepEqual(rasters(), ['wv-raster:topo:layer', 'wv-raster:ir:10:20:layer']);
  assert.equal(handovers().length, 0);
  renderer.dispose();
});

test('2D: a style change mid-handover drops the retiring frame and redraws the list; dispose clears the timers', async () => {
  const { renderer, rasters, handovers } = await mounted();
  renderer.setOverlays([radar('10:04')]);
  renderer.setOverlays([radar('10:08')]);
  assert.equal(handovers().length, 1);
  await renderer.setBasemap({ kind: 'none', id: 'none', attribution: '' } as never);
  assert.deepEqual(rasters(), ['wv-raster:radar:10:08:layer'], 'only the current frame after the new style');
  assert.equal(handovers().length, 0, 'the old handover was cancelled');
  renderer.setOverlays([radar('10:12')]);
  assert.equal(handovers().length, 1);
  renderer.dispose();
  assert.equal(handovers().length, 0);
});

test('2D: the imagery comparison cross-fades the two sources with the divider; ended, every opacity is back', async () => {
  const { renderer, map } = await mounted();
  const opacity = (id: string) =>
    (map.layers.find((l) => l.id === `wv-raster:${id}:layer`) as { paint?: Record<string, unknown> }).paint?.[
      'raster-opacity'
    ];
  const a = { ...topo, id: 'a', providerId: 'left-source' } as RasterOverlay;
  const b = {
    ...topo,
    id: 'b',
    url: 'https://tiles.example.invalid/b/{z}/{x}/{y}.png',
    providerId: 'right-source',
    opacity: 0.8,
  } as RasterOverlay;
  renderer.setImagerySplit({ left: 'left-source', right: 'right-source', position: 0.25 });
  renderer.setOverlays([a, b]);
  assert.equal(opacity('a'), 0.25, 'the left source: the share of the map left of the divider');
  assert.ok(Math.abs((opacity('b') as number) - 0.6) < 1e-12, 'the right source: 0.8 × three quarters');
  renderer.setImagerySplit({ left: 'left-source', right: 'right-source', position: 1 });
  assert.equal(opacity('b'), 0);
  renderer.setImagerySplit(null);
  assert.equal(opacity('a'), 1);
  assert.equal(opacity('b'), 0.8);
  renderer.dispose();
});
