import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkReport } from '@worldview/render-dense';
import { evaluatePresentation, measurePlaceSearch, median, parseBudgets, syntheticPlaces } from './budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('the budgets file parses, and its first line is the product budget: 10,000 objects in one 60 fps frame', () => {
  const b = parseBudgets(JSON.parse(readFileSync(path.join(root, 'config', 'perf-budgets.json'), 'utf8')));
  assert.deepEqual(b.presentation.cases[0], { objects: 10_000, band: 'local', frameMedianMs: 16.7, measured: 4.4 });
  for (const c of b.presentation.cases)
    if (c.measured !== undefined) assert.ok(c.frameMedianMs >= c.measured * 2, `${c.objects}/${c.band}: headroom`);
  assert.ok(b.placeSearch && b.placeSearch.entries === 100_000);
});

test('a malformed budget is an error, never a pass', () => {
  const ok = { presentation: { iterations: 5, cases: [{ objects: 10, band: 'local', frameMedianMs: 1 }] } };
  assert.doesNotThrow(() => parseBudgets(ok));
  const bad = (patch: unknown) => () => parseBudgets({ presentation: { ...ok.presentation, ...(patch as object) } });
  assert.throws(bad({ iterations: 1 }), /iterations/);
  assert.throws(bad({ cases: [] }), /non-empty/);
  assert.throws(bad({ cases: [{ objects: 10, band: 'orbit', frameMedianMs: 1 }] }), /band/);
  assert.throws(bad({ cases: [{ objects: 10, band: 'local', frameMedianMs: 0 }] }), /frameMedianMs/);
  assert.throws(
    bad({ cases: [ok.presentation.cases[0], ok.presentation.cases[0]] }),
    /twice/,
    'the same case twice would let one of them hide',
  );
  assert.throws(() => parseBudgets({ ...ok, placeSearch: { entries: 10, buildMs: 1, queryMedianMs: 1 } }), /entries/);
});

test('each budget is judged against the case it names; one that was not measured fails', () => {
  const report = {
    cases: [
      { objects: 10_000, band: 'local', frame: { medianMs: 5 } },
      { objects: 50_000, band: 'global', frame: { medianMs: 300 } },
    ],
  } as unknown as BenchmarkReport;
  const r = evaluatePresentation(report, [
    { objects: 10_000, band: 'local', frameMedianMs: 16.7 },
    { objects: 50_000, band: 'global', frameMedianMs: 270 },
    { objects: 50_000, band: 'local', frameMedianMs: 55 },
  ]);
  assert.deepEqual(
    r.map((x) => x.pass),
    [true, false, false],
  );
  assert.equal(r[2]!.measuredMs, Number.POSITIVE_INFINITY);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('the place-search measurement runs end to end on a small set (where node:sqlite exists)', async (t) => {
  assert.equal(syntheticPlaces(300).length, 300);
  const r = await measurePlaceSearch(
    { entries: 2000, buildMs: 60_000, queryMedianMs: 1000 },
    path.join(os.tmpdir(), 'wv-perf-budget-test'),
  );
  if (typeof r === 'string') return t.skip(r);
  assert.equal(r.length, 2);
  assert.ok(
    r.every((x) => x.pass && Number.isFinite(x.measuredMs)),
    JSON.stringify(r),
  );
});
