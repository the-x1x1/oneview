import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldGeometry } from '@worldview/world-model';
import type { FeatureUpdate, RenderFeature } from '@worldview/render-core';
import { NO_TOOL_LAYER, selectionPosition, sendToolLayer, type ToolLayerShown } from './tool-layers.js';

const f = (id: string): RenderFeature => ({
  id,
  geometry: { kind: 'point', position: { latitude: 0, longitude: 0 } },
  style: { styleClass: 'graticule.label' },
  interactive: false,
  priority: 1,
  layer: 'graticule',
});

test('a tool layer is sent once per key, takes off only its own stale features, and starts over on a new host', () => {
  const sent: FeatureUpdate[] = [];
  const host = { setFeatures: (u: FeatureUpdate) => sent.push(u) };
  const shown = { current: NO_TOOL_LAYER as ToolLayerShown };
  let builds = 0;
  const build = (ids: string[]) => () => {
    builds++;
    return ids.map(f);
  };
  assert.equal(sendToolLayer(host, shown, 'a', build(['g:1', 'g:2'])), true);
  assert.equal(
    sendToolLayer(host, shown, 'a', build(['g:1', 'g:2'])),
    false,
    'the same key: nothing sent, nothing built',
  );
  assert.equal(builds, 1);
  sendToolLayer(host, shown, 'b', build(['g:2', 'g:3']));
  assert.deepEqual(sent[1]!.remove, ['g:1']);
  assert.deepEqual(
    sent[1]!.upsert.map((x) => x.id),
    ['g:2', 'g:3'],
  );
  sendToolLayer(host, shown, '', build(['never']));
  assert.deepEqual(sent[2], { upsert: [], remove: ['g:2', 'g:3'] }, 'an empty key takes the layer off');
  assert.equal(builds, 2, 'and builds nothing');

  const rebuilt = { setFeatures: (u: FeatureUpdate) => sent.push(u) };
  sendToolLayer(rebuilt, shown, '', build([]));
  sendToolLayer(rebuilt, shown, 'b', build(['g:2']));
  assert.deepEqual(sent.at(-1), { upsert: [f('g:2')], remove: [] }, 'a new host is sent everything again');
  assert.equal(sendToolLayer({}, shown, 'c', build([])), false, 'a host that takes no features');
});

test('the selection: an object where it is, an event at the middle of its geometry, nothing otherwise', () => {
  const objects = new Map([
    ['a', { position: { latitude: 1, longitude: 2 } }],
    ['b', {}],
  ]);
  const events = new Map<string, { geometry?: WorldGeometry }>([
    [
      'e',
      {
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [0, 0],
              [2, 0],
              [2, 2],
              [0, 2],
              [0, 0],
            ],
          ],
        },
      },
    ],
  ]);
  assert.deepEqual(selectionPosition({ selectedId: 'a', selectedKind: 'object', objects, events }), {
    latitude: 1,
    longitude: 2,
  });
  assert.equal(selectionPosition({ selectedId: 'b', selectedKind: 'object', objects, events }), undefined);
  const e = selectionPosition({ selectedId: 'e', selectedKind: 'event', objects, events })!;
  assert.ok(Math.abs(e.latitude - 1) < 0.2 && Math.abs(e.longitude - 1) < 0.2);
  assert.equal(selectionPosition({ selectedId: null, selectedKind: null, objects, events }), undefined);
});
