import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderChecklist, formatReport } from '@worldview/tool-provider-validator';
import { plan } from './plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('aisstream provider passes the contract checklist (HTTP-only checks skip for a subscription provider)', async () => {
  const report = await runProviderChecklist(plan, { repoRoot: root });
  const failed = report.checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 0, `\n${formatReport(report)}`);
  assert.deepEqual(
    report.checks.filter((c) => c.status === 'SKIP').map((c) => c.check),
    [
      'Cancellation',
      'Timeout',
      'Stale Detection',
      'Empty Feed',
      'Malformed Feed',
      'Rate Limit',
      'Auth Failure',
      'Offline',
    ],
    formatReport(report),
  );
  assert.equal(report.summary.pass, 8, formatReport(report));
});
