import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderChecklist, formatReport } from '@worldview/tool-provider-validator';
import { singaporePlan } from './plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('public-cameras-singapore provider passes the full contract checklist', async () => {
  const report = await runProviderChecklist(singaporePlan, { repoRoot: root });
  const failed = report.checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 0, `\n${formatReport(report)}`);
  assert.equal(report.providerId, 'public-cameras-singapore');
});
