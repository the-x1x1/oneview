import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { withSelection } from './selection-objects.js';

const obj = (id: string, position = true): WorldObject =>
  ({
    id,
    type: 'satellite',
    labels: {},
    properties: {},
    ...(position ? { position: { latitude: 1, longitude: 2, altitudeM: 418_000 } } : {}),
  }) as unknown as WorldObject;

test('the selection is presented even when the subscription does not hold it', () => {
  const held = new Map([['a', obj('a')]]);
  const iss = obj('satellite:norad:25544');
  const ids = (it: Iterable<WorldObject>) => [...it].map((o) => o.id);
  assert.deepEqual(ids(withSelection(held.values(), { objects: held, selectedId: iss.id, selectedObject: iss })), [
    'a',
    iss.id,
  ]);
  const both = new Map([...held, [iss.id, iss]]);
  assert.deepEqual(
    ids(withSelection(both.values(), { objects: both, selectedId: iss.id, selectedObject: iss })),
    ['a', iss.id],
    'not twice when held',
  );
  assert.deepEqual(ids(withSelection(held.values(), { objects: held, selectedId: null, selectedObject: null })), ['a']);
  const nowhere = obj('x', false);
  assert.deepEqual(
    ids(withSelection(held.values(), { objects: held, selectedId: 'x', selectedObject: nowhere })),
    ['a'],
    'nothing to draw without a position',
  );
});
