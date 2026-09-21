import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderChecklist, formatReport } from '@worldview/tool-provider-validator';
import { plan } from './plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('seed airports provider passes the contract checklist (network-only checks skip for a filesystem transport)', async () => {
  const report = await runProviderChecklist(plan, { repoRoot: root });
  const failed = report.checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 0, `\n${formatReport(report)}`);
  // A filesystem provider has no network path: the timeout/rate-limit/auth scenarios cannot
  // apply, while Offline must still answer (asserted inside the runner's local profile).
  assert.deepEqual(report.checks.filter((c) => c.status === 'SKIP').map((c) => c.check), ['Timeout', 'Rate Limit', 'Auth Failure'], formatReport(report));
  assert.equal(report.checks.find((c) => c.check === 'Offline')?.status, 'PASS', 'must work offline');
  assert.ok(report.summary.pass >= 13, formatReport(report));
});
