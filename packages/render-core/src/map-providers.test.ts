import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_2D_BASEMAP_ID,
  DEFAULT_BASEMAP_ID,
  DEFAULT_TERRAIN_ID,
  MAP_PROVIDER_CATALOG,
  defaultBasemapFor,
  resolveMapProviders,
} from './map-providers.js';

const byId = (id: string) => MAP_PROVIDER_CATALOG.find((e) => e.id === id);

test('map providers: the defaults are zero-credential, offline-capable and commercially approved', () => {
  for (const id of [DEFAULT_BASEMAP_ID, DEFAULT_2D_BASEMAP_ID, DEFAULT_TERRAIN_ID]) {
    const entry = byId(id);
    assert.ok(entry, `${id} is in the catalog`);
    assert.equal(entry.review, 'approved', `${id} is a default, so its commercial review must be approved`);
    assert.equal(entry.requiresCredential, undefined, `${id} is a default, so it must not need a credential`);
    assert.equal(entry.offlineCapable, true, `${id} is a default, so it must work with no network`);
  }
  assert.equal(defaultBasemapFor('2D'), DEFAULT_2D_BASEMAP_ID);
  assert.equal(defaultBasemapFor('3D'), DEFAULT_BASEMAP_ID);
});

test('map providers: every entry carries attribution unless it draws nothing', () => {
  for (const entry of MAP_PROVIDER_CATALOG) {
    const drawsNothing = entry.descriptor.kind === 'none' || entry.descriptor.kind === 'ellipsoid';
    if (drawsNothing) continue;
    assert.notEqual(entry.attribution, '', `${entry.id} renders imagery and must credit its source`);
  }
});

test('map providers: a conditional entry links the terms an operator has to read', () => {
  for (const entry of MAP_PROVIDER_CATALOG.filter((e) => e.review === 'conditional')) {
    assert.ok(entry.termsUrl, `${entry.id} is conditional and must link its terms`);
  }
});

test('map providers: a credential-gated entry is unavailable until the key exists, with the reason', () => {
  const without = resolveMapProviders({ credentials: [] });
  const ion = without.find((e) => e.id === 'cesium-ion-bing');
  assert.equal(ion?.available, false);
  assert.match(ion?.unavailableReason ?? '', /cesium\.ionToken/);

  const with_ = resolveMapProviders({ credentials: ['cesium.ionToken'] });
  const ionReady = with_.find((e) => e.id === 'cesium-ion-bing');
  assert.equal(ionReady?.available, true);
  assert.equal(ionReady?.unavailableReason, undefined);
});

test('map providers: the offline vector basemap needs an installed pack', () => {
  const noPack = resolveMapProviders({ offlineBasemapAvailable: false });
  const dark = noPack.find((e) => e.id === DEFAULT_2D_BASEMAP_ID);
  assert.equal(dark?.available, false);
  assert.match(dark?.unavailableReason ?? '', /world pack/i);

  const withPack = resolveMapProviders({ offlineBasemapAvailable: true });
  assert.equal(withPack.find((e) => e.id === DEFAULT_2D_BASEMAP_ID)?.available, true);
});

test('map providers: going offline leaves the zero-credential defaults selectable and nothing else network-bound', () => {
  const offline = resolveMapProviders({ online: false, offlineBasemapAvailable: true });
  assert.equal(offline.find((e) => e.id === DEFAULT_BASEMAP_ID)?.available, true);
  assert.equal(offline.find((e) => e.id === DEFAULT_TERRAIN_ID)?.available, true);
  assert.equal(offline.find((e) => e.id === DEFAULT_2D_BASEMAP_ID)?.available, true);
  for (const entry of offline.filter((e) => !e.offlineCapable)) {
    assert.equal(entry.available, false, `${entry.id} needs the network and must be unavailable offline`);
  }
});

test('map providers: resolving does not mutate the frozen catalog', () => {
  const before = JSON.stringify(MAP_PROVIDER_CATALOG);
  resolveMapProviders({ credentials: ['cesium.ionToken'], online: false, offlineBasemapAvailable: false });
  assert.equal(JSON.stringify(MAP_PROVIDER_CATALOG), before);
  assert.ok(
    MAP_PROVIDER_CATALOG.every((e) => !('available' in e)),
    'availability is resolved per call, never stored on the catalog',
  );
});
