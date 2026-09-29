import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RasterOverlay } from '@worldview/world-model';
import type { ResolvedMapProvider } from '@worldview/render-core';
import { activeMapChoice, basemapLabel, imageryLabel, mapChoices } from './view-bar.js';
import { sourceBasemapId } from '../map-providers.js';

const basemap = (id: string, name: string, modes: Array<'2D' | '3D'>, available = true) =>
  ({ id, name, modes, available }) as unknown as ResolvedMapProvider;
const overlay = (providerId: string, name: string, extra: Partial<RasterOverlay> = {}) =>
  ({
    kind: 'xyz',
    id: `${providerId}:x`,
    providerId,
    name,
    attribution: 'a',
    url: 'https://x/{z}/{x}/{y}',
    ...extra,
  }) as RasterOverlay;

test('the Map choices: usable basemaps for the mode, sources’ maps, then imagery layers — no weather', () => {
  const basemaps = [
    basemap('natural-earth', 'Natural Earth II (bundled)', ['3D']),
    basemap('worldview-dark', 'WORLDVIEW dark (offline vector)', ['2D']),
    basemap('esri-world-imagery', 'Esri World Imagery', ['2D', '3D']),
    basemap('cesium-ion-bing', 'Bing Aerial with labels (Cesium ion)', ['3D'], false),
  ];
  const overlays = [
    overlay('gibs-viirs-noaa20-true-colour', 'Corrected Reflectance (True Color)'),
    overlay('gibs-viirs-noaa20-true-colour', 'Corrected Reflectance (True Color)', { id: 'another-frame' }),
    overlay('gibs-goes-east-infrared', 'Clean Infrared'),
    overlay('usgs-topo', 'USGS Topo', { role: 'basemap' }),
  ];
  assert.deepEqual(
    mapChoices(basemaps, overlays, '3D').map((c) => [c.id, c.label]),
    [
      ['basemap:natural-earth', 'Natural Earth'],
      ['basemap:esri-world-imagery', 'Satellite HD'],
      ['imagery:gibs-viirs-noaa20-true-colour', 'True colour · NOAA-20'],
      [`basemap:${sourceBasemapId(overlays[3]!)}`, 'USGS Topo'],
    ],
  );
  assert.deepEqual(
    mapChoices(basemaps, [], '2D').map((c) => c.label),
    ['Dark', 'Satellite HD'],
  );
});

test('the active Map choice: a chosen imagery layer that is published, else the basemap', () => {
  const choices = [
    { id: 'basemap:esri-world-imagery', label: '', title: '' },
    { id: 'imagery:gibs-viirs-snpp-true-colour', label: '', title: '' },
  ];
  assert.equal(activeMapChoice(choices, 'esri-world-imagery', undefined), 'basemap:esri-world-imagery');
  assert.equal(
    activeMapChoice(choices, 'esri-world-imagery', 'gibs-viirs-snpp-true-colour'),
    'imagery:gibs-viirs-snpp-true-colour',
  );
  assert.equal(activeMapChoice(choices, 'esri-world-imagery', 'gone'), 'basemap:esri-world-imagery');
});

test('labels', () => {
  assert.equal(basemapLabel({ id: 'something-new', name: 'Something New (online)' }), 'Something New');
  assert.equal(imageryLabel({ providerId: 'gibs-viirs-snpp-true-colour', name: 'x' }), 'True colour · Suomi NPP');
});
