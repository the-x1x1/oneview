import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapProviderList } from '@worldview/ipc-contract';
import { resolveMapProviders } from '@worldview/render-core';
import {
  basemapChoices,
  basemapForMode,
  resolveMapProvider,
  selectBasemap,
  selectTerrain,
  terrainChoices,
  terrainFor,
} from './map-providers.js';

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

/** The same list under different installation conditions. */
function listWhen(opts: { online: boolean; pack: boolean }): MapProviderList {
  const resolved = resolveMapProviders({ credentials: [], offlineBasemapAvailable: opts.pack, online: opts.online });
  return {
    basemaps: resolved.filter((e) => e.kind === 'basemap'),
    terrains: resolved.filter((e) => e.kind === 'terrain'),
    activeBasemapId: 'natural-earth',
    activeTerrainId: 'ellipsoid',
  };
}

test('basemapForMode: never hands a renderer something it cannot show', () => {
  // Settings hold one basemapId; the catalog entries are per mode and can be unavailable.
  // Natural Earth II is a Cesium imagery stack and 3D-only. The 2D default is a PMTiles
  // pack a fresh installation does not have. Wiring the setting straight to the renderer
  // would have handed MapLibre one or the other on every default install.
  const fresh = listWhen({ online: true, pack: false });
  assert.equal(basemapForMode(fresh, 'natural-earth', '3D')?.id, 'natural-earth', 'kept where it works');
  assert.equal(
    basemapForMode(fresh, 'natural-earth', '2D'),
    undefined,
    'nothing, rather than a pack that is not installed: that costs a 10 s style timeout and a toast',
  );
  const withPack = listWhen({ online: true, pack: true });
  assert.equal(basemapForMode(withPack, 'natural-earth', '2D')?.id, 'worldview-dark', 'the 2D default once it exists');

  // An entry that serves both modes is kept in both, which is the point of choosing it.
  assert.equal(basemapForMode(fresh, 'esri-world-imagery', '2D')?.id, 'esri-world-imagery');
  assert.equal(basemapForMode(fresh, 'esri-world-imagery', '3D')?.id, 'esri-world-imagery');

  // Offline, a network basemap gives way to what can actually be drawn — without the
  // setting being rewritten, so coming back online restores it.
  const offline = listWhen({ online: false, pack: false });
  assert.equal(basemapForMode(offline, 'esri-world-imagery', '3D')?.id, 'natural-earth');
  assert.equal(basemapForMode(offline, 'esri-world-imagery', '2D'), undefined);

  // An unknown id falls back rather than being invented, and nothing resolves before the
  // runtime's list has arrived.
  assert.equal(basemapForMode(fresh, 'not-in-the-catalog', '3D')?.id, 'natural-earth');
  assert.equal(basemapForMode(null, 'natural-earth', '3D'), undefined);
});

test('terrainFor: an unavailable terrain gives way to the ellipsoid, never to nothing', () => {
  // This is what makes a network terrain safe to select — and safe to make the default one
  // day — for someone who opens the app with no connection: the globe loses its relief,
  // not its surface.
  const online = listWhen({ online: true, pack: false });
  const offline = listWhen({ online: false, pack: false });
  assert.equal(terrainFor(online, 'reearth-terrain')?.id, 'reearth-terrain');
  assert.equal(terrainFor(offline, 'reearth-terrain')?.id, 'ellipsoid');
  assert.equal(terrainFor(online, 'cesium-ion-world-terrain')?.id, 'ellipsoid', 'no token, no ion terrain');
  assert.equal(terrainFor(online, 'not-in-the-catalog')?.id, 'ellipsoid');
  assert.equal(terrainFor(null, 'reearth-terrain'), undefined, 'nothing before the list arrives');
});
