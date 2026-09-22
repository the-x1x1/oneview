import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPresentationBenchmark, syntheticObjects } from './benchmark.js';

/**
 * The benchmark's headline number ends up in the architecture notes and the threat
 * model, so what it measures is checked here rather than trusted. It used to be derived
 * from the `present` median alone while being labelled a frame budget, which overstated
 * it by roughly the cost of the diff.
 */
test('benchmark: the frame budget counts the whole in-thread update, not just present', () => {
  const report = runPresentationBenchmark({ sizes: [1000, 10000], iterations: 3 });
  assert.ok(report.cases.length > 0);

  for (const c of report.cases) {
    assert.ok(c.frame.medianMs > 0, `${c.objects}/${c.band} frame was not measured`);
    assert.ok(c.present.medianMs > 0 && c.diff.medianMs > 0, 'present and diff are measured separately');
  }

  const locals = report.cases.filter((c) => c.band === 'local');
  const withinBudget = locals.filter((c) => c.frame.medianMs <= 16.7).map((c) => c.objects);
  const expected = withinBudget.length ? Math.max(...withinBudget) : 0;
  assert.equal(
    report.frameBudgetObjectsLocal,
    expected,
    'the budget is the largest local set whose frame fits 16.7 ms',
  );

  // Every size the budget claims must actually have been measured within it.
  const claimed = locals.find((c) => c.objects === report.frameBudgetObjectsLocal);
  if (report.frameBudgetObjectsLocal > 0) {
    assert.ok(claimed, 'the claimed size was measured');
    assert.ok(claimed.frame.medianMs <= 16.7, `claimed ${claimed.objects} objects at ${claimed.frame.medianMs} ms`);
  }

  assert.ok(report.workerThresholdRecommendation >= 1000 && report.workerThresholdRecommendation <= 5000);
});

test('benchmark: the synthetic set is deterministic, so two runs are comparable', () => {
  const a = syntheticObjects(200, 7);
  const b = syntheticObjects(200, 7);
  assert.equal(a.length, 200);
  assert.deepEqual(
    a.map((o) => o.id),
    b.map((o) => o.id),
  );
  assert.deepEqual(
    a.map((o) => o.position?.latitude),
    b.map((o) => o.position?.latitude),
  );
  // Ids are positional by design (so two runs diff cleanly); the seed varies the world.
  assert.notDeepEqual(
    a.map((o) => o.position?.latitude),
    syntheticObjects(200, 8).map((o) => o.position?.latitude),
    'a different seed is a different set',
  );
});
