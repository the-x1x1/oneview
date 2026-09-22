import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapProviderList } from '@worldview/ipc-contract';
import { resolveMapProviders } from '@worldview/render-core';
import { basemapChoices, resolveMapProvider, selectBasemap, selectTerrain, terrainChoices } from './map-providers.js';

function list(): MapProviderList {
  const resolved = resolveMapProviders({ credentials: [], offlineBasemapAvailable: false, online: true });
  return {
    basemaps: resolved.filter((e) => e.kind === 'basemap'),
    terrains: resolved.filter((e) => e.kind === 'terrain'),
    activeBasemapId: 'natural-earth',
    activeTerrainId: 'ellipsoid',
  };
}

test('shell map providers: before the first response the shell names nothing it cannot back up', () => {
  assert.equal(selectBasemap(null, 'natural-earth'), undefined);
  assert.equal(selectTerrain(null, 'ellipsoid'), undefined);
  assert.deepEqual(
    basemapChoices(null, 'natural-earth').map((c) => c.id),
    ['natural-earth'],
  );
});

test('shell map providers: a selected entry carries the runtime attribution and availability', () => {
  const chosen = selectBasemap(list(), 'natural-earth');
  assert.equal(chosen?.name, 'Natural Earth II (bundled)');
  assert.match(chosen?.attribution ?? '', /Natural Earth II/);
  assert.equal(chosen?.available, true);

  const gated = selectBasemap(list(), 'cesium-ion-bing');
  assert.equal(gated?.available, false);
  assert.match(gated?.unavailableReason ?? '', /cesium\.ionToken/);
});

test('shell map providers: an id the runtime did not list stays selected rather than being rewritten', () => {
  const choices = basemapChoices(list(), 'operator-custom-style');
  assert.equal(choices[0]?.id, 'operator-custom-style');
  assert.match(choices[0]?.name ?? '', /configured by the runtime/);
  assert.equal(choices.filter((c) => c.id === 'operator-custom-style').length, 1);

  const known = basemapChoices(list(), 'natural-earth');
  assert.equal(known.filter((c) => c.id === 'natural-earth').length, 1, 'a listed id is not duplicated');
});

test('shell map providers: unavailable entries are still offered, so the reason is visible', () => {
  const choices = basemapChoices(list(), 'natural-earth');
  const gated = choices.find((c) => c.id === 'cesium-ion-bing');
  assert.ok(gated, 'the picker lists it');
  assert.equal(gated.available, false);
  assert.ok(gated.unavailableReason, 'with a reason the dialog can show');
  assert.deepEqual(
    terrainChoices(list(), 'ellipsoid')
      .map((c) => c.id)
      .slice(0, 1),
    ['ellipsoid'],
  );
});

test('resolveMapProvider: the configured id yields the descriptor the renderer needs', () => {
  // `selectBasemap` / `selectTerrain` narrow to what the UI shows and deliberately drop the
  // descriptor, so the shell had a selector for the credit line and none for the thing that
  // changes the map — which is half of why changing the basemap in Settings did nothing but
  // move the credit. Returning nothing until the runtime's list arrives is the point: the
  // shell must never invent a descriptor for an id it cannot resolve.
  const l = list();
  const basemap = resolveMapProvider(l, 'basemap', 'natural-earth');
  const terrain = resolveMapProvider(l, 'terrain', 'reearth-terrain');
  assert.ok(basemap?.descriptor.kind, 'the bundled basemap resolves to a descriptor');
  assert.ok(terrain?.descriptor.kind, 'the keyless terrain resolves to a descriptor');
  assert.equal(resolveMapProvider(l, 'basemap', 'reearth-terrain'), undefined, 'kinds do not cross over');
  assert.equal(resolveMapProvider(null, 'basemap', 'natural-earth'), undefined, 'nothing before the list arrives');
  assert.equal(resolveMapProvider(l, 'basemap', undefined), undefined);
  assert.equal(resolveMapProvider(l, 'basemap', 'not-in-the-catalog'), undefined);
});
