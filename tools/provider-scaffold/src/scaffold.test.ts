import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProviderChecklist, formatReport, type ProviderTestPlan } from '@worldview/tool-provider-validator';
import { readManifestSource } from '@worldview/tool-license-audit';
import { checkOptions, scaffoldProvider, type ScaffoldOptions } from './scaffold.js';
import { collision, parseArgs, writeScaffold } from './cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const BASE: ScaffoldOptions = {
  id: 'example-sensors',
  name: "Example City's sensors",
  objectType: 'sensor',
  url: 'https://data.example.org/sensors.geojson',
  licence: 'CC BY 4.0',
  attribution: 'Sensors: Example City open data',
};

/**
 * A throwaway repository root beside this file — inside tools/, so the test loader's path
 * mapping resolves the generated code's `@worldview/*` imports — with an empty licence
 * registry. Removed afterwards whatever happens.
 */
async function inTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = path.join(here, '..', `.tmp-scaffold-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path.join(root, 'config', 'licenses'), { recursive: true });
  writeFileSync(
    path.join(root, 'config', 'licenses', 'providers.json'),
    `${JSON.stringify({ $schema: 'worldview/licenses/providers/v1', records: [] }, null, 2)}\n`,
  );
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function checklist(root: string, id: string) {
  const mod = (await import(pathToFileURL(path.join(root, 'providers', id, 'test', 'contract', 'plan.ts')).href)) as {
    plan: ProviderTestPlan;
  };
  return runProviderChecklist(mod.plan, { repoRoot: root });
}

test('options: a scaffold is refused for anything it cannot make safely', () => {
  assert.equal(checkOptions(BASE), undefined);
  assert.match(checkOptions({ ...BASE, id: 'Example' }) ?? '', /kebab-case/);
  assert.match(checkOptions({ ...BASE, id: 'registry' }) ?? '', /taken/);
  assert.match(checkOptions({ ...BASE, url: 'http://data.example.org/x.geojson' }) ?? '', /https/);
  assert.match(checkOptions({ ...BASE, url: 'https://me:pw@data.example.org/x' }) ?? '', /login/);
  assert.match(checkOptions({ ...BASE, objectType: 'ufo' as ScaffoldOptions['objectType'] }) ?? '', /object type/);
  assert.match(checkOptions({ ...BASE, intervalSeconds: 10 }) ?? '', /at least 60/);
  assert.match(checkOptions({ ...BASE, timeProperty: 'bad key!' }) ?? '', /property name/);
  assert.match(checkOptions({ ...BASE, licence: ' ' }) ?? '', /licence/);
});

test('arguments: flags become options; missing ones are named', () => {
  const ok = parseArgs([
    'example-sensors',
    '--name',
    'Example sensors',
    '--type=sensor',
    '--url',
    'https://data.example.org/s.geojson',
    '--license',
    'CC0',
    '--attribution',
    'Example',
    '--time-property',
    'updated',
    '--interval',
    '120',
    '--dry-run',
  ]);
  assert.ok(typeof ok !== 'string', String(ok));
  assert.equal(ok.dryRun, true);
  assert.equal(ok.options.licence, 'CC0', '--license is accepted for --licence');
  assert.equal(ok.options.timeProperty, 'updated');
  assert.equal(ok.options.intervalSeconds, 120);
  assert.match(String(parseArgs(['x-y-z'])), /--name is required/);
  assert.match(String(parseArgs(['a-b-c', '--colour', 'red'])), /unknown option --colour/);
  assert.match(String(parseArgs(['--name', 'x'])), /one provider id/);
});

test('the licence record is the most conservative there is, and the manifest says the same', () => {
  const r = scaffoldProvider(BASE);
  const rec = r.record as { dataPolicy: Record<string, unknown>; commercialReview: string; plannedStatus: string };
  assert.equal(rec.commercialReview, 'manual-review-required');
  assert.equal(rec.plannedStatus, 'optional');
  for (const k of ['rawPayloadRetentionAllowed', 'redistributionAllowed', 'offlinePackAllowed', 'exportAllowed'])
    assert.equal(rec.dataPolicy[k], false, k);
  assert.equal(rec.dataPolicy['commercialUseAllowed'], 'unknown');
  // The licence audit reads the manifest as text; what it reads must equal the record.
  const read = readManifestSource(r.files['providers/example-sensors/src/manifest.ts']!);
  assert.equal(read.id, 'example-sensors');
  assert.equal(read.enabledByDefault, false, 'never on by default');
  assert.equal(read.commercialReview, rec.commercialReview);
  for (const [k, v] of Object.entries(read.dataPolicy)) assert.equal(v, rec.dataPolicy[k], `dataPolicy.${k}`);
  assert.ok(Object.keys(read.dataPolicy).length >= 8, 'every audited key is present');
  assert.ok(
    !Object.values(r.files).some((f) => /\b(TODO|FIXME|XXX)\b/.test(f)),
    'the generated code carries no to-do markers',
  );
});

test('scaffolded with a time property: the full contract checklist passes as generated, stale detection included', async () => {
  await inTempRoot(async (root) => {
    const opts: ScaffoldOptions = { ...BASE, idProperty: 'sensor_id', timeProperty: 'updated', intervalSeconds: 120 };
    const written = writeScaffold(root, opts);
    assert.ok(written.includes('providers/example-sensors/src/index.ts'));
    const report = await checklist(root, 'example-sensors');
    const failed = report.checks.filter((c) => c.status === 'FAIL');
    assert.equal(failed.length, 0, `\n${formatReport(report)}`);
    assert.equal(report.checks.find((c) => c.check === 'Stale Detection')?.status, 'PASS');
    assert.equal(report.evidence.observations, 3);
    // The record went into the registry, and a second run refuses rather than overwrite.
    const reg = JSON.parse(readFileSync(path.join(root, 'config', 'licenses', 'providers.json'), 'utf8')) as {
      records: Array<{ providerId: string }>;
    };
    assert.deepEqual(
      reg.records.map((x) => x.providerId),
      ['example-sensors'],
    );
    assert.match(collision(root, 'example-sensors') ?? '', /already exists/);
    assert.throws(() => writeScaffold(root, opts), /already exists/);
  });
});

test('scaffolded without a time property: observations are dated when fetched, and stale detection is skipped', async () => {
  await inTempRoot(async (root) => {
    writeScaffold(root, { ...BASE, id: 'plain-points', objectType: 'infrastructure' });
    assert.equal(existsSync(path.join(root, 'fixtures', 'plain-points', 'stale.geojson')), false);
    const report = await checklist(root, 'plain-points');
    const failed = report.checks.filter((c) => c.status === 'FAIL');
    assert.equal(failed.length, 0, `\n${formatReport(report)}`);
    assert.equal(report.checks.find((c) => c.check === 'Stale Detection')?.status, 'SKIP');
  });
});

test('the generated files are already in the repository’s Prettier style', async (t) => {
  type PrettierLike = {
    check(source: string, options: Record<string, unknown>): Promise<boolean>;
    resolveConfig(file: string): Promise<Record<string, unknown> | null>;
  };
  let prettier: PrettierLike;
  try {
    prettier = (await import('prettier' as string)) as PrettierLike;
  } catch {
    t.skip('prettier is not installed here (it is on a workstation after pnpm install)');
    return;
  }
  const repoRoot = path.join(here, '..', '..', '..');
  const config = (await prettier.resolveConfig(path.join(repoRoot, 'package.json'))) ?? {};
  const variants: ScaffoldOptions[] = [
    BASE,
    { ...BASE, idProperty: 'sensor_id', timeProperty: 'updated' },
    {
      ...BASE,
      id: 'a-rather-long-provider-identifier-for-line',
      name: `O'Brien's "long" feed — ${'x'.repeat(50)}`,
      url: `https://open-data.example-portal.org/api/v2/datasets/${'y'.repeat(60)}/exports/geojson`,
      attribution: `Contains public sector information — ${'z'.repeat(90)}`,
      objectType: 'fire-detection',
    },
  ];
  const unformatted: string[] = [];
  for (const v of variants)
    for (const [rel, content] of Object.entries(scaffoldProvider(v).files)) {
      // fixtures/ is in .prettierignore: recorded bodies are compared byte for byte.
      if (rel.startsWith('fixtures/') || !/\.(ts|json|md)$/.test(rel)) continue;
      if (!(await prettier.check(content, { ...config, filepath: rel }))) unformatted.push(rel);
    }
  assert.deepEqual(unformatted, [], 'run prettier on these templates and copy the result back');
});
