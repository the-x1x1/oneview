import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, type ReferenceData, type RenderFeature } from '@worldview/render-core';
import { MapLibreWorldRenderer } from './renderer.js';
import { REFERENCE_LABELS_SOURCE, REFERENCE_LINES_SOURCE, referenceLayers, referenceSources } from './reference.js';
import { validateStyle, type MapStyle } from './styles/spec.js';
import { buildEmptyStyle, buildRasterStyle, DEFAULT_GLYPHS_URL, styleForBasemap } from './styles/worldview-dark.js';
import { createFakeMapLibre, fakeImageCanvasFactory } from './testing/fake-maplibre.js';

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
