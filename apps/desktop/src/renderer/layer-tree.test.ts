import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lensById } from '@worldview/render-core';
import type { WorldObject } from '@worldview/world-model';
import type { SourceHealthEntry } from '@worldview/source-health';
import { DEFAULT_SETTINGS } from '@worldview/config';
import { OVERVIEW_LAYERS, lensFilter, typeLayerId } from './overview-layers.js';
import {
  CAMERA_PREVIEWS_LAYER_ID,
  LAYER_GROUPS,
  MILITARY_ONLY_LAYER_ID,
  OPT_IN_LAYER_IDS,
  allLayersHidden,
  compactCount,
  inBounds,
  layerOn,
  layerTreeCounts,
  objectFilter,
  onlyLayerHidden,
  sourcesNeedingKey,
} from './layer-tree.js';

const overview = lensById('overview')!;

/** An invented object: only the fields the tree reads. */
function obj(
  id: string,
  type: string,
  lat: number,
  lon: number,
  properties: Record<string, unknown> = {},
): WorldObject {
  return { id, type, position: { latitude: lat, longitude: lon }, properties } as unknown as WorldObject;
}

test('layer tree: a group per Overview category, a row per type, the two children where they belong', () => {
  assert.deepEqual(
    LAYER_GROUPS.map((g) => g.id),
    OVERVIEW_LAYERS.map((l) => l.id),
  );
  const aviation = LAYER_GROUPS.find((g) => g.id === 'aviation')!;
  assert.deepEqual(
    aviation.layers.map((l) => l.id),
    ['type.aircraft', 'type.airport'],
  );
  assert.deepEqual(
    aviation.layers[0]!.children.map((c) => c.id),
    [MILITARY_ONLY_LAYER_ID],
  );
  const cameras = LAYER_GROUPS.find((g) => g.id === 'infrastructure')!.layers.find((l) => l.objectType === 'camera')!;
  assert.equal(cameras.name, 'Public cameras');
  assert.deepEqual(
    cameras.children.map((c) => c.id),
    [CAMERA_PREVIEWS_LAYER_ID],
  );
  // The two opt-in switches are off in a new installation's settings, everything else on.
  assert.deepEqual([...DEFAULT_SETTINGS.hiddenLayers].sort(), [...OPT_IN_LAYER_IDS].sort());
  for (const g of LAYER_GROUPS) assert.ok(layerOn(DEFAULT_SETTINGS.hiddenLayers, g.id), g.id);
  assert.equal(layerOn(DEFAULT_SETTINGS.hiddenLayers, CAMERA_PREVIEWS_LAYER_ID), false);
});

test('layer tree: a type switched off is gone whichever categories show it; categories work as before', () => {
  const f = lensFilter(overview, [typeLayerId('airport')]);
  assert.equal(f.objectTypes.has('airport'), false, 'shared by three categories, off in all of them');
  assert.equal(f.objectTypes.has('aircraft'), true);
  const both = lensFilter(overview, ['space', typeLayerId('vessel'), ...OPT_IN_LAYER_IDS]);
  assert.equal(both.objectTypes.has('satellite'), false);
  assert.equal(both.objectTypes.has('vessel'), false);
  assert.equal(both.objectTypes.has('port'), true);
  // Another lens is its own filter: the Overview's switches do not reach it.
  assert.ok(lensFilter(lensById('aviation')!, [typeLayerId('airport')]).objectTypes.has('airport'));
});

test('layer tree: military only lets through military aircraft and everything that is not an aircraft', () => {
  assert.equal(objectFilter(DEFAULT_SETTINGS.hiddenLayers), undefined, 'off by default: no per-object work at all');
  const keep = objectFilter([CAMERA_PREVIEWS_LAYER_ID])!;
  assert.equal(keep(obj('a', 'aircraft', 0, 0, { military: true })), true);
  assert.equal(keep(obj('b', 'aircraft', 0, 0, { military: 'true' })), true);
  assert.equal(keep(obj('c', 'aircraft', 0, 0)), false);
  assert.equal(keep(obj('d', 'vessel', 0, 0)), true);
});

test('layer tree: counts in view and on hand, per type, per child and per group', () => {
  const objects = [
    obj('a1', 'aircraft', 10, 10, { military: true }),
    obj('a2', 'aircraft', 10, 10),
    obj('a3', 'aircraft', 50, 100),
    obj('p1', 'airport', 11, 11),
    obj('c1', 'camera', 10, 179.5),
  ];
  const bounds = { west: 0, south: 0, east: 20, north: 20 };
  const counts = layerTreeCounts(objects, bounds);
  assert.deepEqual(counts.get('type.aircraft'), { total: 3, inView: 2 });
  assert.deepEqual(counts.get(MILITARY_ONLY_LAYER_ID), { total: 1, inView: 1 });
  assert.deepEqual(counts.get('aviation'), { total: 4, inView: 3 });
  assert.deepEqual(counts.get('type.camera'), { total: 1, inView: 0 });
  assert.deepEqual(counts.get('maritime'), { total: 0, inView: 0 });
  // A view across the antimeridian.
  const wrapped = layerTreeCounts(objects, { west: 170, south: 0, east: -170, north: 20 });
  assert.deepEqual(wrapped.get('type.camera'), { total: 1, inView: 1 });
  // The whole world in view: everything on hand is in view.
  assert.deepEqual(layerTreeCounts(objects, undefined).get('aviation'), { total: 4, inView: 4 });
  assert.equal(inBounds({ latitude: 0, longitude: 190 }, { west: 170, south: -1, east: -160, north: 1 }), true);
});

test('layer tree: show every / hide every / only this leave the opt-in children as they are', () => {
  const hidden = ['space', typeLayerId('airport'), CAMERA_PREVIEWS_LAYER_ID];
  assert.deepEqual(allLayersHidden(hidden, true), [CAMERA_PREVIEWS_LAYER_ID]);
  const none = allLayersHidden(hidden, false);
  for (const l of OVERVIEW_LAYERS) assert.ok(none.includes(l.id), l.id);
  assert.ok(none.includes(CAMERA_PREVIEWS_LAYER_ID) && !none.includes(MILITARY_ONLY_LAYER_ID));
  assert.equal(new Set(none).size, none.length, 'no duplicates');
  const only = onlyLayerHidden(hidden, 'space');
  assert.ok(!only.includes('space') && only.includes('aviation'));
  assert.ok(only.includes(typeLayerId('airport')) && only.includes(CAMERA_PREVIEWS_LAYER_ID));
});

test('layer tree: sources that need a key are listed under their category, on or off', () => {
  const entry = (providerId: string, over: Partial<SourceHealthEntry['health']>, keys: string[]) =>
    ({
      providerId,
      name: providerId,
      categories: ['maritime'],
      enabled: false,
      health: { status: 'DISABLED', credentialState: 'not-required', ...over },
      meta: { credentialsRequired: keys },
    }) as unknown as SourceHealthEntry;
  const entries = [
    entry('ais-key', { credentialState: 'missing' }, ['aisstream.key']),
    entry('ais-auth', { status: 'AUTH_REQUIRED', credentialState: 'present' }, ['x']),
    entry('ais-ok', { status: 'LIVE', credentialState: 'present' }, ['y']),
    entry('keyless', { status: 'LIVE' }, []),
  ];
  assert.deepEqual(
    sourcesNeedingKey(entries, 'maritime').map((e) => e.providerId),
    ['ais-key', 'ais-auth'],
  );
  assert.deepEqual(sourcesNeedingKey(entries, 'aviation'), []);
});

test('layer tree: compact counts fit the rail', () => {
  assert.deepEqual([0, 999, 1000, 1234, 12_345, 1_250_000].map(compactCount), [
    '0',
    '999',
    '1k',
    '1.2k',
    '12k',
    '1.3M',
  ]);
});
