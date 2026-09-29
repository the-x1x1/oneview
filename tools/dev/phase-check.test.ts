import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifierFor, globToRegExp } from './phase-ownership.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ownership = JSON.parse(readFileSync(path.join(root, 'docs', 'roadmap', 'phases', 'ownership.json'), 'utf8'));
const phases = Object.keys(ownership.phases);

/** Tracked files, or undefined outside a git checkout (a source archive): those checks then say so and pass. */
function trackedFiles(): string[] | undefined {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

test('phase-check: globs — ** any depth, * one segment, case-insensitive', () => {
  const re = globToRegExp('packages/connector-runtime/src/connectors/**');
  assert.ok(re.test('packages/connector-runtime/src/connectors/ogc/wms.ts'));
  assert.ok(re.test('Packages/Connector-Runtime/src/connectors/csv.ts'));
  assert.ok(!re.test('packages/connector-runtime/src/registry.ts'));
  const one = globToRegExp('connectors/enabled/*');
  assert.ok(one.test('connectors/enabled/nowcoast-radar.json'));
  assert.ok(!one.test('connectors/enabled/pending-review/usgs-earthquakes-feed.json'));
});

test('phase-check: --list runs and names every phase', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'dev', 'phase-check.mjs'), '--list'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  for (const id of phases) assert.match(r.stdout, new RegExp(`^${id}\\s`, 'm'));
});

test('ownership: every literal frozen or shared path exists; every phase owns something', () => {
  for (const p of [...ownership.frozen.paths, ...ownership.shared.paths] as string[])
    if (!p.includes('*')) assert.ok(existsSync(path.join(root, p)), `${p} is named but does not exist`);
  for (const id of phases) assert.ok(ownership.phases[id].owns.length > 0, id);
});

test('ownership: shipped connectors and shipped definitions are frozen for every phase; pending-review is not', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('not a git checkout');
  const shipped = files.filter(
    (f) =>
      f.startsWith('packages/connector-runtime/src/connectors/') ||
      f.startsWith('packages/connector-runtime/src/shared/') ||
      /^connectors\/enabled\/[^/]+$/.test(f),
  );
  assert.ok(shipped.length > 50, 'the shipped connector files are found');
  for (const id of phases) {
    const classify = classifierFor(ownership, id);
    for (const f of shipped) assert.equal(classify(f).kind, 'frozen', `${f} for phase ${id}`);
  }
  const pending = files.filter((f) => f.startsWith('connectors/enabled/pending-review/'));
  assert.ok(pending.length > 0);
  for (const f of pending) assert.equal(classifierFor(ownership, 'provider-migration')(f).kind, 'owned', f);
});

test('ownership: no file is owned by two phases', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('not a git checkout');
  const classifiers = phases.map((id) => [id, classifierFor(ownership, id)] as const);
  for (const f of files) {
    const owners = classifiers.filter(([, classify]) => classify(f).kind === 'owned').map(([id]) => id);
    assert.ok(owners.length <= 1, `${f} is owned by ${owners.join(', ')}`);
  }
});
