import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureUpdate, RenderFeature } from '@worldview/render-core';
import { FeatureFeed } from './feature-feed.js';

const pt = (id: string, lat: number): RenderFeature => ({
  id,
  geometry: { kind: 'point', position: { latitude: lat, longitude: 0 } },
  style: { styleClass: 'satellite' },
  interactive: true,
  priority: 30,
  layer: 'satellite',
});

/** A renderer that just records what it was told, in order. */
function sinkModel() {
  const state = new Map<string, RenderFeature>();
  const calls: FeatureUpdate[] = [];
  const sink = (u: FeatureUpdate) => {
    calls.push(u);
    for (const id of u.remove) state.delete(id);
    for (const f of u.upsert) state.set(f.id, f);
  };
  return { state, calls, sink };
}

test('feature feed: a five-thousand-feature refresh is spread over frames, not dumped in one', () => {
  // What the operator's perf log showed: all ~5,000 satellites move every fifteen seconds,
  // and applying that as one update cost a 15–37 ms frame. Sliced, no frame carries it all.
  let clock = 0;
  const { state, calls, sink } = sinkModel();
  // Each chunk "costs" 2 ms of renderer time.
  const feed = new FeatureFeed(
    (u) => {
      sink(u);
      clock += 2;
    },
    { chunk: 500, budgetMs: 6, now: () => clock },
  );
  feed.enqueue({ upsert: Array.from({ length: 5000 }, (_, i) => pt(`sat:${i}`, i % 90)), remove: [] });
  const frames: number[] = [];
  while (feed.backlog > 0) frames.push(feed.drain().applied);
  assert.equal(state.size, 5000, 'everything arrives');
  assert.ok(frames.length >= 3, `spread over ${frames.length} frames`);
  assert.ok(Math.max(...frames) <= 1500, `no frame applies more than the budget allows: ${frames.join(', ')}`);
  assert.ok(calls.every((c) => c.upsert.length + c.remove.length <= 500));
});

test('feature feed: latest wins per id, so a lagging drain is late but never wrong', () => {
  const { state, sink } = sinkModel();
  const feed = new FeatureFeed(sink, { chunk: 2, budgetMs: 0 });
  feed.enqueue({ upsert: [pt('a', 1), pt('b', 1), pt('c', 1)], remove: [] });
  feed.drain(); // one chunk of two goes
  assert.equal(feed.backlog, 1);

  // A newer pass arrives before the rest is drained: `a` moves again, `c` is removed, `d` is new.
  feed.enqueue({ upsert: [pt('a', 2), pt('d', 1)], remove: ['c'] });
  while (feed.backlog > 0) feed.drain();
  assert.deepEqual([...state.keys()].sort(), ['a', 'b', 'd'], 'c was removed before it was ever sent');
  assert.equal(
    (state.get('a')!.geometry as { position: { latitude: number } }).position.latitude,
    2,
    'a is at its latest position',
  );

  // Queued then removed: the renderer is told to remove an id it never had, which both
  // adapters treat as a no-op — and it is not left holding a stale copy.
  feed.enqueue({ upsert: [pt('e', 1)], remove: [] });
  feed.enqueue({ upsert: [], remove: ['e'] });
  feed.flush();
  assert.equal(state.has('e'), false);
});

test('feature feed: at least one chunk goes per frame, however small the budget', () => {
  // A budget of zero must not stall the queue forever on a slow machine.
  const { state, sink } = sinkModel();
  const feed = new FeatureFeed(sink, { chunk: 10, budgetMs: 0, now: () => 1e9 });
  feed.enqueue({ upsert: Array.from({ length: 25 }, (_, i) => pt(`x${i}`, 0)), remove: [] });
  assert.equal(feed.drain().applied, 10);
  assert.equal(feed.drain().applied, 10);
  assert.equal(feed.drain().applied, 5);
  assert.equal(state.size, 25);
  assert.equal(feed.drain().applied, 0, 'an empty queue does nothing');
});

test('feature feed: an id that keeps changing does not starve the ones behind it', () => {
  const { calls, sink } = sinkModel();
  const feed = new FeatureFeed(sink, { chunk: 1, budgetMs: 0 });
  feed.enqueue({ upsert: [pt('busy', 0), pt('quiet', 0)], remove: [] });
  feed.enqueue({ upsert: [pt('busy', 1)], remove: [] }); // busy moves to the back
  feed.drain();
  assert.equal(calls[0]!.upsert[0]!.id, 'quiet', 'the id queued earlier goes first');
});
