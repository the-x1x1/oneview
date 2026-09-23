import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedItem } from '@worldview/ipc-contract';
import { rankFeed, relevance } from './feed-rank.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const item = (
  id: string,
  severity: FeedItem['severity'],
  hoursAgo: number,
  position?: FeedItem['position'],
): FeedItem => ({
  id,
  at: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  title: id,
  severity,
  type: 'weather-alert',
  ...(position ? { position } : {}),
});

test('feed relevance: a severe warning an hour old outranks a minor advisory from just now', () => {
  const ranked = rankFeed([item('minor-now', 'MINOR', 0), item('severe-1h', 'SEVERE', 1)], NOW, undefined);
  assert.deepEqual(
    ranked.map((i) => i.id),
    ['severe-1h', 'minor-now'],
  );
});

test('feed relevance: near the view counts, far away does not penalise below its own weight', () => {
  const honolulu = { latitude: 21.3, longitude: -157.9 };
  const near = item('near', 'MODERATE', 2, { latitude: 21.5, longitude: -158.0 });
  const far = item('far', 'MODERATE', 2, { latitude: 40.7, longitude: -74.0 });
  const nowhere = item('nowhere', 'MODERATE', 2);
  assert.deepEqual(
    rankFeed([far, nowhere, near], NOW, honolulu).map((i) => i.id),
    ['near', 'far', 'nowhere'],
  );
  const ratio = relevance(near, NOW, honolulu) / relevance(nowhere, NOW, honolulu);
  assert.ok(ratio > 2.9 && ratio <= 3, `near the view: nearly ×3 (${ratio.toFixed(3)})`);
  assert.ok(
    Math.abs(relevance(far, NOW, honolulu) - relevance(nowhere, NOW, honolulu)) < 0.01,
    'far is as if unplaced',
  );
});

test('feed relevance: age halves the score every six hours; a start ahead counts as now; ties go newest first', () => {
  const fresh = item('fresh', 'SEVERE', 0);
  const six = item('six', 'SEVERE', 6);
  assert.ok(Math.abs(relevance(six, NOW, undefined) / relevance(fresh, NOW, undefined) - 0.5) < 1e-9);
  assert.equal(relevance(item('ahead', 'SEVERE', -24), NOW, undefined), relevance(fresh, NOW, undefined));
  const a = item('a', 'MINOR', 1);
  const b = { ...a, id: 'b' };
  assert.deepEqual(
    rankFeed([b, a], NOW, undefined).map((i) => i.id),
    ['a', 'b'],
    'deterministic',
  );
});
