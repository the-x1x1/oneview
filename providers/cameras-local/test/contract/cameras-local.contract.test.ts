import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderChecklist, formatReport } from '@worldview/tool-provider-validator';
import { testing } from '@worldview/provider-sdk';
import { plan, SETTINGS } from './plan.js';
import { createProvider } from '../../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('cameras-local provider passes the contract checklist (local profile)', async () => {
  const report = await runProviderChecklist(plan, { repoRoot: root });
  const failed = report.checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 0, `\n${formatReport(report)}`);
  assert.ok(report.summary.pass >= 10, formatReport(report));
  const skipped = report.checks.filter((c) => c.status === 'SKIP').map((c) => c.check);
  assert.deepEqual(
    skipped,
    ['Timeout', 'Stale Detection', 'Empty Feed', 'Malformed Feed', 'Rate Limit', 'Auth Failure'],
    'network-only checks are skipped for a local transport; empty/malformed settings are covered below',
  );
  const offline = report.checks.find((c) => c.check === 'Offline');
  assert.equal(offline?.status, 'PASS');
  assert.match(offline?.detail ?? '', /no network requests/);
});

test('settings changes are reflected on the next poll; malformed settings never crash', async () => {
  const provider = createProvider();
  const ctx = testing.createFixtureContext({ providerId: 'cameras-local', settings: SETTINGS });
  await provider.initialize(ctx);
  await provider.start();
  assert.equal((await provider.query({ signal: new AbortController().signal, background: true })).length, 3);
  assert.equal(provider.invalidEntries(), 3);
  ctx.settings.update({ cameras: [{ cameraId: '111111111111', name: 'Only one', headingDegrees: -90 }] });
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.payload['headingDegrees'], 270);
  ctx.settings.update({ cameras: 'not a list' });
  assert.deepEqual(await provider.query({ signal: new AbortController().signal, background: true }), []);
  ctx.settings.update({});
  assert.deepEqual(await provider.query({ signal: new AbortController().signal, background: true }), []);
  assert.equal((await provider.health()).status, 'LIVE');
  assert.equal(ctx.http.requests.length, 0);
});
