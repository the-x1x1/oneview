import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionFromPointer, splitValueText } from './imagery-compare.js';

test('imagery divider: the pointer over the map box gives the position, clamped; no box, none', () => {
  assert.equal(positionFromPointer(300, { left: 100, width: 800 }), 0.25);
  assert.equal(positionFromPointer(50, { left: 100, width: 800 }), 0);
  assert.equal(positionFromPointer(2000, { left: 100, width: 800 }), 1);
  assert.equal(positionFromPointer(300, { left: 0, width: 0 }), undefined);
  assert.equal(positionFromPointer(Number.NaN, { left: 0, width: 800 }), undefined);
});

test('imagery divider: the handle says what each side holds and how much of the map it has', () => {
  const candidates = [{ providerId: 'snpp', name: 'True colour (VIIRS SNPP)' }];
  assert.equal(
    splitValueText({ left: null, right: 'snpp', position: 0.3 }, candidates),
    'Map only 30 percent, True colour (VIIRS SNPP) 70 percent',
  );
});
