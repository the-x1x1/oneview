import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWindow, moveActiveIndex, scrollTopForIndex } from './virtual-math.js';

test('computeWindow: empty list and zero heights', () => {
  assert.deepEqual(computeWindow({ itemCount: 0, itemHeight: 32, viewportHeight: 400, scrollTop: 0 }), {
    start: 0,
    end: 0,
    totalHeight: 0,
    offsetY: 0,
  });
  assert.deepEqual(computeWindow({ itemCount: 10, itemHeight: 0, viewportHeight: 400, scrollTop: 0 }), {
    start: 0,
    end: 0,
    totalHeight: 0,
    offsetY: 0,
  });
});

test('computeWindow: renders viewport rows plus overscan and clamps scroll', () => {
  const w = computeWindow({ itemCount: 1000, itemHeight: 32, viewportHeight: 320, scrollTop: 3200, overscan: 2 });
  assert.equal(w.totalHeight, 32_000);
  assert.equal(w.start, 98); // 100 - overscan
  assert.equal(w.end, 100 + 10 + 1 + 2);
  assert.equal(w.offsetY, 98 * 32);
  const top = computeWindow({ itemCount: 1000, itemHeight: 32, viewportHeight: 320, scrollTop: -50, overscan: 2 });
  assert.equal(top.start, 0);
  const bottom = computeWindow({
    itemCount: 1000,
    itemHeight: 32,
    viewportHeight: 320,
    scrollTop: 10_000_000,
    overscan: 2,
  });
  assert.equal(bottom.end, 1000);
  assert.ok(bottom.start >= 1000 - 13 - 2);
  const small = computeWindow({ itemCount: 3, itemHeight: 32, viewportHeight: 320, scrollTop: 0 });
  assert.deepEqual([small.start, small.end], [0, 3]);
});

test('scrollTopForIndex: nearest keeps scroll when visible, else minimal move', () => {
  assert.equal(scrollTopForIndex(5, 32, 320, 0), 0);
  assert.equal(scrollTopForIndex(20, 32, 320, 0), 21 * 32 - 320);
  assert.equal(scrollTopForIndex(2, 32, 320, 500), 64);
  assert.equal(scrollTopForIndex(7, 32, 320, 500, 'start'), 224);
});

test('moveActiveIndex: arrows, paging, home/end and bounds', () => {
  assert.equal(moveActiveIndex(-1, 0, 'ArrowDown'), -1);
  assert.equal(moveActiveIndex(-1, 5, 'ArrowDown'), 0);
  assert.equal(moveActiveIndex(4, 5, 'ArrowDown'), 4);
  assert.equal(moveActiveIndex(-1, 5, 'ArrowUp'), 0);
  assert.equal(moveActiveIndex(3, 5, 'ArrowUp'), 2);
  assert.equal(moveActiveIndex(1, 50, 'PageDown', 10), 11);
  assert.equal(moveActiveIndex(1, 50, 'PageUp', 10), 0);
  assert.equal(moveActiveIndex(30, 50, 'Home'), 0);
  assert.equal(moveActiveIndex(30, 50, 'End'), 49);
  assert.equal(moveActiveIndex(30, 50, 'a'), 30);
});
