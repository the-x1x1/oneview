import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('catalog: every review label matches the licence record it claims to come from', () => {
  // `MapProviderEntry.review` documents itself as "Commercial review state from
  // config/licenses" — and one entry disagreed with the file it names. Re:Earth terrain is
  // recorded there as approved and planned as a default; the catalog called it conditional,
  // which is the direction that quietly keeps a flat globe. A label that cites a source and
  // is not checked against it is worth less than no label, so this checks it.
  const records = new Map<string, { commercialReview: string }>(
    (
      JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'licenses', 'providers.json'), 'utf8')) as {
        records: Array<{ providerId: string; commercialReview: string }>;
      }
    ).records.map((r) => [r.providerId, r]),
  );
  // Catalog ids are per rendering stack; licence records are per data source, so one record
  // can back two entries (ion imagery and ion terrain). Entries with no record are bundled
  // assets or app-local styles and are not third-party data.
  const backing: Record<string, string> = {
    'natural-earth': 'natural-earth',
    'esri-world-imagery': 'esri-world-imagery',
    'cesium-ion-bing': 'cesium-ion',
    'cesium-ion-world-terrain': 'cesium-ion',
    'reearth-terrain': 'reearth-terrain-mapterhorn',
  };
  for (const [catalogId, providerId] of Object.entries(backing)) {
    const entry = MAP_PROVIDER_CATALOG.find((e) => e.id === catalogId);
    assert.ok(entry, `${catalogId} is no longer in the catalog — update this mapping`);
    const record = records.get(providerId);
    assert.ok(record, `no licence record for ${providerId}`);
    assert.equal(
      entry.review,
      record.commercialReview,
      `${catalogId} is marked "${entry.review}" but ${providerId} is recorded as "${record.commercialReview}"`,
    );
  }
});
