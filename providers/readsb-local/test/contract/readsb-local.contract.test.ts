import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderChecklist, formatReport } from '@worldview/tool-provider-validator';
import { plan } from './plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('readsb-local provider passes the contract checklist (Offline skipped: local-process keeps loopback access)', async () => {
  const report = await runProviderChecklist(plan, { repoRoot: root });
  const failed = report.checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 0, `\n${formatReport(report)}`);
  assert.deepEqual(report.checks.filter((c) => c.status === 'SKIP').map((c) => c.check), ['Offline'], formatReport(report));
  assert.ok(report.summary.pass >= 15, formatReport(report));
});
