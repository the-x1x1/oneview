import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeLongTask, clearDeltaMarks, markDelta } from './delta-marks.js';

test('delta marks: a long task is attributed to the delta that arrived inside it', () => {
  clearDeltaMarks();
  markDelta(5_000, 1_100);
  markDelta(12, 5_000);
  // Received at 1,100 in a task that ran 1,000–1,125: 100 ms before the handler was called.
  assert.deepEqual(attributeLongTask({ startTime: 1_000, duration: 125 }), {
    kind: 'delta',
    objects: 5_000,
    receiveMs: 100,
  });
  assert.deepEqual(attributeLongTask({ startTime: 4_990, duration: 60 }), {
    kind: 'delta',
    objects: 12,
    receiveMs: 10,
  });
  // React rendering after the delta runs in a task of its own.
  assert.deepEqual(attributeLongTask({ startTime: 1_140, duration: 80 }), { kind: 'other' });
});

test('delta marks: only the recent past is kept', () => {
  clearDeltaMarks();
  for (let i = 0; i < 40; i++) markDelta(i, i * 1_000);
  assert.deepEqual(attributeLongTask({ startTime: 0, duration: 10 }), { kind: 'other' }, 'long gone');
  assert.equal(attributeLongTask({ startTime: 39_000, duration: 10 }).kind, 'delta');
});
