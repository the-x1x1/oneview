import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedRetention, keepWeightiest } from './feed-weight.js';

const H = 3_600_000;
const at = (h: number) => new Date(Date.UTC(2026, 9, 4, 12) + h * H).toISOString();

test('feedRetention: severity doubles the weight, six hours of age halves it', () => {
  const minorNow = feedRetention({ at: at(0), severity: 'MINOR' });
  assert.equal(feedRetention({ at: at(0), severity: 'MODERATE' }) - minorNow, 1);
  assert.equal(minorNow - feedRetention({ at: at(-6), severity: 'MINOR' }), 1);
  // EXTREME eighteen hours old weighs what MINOR does now.
  assert.equal(feedRetention({ at: at(-18), severity: 'EXTREME' }), minorNow);
  assert.equal(feedRetention({ at: 'not a time', severity: 'EXTREME' }), Number.NEGATIVE_INFINITY);
});

test('keepWeightiest: keeps the weightiest, returns them newest first, independent of input order', () => {
  const entries = [
    { id: 'a', at: at(0), severity: 'MINOR' as const },
    { id: 'b', at: at(-1), severity: 'MINOR' as const },
    { id: 'c', at: at(-10), severity: 'EXTREME' as const },
    { id: 'd', at: at(-2), severity: 'INFO' as const },
    { id: 'e', at: 'bad', severity: 'EXTREME' as const },
  ];
  assert.deepEqual(
    keepWeightiest(entries, 3).map((e) => e.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    keepWeightiest([...entries].reverse(), 3).map((e) => e.id),
    ['a', 'b', 'c'],
  );
  // Under the bound everything is kept, in time order; the unreadable time last.
  assert.deepEqual(
    keepWeightiest(entries, 10).map((e) => e.id),
    ['a', 'b', 'd', 'c', 'e'],
  );
  assert.deepEqual(keepWeightiest(entries, 0), []);
});
