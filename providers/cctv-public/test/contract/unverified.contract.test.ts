import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderChecklist, formatReport } from '@worldview/tool-provider-validator';
import { unverifiedPlan } from './plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('public-cameras-unverified provider passes the full contract checklist', async () => {
  const report = await runProviderChecklist(unverifiedPlan, { repoRoot: root });
  const failed = report.checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 0, `\n${formatReport(report)}`);
  assert.equal(report.providerId, 'public-cameras-unverified');
  const skipped = report.checks.filter((c) => c.status === 'SKIP').map((c) => c.check);
  assert.deepEqual(skipped, ['Stale Detection'], 'catalogues carry no per-camera observation time');
});
