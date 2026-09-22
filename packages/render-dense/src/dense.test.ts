import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWorldRenderer, type RenderFeature } from '@worldview/render-core';
import { DEFAULT_DENSE_CAPS, DenseBudget, NativeDenseAdapter } from './dense.js';
import { mulberry32, runPresentationBenchmark, syntheticObjects } from './benchmark.js';

const f = (i: number, layer = 'fire', priority = i % 5): RenderFeature => ({
  id: `f${i}`,
  geometry: { kind: 'point', position: { latitude: i * 0.001, longitude: 0 } },
  style: { styleClass: layer },
  interactive: true,
  priority,
  layer,
});

test('dense budget: caps per band, keeps highest priority (stable by id), scales under low power', () => {
  const budget = new DenseBudget({ local: 10 });
  assert.equal(budget.capFor('global'), DEFAULT_DENSE_CAPS.global);
  assert.equal(budget.capFor('local'), 10);
  const many = Array.from({ length: 25 }, (_, i) => f(i));
  const r = budget.apply(many, 'local');
  assert.equal(r.kept.length, 10);
  assert.equal(r.dropped, 15);
  assert.ok(
    r.kept.every((k) => k.priority >= 3),
    'lowest priorities dropped first',
  );
  assert.deepEqual(
    r.kept.map((k) => k.id),
    budget.apply([...many].reverse(), 'local').kept.map((k) => k.id),
    'order-independent',
  );
  assert.deepEqual(budget.apply(many.slice(0, 5), 'local'), { kept: many.slice(0, 5), dropped: 0, cap: 10 });
  assert.equal(budget.scaled(0.5).capFor('local'), 5);
  assert.equal(new DenseBudget().scaled(0.5).capFor('global'), DEFAULT_DENSE_CAPS.global / 2);
  assert.equal(
    new DenseBudget().scaled(0).capFor('local'),
    Math.round(DEFAULT_DENSE_CAPS.local * 0.05),
    'never scales to zero',
  );
});

test('native dense adapter: replaces the layer wholesale on the active renderer within budget; reports support by count', () => {
  const renderer = new FakeWorldRenderer('2D');
  const adapter = new NativeDenseAdapter({
    kind: 'points',
    renderer,
    layer: 'fire',
    budget: new DenseBudget({ local: 3 }),
    nativeLimit: 100,
  });
  assert.equal(adapter.supports(100), true);
  assert.equal(
    adapter.supports(101),
    false,
    'above the native limit the host should look for a dense renderer (deck.gl) — none today',
  );
  renderer.update({ upsert: [f(99, 'fire', 0), f(100, 'aircraft', 9)], remove: [] });
  adapter.update([f(1), f(2), f(3), f(4), f(5, 'aircraft')]);
  assert.deepEqual(renderer.updates.at(-1)!.replaceLayers, ['fire']);
  assert.equal(adapter.last!.dropped, 1);
  assert.equal(renderer.features.has('f99'), false, 'previous fire features replaced');
  assert.equal(renderer.features.has('f100'), true, 'other layers untouched');
  assert.equal([...renderer.features.values()].filter((x) => x.layer === 'fire').length, 3);
  adapter.dispose();
  assert.equal([...renderer.features.values()].filter((x) => x.layer === 'fire').length, 0);
  adapter.update([f(1)]);
  assert.equal(renderer.features.has('f1'), false, 'disposed adapter is inert');
});

test('benchmark harness: deterministic synthetic objects and a well-formed report at small sizes', () => {
  const a = syntheticObjects(50, 7),
    b = syntheticObjects(50, 7);
  assert.deepEqual(a, b);
  assert.notDeepEqual(syntheticObjects(50, 8), a);
  const r1 = mulberry32(3),
    r2 = mulberry32(3);
  assert.equal(r1(), r2());
  let t = 0;
  const report = runPresentationBenchmark({ sizes: [200, 1_000], iterations: 2, now: () => (t += 0.5) });
  assert.equal(report.cases.length, 6);
  for (const c of report.cases) {
    assert.ok(c.features > 0, `${c.objects}@${c.band} produced features`);
    assert.ok(c.present.medianMs >= 0 && c.diff.medianMs >= 0);
    assert.ok(c.changedFeatures >= 0);
  }
  const globalCase = report.cases.find((c) => c.band === 'global' && c.objects === 1_000)!;
  // The overview draws every object as its own point — no heatmap and no bubbles — so the
  // benchmark's global band now measures exactly one feature per object, which is the cost
  // the renderers have to carry and the reason presentation must not re-run per frame.
  assert.equal(globalCase.density, 0, 'no heatmap');
  assert.equal(globalCase.clustered, 0, 'no bubbles');
  assert.equal(globalCase.features, globalCase.objects, 'one dot per object');
  assert.ok(report.workerThresholdRecommendation >= 1_000 && report.workerThresholdRecommendation <= 5_000);
});
