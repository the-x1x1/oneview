import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, type ReferenceData, type RenderFeature } from '@worldview/render-core';
import { MapLibreWorldRenderer } from './renderer.js';
import { REFERENCE_LABELS_SOURCE, REFERENCE_LINES_SOURCE, referenceLayers, referenceSources } from './reference.js';
import { validateStyle, type MapStyle } from './styles/spec.js';
import { buildEmptyStyle, buildRasterStyle, DEFAULT_GLYPHS_URL, styleForBasemap } from './styles/worldview-dark.js';
import { createFakeMapLibre, fakeImageCanvasFactory } from './testing/fake-maplibre.js';
import { resolveWmtsProtocolUrl } from './wmts-protocol.js';

const data: ReferenceData = {
  lines: [
    {
      kind: 'country',
      dashed: false,
      minZoom: 0,
      coords: Float64Array.from([-120, 49, -110, 49]),
      bbox: [-120, 49, -110, 49],
    },
    {
      kind: 'state',
      dashed: false,
      minZoom: 2,
      coords: Float64Array.from([-120, 39, -114.6, 35]),
      bbox: [-120, 35, -114.6, 39],
    },
  ],
  labels: [{ kind: 'country', name: 'Canada', lon: -100, lat: 60, minZoom: 1.7, maxZoom: 6, rank: 2 }],
  attribution: 'Made with Natural Earth',
};

test('reference (2D): the layers form a valid style with glyphs, thresholds shifted to MapLibre zoom', () => {
  const style: MapStyle = {
    ...buildEmptyStyle('dark', DEFAULT_GLYPHS_URL),
    sources: referenceSources(data),
    layers: [
      ...buildEmptyStyle('dark').layers,
      ...referenceLayers({ borders: true, labels: true }, ['Noto Sans Regular']),
    ],
  };
  assert.deepEqual(validateStyle(style), []);
  const country = style.layers.find((l) => l.id === 'wv-ref:country');
  assert.deepEqual((country as { filter?: unknown }).filter, [
    'all',
    ['==', ['get', 'kind'], 'country'],
    ['==', ['get', 'dashed'], false],
    ['>=', ['zoom'], ['-', ['get', 'minZoom'], 1]],
  ]);
  assert.equal(referenceLayers({ borders: false, labels: true }, ['x']).length, 2, 'names only');
  assert.equal(referenceLayers({ borders: true, labels: false }, ['x']).length, 8, 'lines only');
});

test('every 2D style can draw text: raster and empty styles carry the bundled glyphs too', () => {
  // They had no glyphs url, so no symbol layer — object labels included — could draw text.
  assert.equal(
    buildRasterStyle({
      id: 'x',
      tiles: ['https://t/{z}/{x}/{y}'],
      maxzoom: 19,
      attribution: '',
      glyphs: DEFAULT_GLYPHS_URL,
    }).glyphs,
    DEFAULT_GLYPHS_URL,
  );
  const esri = styleForBasemap({ kind: 'esri-world-imagery', id: 'esri-world-imagery', attribution: 'Esri' } as never);
  assert.equal(typeof esri === 'object' && esri.glyphs, DEFAULT_GLYPHS_URL);
  const none = styleForBasemap({ kind: 'none', id: 'none', attribution: '' } as never);
  assert.equal(typeof none === 'object' && none.glyphs, DEFAULT_GLYPHS_URL);
  assert.equal(DEFAULT_GLYPHS_URL, 'worldview://app/fonts/{fontstack}/{range}.pbf', 'served by the app protocol');
});

test('reference (2D): drawn beneath the world, kept across a basemap change, removed when switched off', async () => {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
  });
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  // The world first: an aircraft layer exists before the reference layer arrives.
  const f: RenderFeature = {
    id: 'a1',
    objectId: 'aircraft:a1',
    geometry: { kind: 'point', position: { latitude: 21, longitude: -157 } },
    style: { styleClass: 'aircraft' },
    interactive: true,
    priority: 50,
    layer: 'aircraft',
  };
  renderer.update({ upsert: [f], remove: [] });
  scheduler.flush();
  renderer.setReference(data, { borders: true, labels: true });
  const ids = () => map.layers.map((l) => l.id);
  const firstWorld = ids().findIndex((id) => id.startsWith('wv:aircraft'));
  const lastRef = Math.max(...ids().map((id, i) => (id.startsWith('wv-ref:') ? i : -1)));
  assert.ok(firstWorld > 0 && lastRef >= 0 && lastRef < firstWorld, `reference below the world: ${ids().join(', ')}`);
  assert.ok(map.getSource(REFERENCE_LINES_SOURCE) && map.getSource(REFERENCE_LABELS_SOURCE));

  // A basemap change replaces the style: the reference comes back, still beneath.
  await renderer.setBasemap({ kind: 'none', id: 'none', attribution: '' } as never);
  const after = ids();
  assert.ok(
    after.some((id) => id === 'wv-ref:country'),
    after.join(', '),
  );
  assert.ok(after.indexOf('wv-ref:labels-country') < after.findIndex((id) => id.startsWith('wv:aircraft')));

  renderer.setReference(data, { borders: false, labels: false });
  assert.ok(!ids().some((id) => id.startsWith('wv-ref:')));
  assert.equal(map.getSource(REFERENCE_LINES_SOURCE), undefined);
  renderer.dispose();
});

test('watch zones (2D): drawn beneath the objects even when the zone arrives after them, and after a basemap change', async () => {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
  });
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  const aircraft: RenderFeature = {
    id: 'a1',
    objectId: 'aircraft:a1',
    geometry: { kind: 'point', position: { latitude: 29, longitude: 129 } },
    style: { styleClass: 'aircraft' },
    interactive: true,
    priority: 50,
    layer: 'aircraft',
  };
  renderer.update({ upsert: [aircraft], remove: [] });
  scheduler.flush();
  const zone: RenderFeature = {
    id: 'zone:z1',
    geometry: { kind: 'circle', center: { latitude: 29, longitude: 129 }, radiusM: 50_000 },
    style: { styleClass: 'watchzone', opacity: 0.5 },
    interactive: false,
    priority: 60,
    layer: 'watchzones',
  };
  renderer.update({ upsert: [zone], remove: [] });
  scheduler.flush();
  const ids = () => map.layers.map((l) => l.id);
  const below = () => {
    const lastZone = Math.max(...ids().map((id, i) => (id.startsWith('wv:watchzones') ? i : -1)));
    const firstAircraft = ids().findIndex((id) => id.startsWith('wv:aircraft'));
    return lastZone >= 0 && firstAircraft >= 0 && lastZone < firstAircraft;
  };
  assert.ok(below(), ids().join(', '));
  await renderer.setBasemap({ kind: 'none', id: 'none', attribution: '' } as never);
  assert.ok(below(), `after a basemap change: ${ids().join(', ')}`);
  renderer.dispose();
});

test('raster overlays (2D): drawn beneath the reference and the world, re-added after a basemap change, gone when the list empties', async () => {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
  });
  const errors: string[] = [];
  renderer.on('error', (e) => errors.push(e.message));
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  const f: RenderFeature = {
    id: 'a1',
    objectId: 'aircraft:a1',
    geometry: { kind: 'point', position: { latitude: 21, longitude: -157 } },
    style: { styleClass: 'aircraft' },
    interactive: true,
    priority: 50,
    layer: 'aircraft',
  };
  renderer.update({ upsert: [f], remove: [] });
  scheduler.flush();
  renderer.setReference(data, { borders: true, labels: false });
  const wms = {
    id: 'agency:roads',
    providerId: 'agency',
    name: 'Roads',
    attribution: 'Agency',
    kind: 'wms' as const,
    url: 'https://w.example/wms',
    layers: 'roads',
    opacity: 0.6,
    bounds: { west: -125, south: 24, east: -66, north: 50 },
  };
  const xyz = {
    id: 'agency:tiles',
    providerId: 'agency',
    name: 'Tiles',
    attribution: 'Agency',
    kind: 'xyz' as const,
    url: 'https://{s}.t.example/{z}/{x}/{y}.png',
    subdomains: ['a', 'b'],
  };
  const geographic = {
    ...xyz,
    id: 'agency:geo',
    kind: 'wmts' as const,
    layer: 'l',
    style: 's',
    format: 'image/png',
    tileMatrixSet: 'EPSG:4326',
  };
  renderer.setOverlays([wms, xyz, geographic]);
  const ids = () => map.layers.map((l) => l.id);
  const at = (prefix: string) => ids().findIndex((id) => id.startsWith(prefix));
  assert.ok(at('wv-raster:agency:roads') < at('wv-raster:agency:tiles'), `list order kept: ${ids().join(', ')}`);
  assert.ok(at('wv-raster:agency:tiles') < at('wv-ref:'), `overlays beneath the reference: ${ids().join(', ')}`);
  assert.ok(at('wv-ref:') < at('wv:aircraft'), 'reference beneath the world');
  assert.equal(at('wv-raster:agency:geo'), -1, 'a geographic WMTS is not drawn');
  assert.match(errors.join('\n'), /not Web Mercator/);
  const src = map.getSource('wv-raster:agency:tiles')!.spec as { type: string; tiles?: string[] };
  assert.deepEqual(src.tiles, ['https://a.t.example/{z}/{x}/{y}.png', 'https://b.t.example/{z}/{x}/{y}.png']);
  const roadsSrc = map.getSource('wv-raster:agency:roads')!.spec as { bounds?: number[] };
  assert.deepEqual(roadsSrc.bounds, [-125, 24, -66, 50], 'the extent keeps a white-painting WMS to its coverage');
  assert.equal((src as { bounds?: unknown }).bounds, undefined, 'no extent, no bounds');
  const roads = map.layers.find((l) => l.id === 'wv-raster:agency:roads:layer') as { paint?: Record<string, unknown> };
  assert.equal(roads.paint?.['raster-opacity'], 0.6);

  await renderer.setBasemap({ kind: 'none', id: 'none', attribution: '' } as never);
  assert.ok(
    at('wv-raster:agency:roads') >= 0 && at('wv-raster:agency:roads') < at('wv-ref:'),
    `back after a style change: ${ids().join(', ')}`,
  );

  renderer.setOverlays([xyz]);
  assert.equal(at('wv-raster:agency:roads'), -1);
  assert.equal(map.getSource('wv-raster:agency:roads'), undefined);
  renderer.setOverlays([]);
  assert.ok(!ids().some((id) => id.startsWith('wv-raster:')));
  renderer.dispose();
});

test('raster overlays (2D): a Web Mercator WMTS named 00…18 (BKG TopPlusOpen) is drawn through wvwmts://, not reported as not Web Mercator', async () => {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
  });
  const errors: string[] = [];
  renderer.on('error', (e) => errors.push(e.message));
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  const labels = Array.from({ length: 19 }, (_, z) => String(z).padStart(2, '0'));
  const topplus = {
    id: 'bkg-topplus-light-wmts:web_light',
    providerId: 'bkg-topplus-light-wmts',
    name: 'TopPlusOpen Light',
    attribution: 'BKG',
    kind: 'wmts' as const,
    url: 'https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web_light/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
    layer: 'web_light',
    style: 'default',
    format: 'image/png',
    tileMatrixSet: 'WEBMERCATOR',
    webMercator: true,
    tileMatrixLabels: labels,
  };
  renderer.setOverlays([topplus]);
  assert.deepEqual(errors, []);
  const src = map.getSource('wv-raster:bkg-topplus-light-wmts:web_light')!.spec as { tiles?: string[] };
  assert.deepEqual(src.tiles, ['wvwmts://bkg-topplus-light-wmts%3Aweb_light/{z}/{x}/{y}']);
  assert.ok(maplibre.protocols.has('wvwmts'), 'the protocol is registered');
  assert.equal(
    resolveWmtsProtocolUrl('wvwmts://bkg-topplus-light-wmts%3Aweb_light/5/17/10'),
    'https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web_light/default/WEBMERCATOR/05/10/17.png',
  );
  assert.equal(resolveWmtsProtocolUrl('wvwmts://bkg-topplus-light-wmts%3Aweb_light/19/0/0'), undefined, 'no matrix');
  assert.equal(resolveWmtsProtocolUrl('wvwmts://unknown/1/0/0'), undefined);
  renderer.dispose();
});
