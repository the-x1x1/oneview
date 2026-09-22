import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_LADDER, budgetLadderIsMonotone, PerformanceGovernor } from './performance.js';

/** Feed n identical seconds and report how many of them moved the budget. */
function feed(g: PerformanceGovernor, fps: number, featureCount: number, seconds: number): number {
  let moves = 0;
  for (let i = 0; i < seconds; i++) if (g.sample({ fps, featureCount })) moves++;
  return moves;
}

test('ladder: every rung is cheaper than the one above it', () => {
  // A ladder with a rung that costs *more* than its predecessor would let the governor
  // step "down" into a heavier budget, go slower, step down again, and never converge.
  assert.equal(budgetLadderIsMonotone(), true);
  assert.equal(BUDGET_LADDER[0]!.detail, 0, 'the top rung is full detail');
  assert.ok(BUDGET_LADDER.length >= 3, 'a ladder needs room to walk');
  assert.equal(
    budgetLadderIsMonotone([
      { detail: 0, maxFeatures: 100 },
      { detail: 0, maxFeatures: 200 },
    ]),
    false,
    'a step down that costs more is rejected',
  );
  assert.equal(
    budgetLadderIsMonotone([
      { detail: 1, maxFeatures: 100 },
      { detail: 0, maxFeatures: 100 },
    ]),
    false,
    'so is a step down that restores detail',
  );
  assert.equal(
    budgetLadderIsMonotone([
      { detail: 0, maxFeatures: 100 },
      { detail: 0, maxFeatures: 100 },
    ]),
    false,
    'and so is a step that changes nothing',
  );
});

test('governor: starts at full detail and has not measured anything yet', () => {
  // A capable machine must never be shown a degraded world while the governor works out
  // that it is capable, so the cold start is full detail with a conservative cap.
  const g = new PerformanceGovernor();
  assert.equal(g.budget.detail, 0);
  assert.equal(g.lastMeasuredFps, null);
  assert.ok(g.budget.maxFeatures < BUDGET_LADDER[0]!.maxFeatures, 'but rung 0 is earned, not given');
});

test('governor: two slow seconds step down, six fast ones step back up', () => {
  // Plain hysteresis, with the oscillation penalty switched off so this test is about one
  // mechanism only (the penalty has a test of its own below).
  const g = new PerformanceGovernor({
    floorFps: 24,
    targetFps: 50,
    slowSamples: 2,
    fastSamples: 6,
    climbPenalty: 0,
  });
  const start = g.level;
  assert.equal(feed(g, 12, 50_000, 1), 0, 'one bad second is not evidence');
  assert.equal(g.level, start);
  assert.equal(feed(g, 12, 50_000, 1), 1, 'the second one is');
  assert.equal(g.level, start + 1);
  const dropped = g.budget;

  // Climbing back is deliberately slower than falling: a map that stutters is unusable
  // now, while a map that is one rung coarser than it needs to be for a few seconds is
  // merely imperfect.
  assert.equal(feed(g, 60, 50_000, 5), 0, 'five good seconds are not yet enough');
  assert.equal(feed(g, 60, 50_000, 1), 1);
  assert.equal(g.level, start, 'back where it started');
  assert.ok(g.budget.maxFeatures > dropped.maxFeatures || g.budget.detail < dropped.detail);
});

test('governor: the dead band between floor and target decays both runs', () => {
  const g = new PerformanceGovernor({ floorFps: 24, targetFps: 50, slowSamples: 2 });
  const start = g.level;
  feed(g, 12, 50_000, 1); // one slow second banked
  feed(g, 35, 50_000, 1); // comfortably in the dead band
  assert.equal(feed(g, 12, 50_000, 1), 0, 'the banked second did not survive a healthy one');
  assert.equal(g.level, start);
});

test('governor: a rung that keeps failing gets harder to climb back into', () => {
  // Without this the governor oscillates forever on a machine sitting exactly on the
  // boundary, and an operator watching icons turn into markers and back every few seconds
  // would much rather it picked one and stayed there. The penalty starts at the *first*
  // failure, not the second: a rung that has already proved it cannot be sustained has
  // earned some scepticism, and the cost of being wrong about that is a few extra seconds
  // at a slightly coarser picture.
  const g = new PerformanceGovernor({ floorFps: 24, targetFps: 50, slowSamples: 2, fastSamples: 3, climbPenalty: 4 });
  const start = g.level;
  feed(g, 10, 50_000, 2);
  assert.equal(g.level, start + 1, 'fell once');
  assert.equal(feed(g, 60, 50_000, 6), 0, 'the base threshold alone no longer buys the climb');
  assert.equal(feed(g, 60, 50_000, 1), 1, 'three plus one failure’s penalty does');
  assert.equal(g.level, start);

  feed(g, 10, 50_000, 2);
  assert.equal(g.level, start + 1, 'fell from the same rung a second time');
  assert.equal(feed(g, 60, 50_000, 10), 0, 'and the price has gone up again');
  assert.equal(feed(g, 60, 50_000, 1), 1);
  assert.equal(g.level, start);
});

test('governor: the escalating climb is capped, so a rung never becomes unreachable', () => {
  const g = new PerformanceGovernor({
    floorFps: 24,
    targetFps: 50,
    slowSamples: 1,
    fastSamples: 2,
    climbPenalty: 4,
    maxClimbPenalty: 8,
  });
  const start = g.level;
  for (let i = 0; i < 12; i++) {
    feed(g, 10, 50_000, 1);
    feed(g, 60, 50_000, 40);
  }
  assert.ok(g.level <= start, 'however many times it has failed, enough good seconds still win');
});

test('governor: will not cut a budget the view is not using', () => {
  // A view holding forty features at ten frames a second is slow for a reason the feature
  // budget cannot fix — an imagery or terrain stall, another window on the GPU. Stepping
  // down there costs the operator objects and buys nothing, and worse, it strands the
  // governor at the bottom of a ladder it has no way to climb back up.
  const g = new PerformanceGovernor({ floorFps: 24, slowSamples: 2 });
  const start = g.level;
  assert.equal(feed(g, 4, 40, 20), 0);
  assert.equal(g.level, start, 'a light view that is slow anyway is left alone');
});

test('governor: the ladder ends rather than emptying the screen', () => {
  const g = new PerformanceGovernor({ floorFps: 24, slowSamples: 1 });
  feed(g, 1, 200_000, 100);
  assert.equal(g.level, BUDGET_LADDER.length - 1, 'it walks to the bottom');
  const floor = g.budget;
  assert.ok(floor.maxFeatures > 0, 'and the bottom still draws something');
  assert.equal(floor.maxFeatures, BUDGET_LADDER[BUDGET_LADDER.length - 1]!.maxFeatures);
});

test('governor: the renderer capability caps every rung', () => {
  const g = new PerformanceGovernor({ featureCeiling: 5_000 });
  assert.equal(g.budget.maxFeatures, 5_000);
  feed(g, 60, 4_000, 100);
  assert.equal(g.level, 0, 'it still climbs to the top rung');
  assert.equal(g.budget.maxFeatures, 5_000, 'but never asks for more than the renderer can take');
  g.setFeatureCeiling(Number.NaN);
  assert.equal(g.budget.maxFeatures, BUDGET_LADDER[0]!.maxFeatures, 'an unusable ceiling is no ceiling');
});

test('governor: an unmeasurable second is ignored, and a reset keeps the rung', () => {
  const g = new PerformanceGovernor({ slowSamples: 2 });
  const start = g.level;
  assert.equal(g.sample({ fps: Number.NaN, featureCount: 50_000 }), false);
  assert.equal(g.sample({ fps: -1, featureCount: 50_000 }), false);
  assert.equal(g.lastMeasuredFps, null, 'nothing was measured');
  feed(g, 5, 50_000, 1);
  g.resetRuns();
  assert.equal(feed(g, 5, 50_000, 1), 0, 'the banked slow second is gone');
  assert.equal(g.level, start, 'but the rung it had settled on is not');
});

test('governor: rejects a configuration it cannot work with', () => {
  assert.throws(() => new PerformanceGovernor({ ladder: [] }), TypeError);
  assert.throws(() => new PerformanceGovernor({ floorFps: 50, targetFps: 50 }), TypeError);
});
