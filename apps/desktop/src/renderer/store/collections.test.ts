import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionItem } from '@worldview/ipc-contract';
import { isCollected } from './collections.js';

const at = '2026-09-23T00:00:00.000Z';
const items: CollectionItem[] = [
  { id: 'i1', kind: 'object', title: 'M 5.1', objectId: 'earthquake:usgs:us1', createdAt: at, updatedAt: at },
  { id: 'i2', kind: 'event', title: 'Alert', eventId: 'event:worldview:e1', createdAt: at, updatedAt: at },
  {
    id: 'i3',
    kind: 'location',
    title: '21.3, -157.9',
    position: { latitude: 21.3, longitude: -157.9 },
    createdAt: at,
    updatedAt: at,
  },
];

test('a selection already in the collection is recognised, object or event; nothing selected is not', () => {
  assert.equal(isCollected(items, 'earthquake:usgs:us1'), true);
  assert.equal(isCollected(items, 'event:worldview:e1'), true);
  assert.equal(isCollected(items, 'earthquake:usgs:us2'), false);
  assert.equal(isCollected(items, null), false);
  assert.equal(isCollected([], 'earthquake:usgs:us1'), false);
});
