import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler } from '@worldview/render-core';
import type { RasterOverlay } from '@worldview/world-model';
import { MapLibreWorldRenderer } from './renderer.js';
import {
  FRAME_HANDOVER_CHECK_MS,
  FRAME_HANDOVER_MAX_MS,
  FRAME_HANDOVER_MS,
  heldRasterOverlay,
  planRasterOverlays,
  rasterOverlaySpec,
} from './raster-overlays.js';
import { createFakeMapLibre, fakeImageCanvasFactory } from './testing/fake-maplibre.js';
import { resolveWmtsProtocolUrl } from './wmts-protocol.js';

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
  return { renderer, map, rasters, handovers, run, timers };
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

test('2D: a cross-faded slice that ends on 180° is drawn past it by a second source, through the same tile protocol', async () => {
  const { renderer, map, rasters } = await mounted();
  const slice = (id: string, west: number, east: number): RasterOverlay => ({
    ...ir('10:00'),
    id,
    providerId: id,
    bounds: { west, south: -60, east, north: 60 },
    featherDeg: 5,
    fadeBelow: { from: 135, to: 195, monochrome: true },
  });
  renderer.setOverlays([slice('goes-west', -180, -106), slice('himawari', 93, 180)]);
  assert.deepEqual(rasters(), [
    'wv-raster:goes-west:layer',
    'wv-raster:goes-west#past180:layer',
    'wv-raster:himawari:layer',
    'wv-raster:himawari#past180:layer',
  ]);
  const spec = (id: string) => map.getSource(`wv-raster:${id}`)!.spec as { bounds?: number[]; tiles?: string[] };
  assert.deepEqual(spec('goes-west').bounds, [-180, -60, -103.5, 60]);
  assert.deepEqual(spec('goes-west#past180').bounds, [177.5, -60, 180, 60]);
  assert.deepEqual(spec('himawari').bounds, [90.5, -60, 180, 60]);
  assert.deepEqual(spec('himawari#past180').bounds, [-180, -60, -177.5, 60]);
  assert.deepEqual(spec('himawari#past180').tiles, ['wvwmts://himawari%23past180/{z}/{x}/{y}']);
  assert.match(resolveWmtsProtocolUrl('wvwmts://himawari%23past180/6/20/0') ?? '', /^https:\/\/gibs\.example\//);
  assert.equal(
    resolveWmtsProtocolUrl('wvwmts://himawari%23past180/6/20/0'),
    resolveWmtsProtocolUrl('wvwmts://himawari/6/20/0'),
    'the part past 180° asks the same service for its tiles',
  );
  renderer.dispose();
});

test('2D: the old frame waits for the map to load the new one, and not past the cap', async () => {
  const { renderer, map, rasters, run, timers } = await mounted();
  const loading = map as unknown as { areTilesLoaded?: () => boolean };
  let loaded = false;
  loading.areTilesLoaded = () => loaded;
  renderer.setOverlays([radar('10:04')]);
  renderer.setOverlays([radar('10:08')]);
  const pending = () => timers.filter((t) => !t.cleared);
  run(pending()[0]!);
  assert.ok(rasters().includes('wv-raster:radar:10:04:layer'), 'tiles still loading: the old frame stays');
  assert.equal(pending()[0]!.ms, FRAME_HANDOVER_CHECK_MS);
  loaded = true;
  run(pending()[0]!);
  assert.deepEqual(rasters(), ['wv-raster:radar:10:08:layer']);
  loaded = false;
  renderer.setOverlays([radar('10:12')]);
  let checks = 0;
  while (pending().length && rasters().includes('wv-raster:radar:10:08:layer')) {
    run(pending()[0]!);
    checks++;
  }
  assert.deepEqual(rasters(), ['wv-raster:radar:10:12:layer']);
  assert.equal(checks, 1 + (FRAME_HANDOVER_MAX_MS - FRAME_HANDOVER_MS) / FRAME_HANDOVER_CHECK_MS);
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

test("2D: hideAboveZoom becomes the layer's maxzoom", () => {
  const spec = rasterOverlaySpec({ ...topo, hideAboveZoom: 9 } as RasterOverlay);
  assert.ok(!('unsupported' in spec));
  assert.equal(spec.layer.maxzoom, 9);
  const plain = rasterOverlaySpec(topo);
  assert.ok(!('unsupported' in plain));
  assert.equal(plain.layer.maxzoom, undefined);
});
