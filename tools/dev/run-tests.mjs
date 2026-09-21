#!/usr/bin/env node
/**
 * WORLDVIEW test runner.
 *
 * Runs Node's built-in test runner (node:test) through the tsx loader so tests are
 * plain TypeScript with zero framework dependencies. Test groups are defined by
 * directory convention:
 *
 *   src/**\/*.test.ts                 -> unit
 *   test/contract/**\/*.test.ts       -> contract  (provider contract tests)
 *   test/integration/**\/*.test.ts    -> integration
 *   test/offline/**\/*.test.ts        -> offline   (run with WORLDVIEW_NETWORK=off)
 *   test/failure/**\/*.test.ts        -> failure   (failure injection)
 *   test/boundary/**\/*.test.ts       -> boundary  (dependency-direction tests)
 *
 * Usage: node tools/dev/run-tests.mjs [--group <name>] [--filter <substring>] [--json <path>]
 *
 * Writes a machine-readable summary to artifacts/verification/tests/<group>.json
 * (evidence for the release verification file).
 */
import { readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const group = opt('--group', 'all');
const filter = opt('--filter', '');
const jsonOut = opt('--json', '');

const ROOTS = ['packages', 'providers', 'tools', 'apps'];
const SKIP = new Set(['node_modules', 'dist', 'out', 'release', '.vite', 'build-output']);

function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, acc);
    else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) acc.push(abs);
  }
  return acc;
}

function classify(file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (/\/test\/contract\//.test(rel)) return 'contract';
  if (/\/test\/integration\//.test(rel)) return 'integration';
  if (/\/test\/offline\//.test(rel)) return 'offline';
  if (/\/test\/failure\//.test(rel)) return 'failure';
  if (/\/test\/boundary\//.test(rel)) return 'boundary';
  if (/\/test\/e2e\//.test(rel)) return 'e2e';
  return 'unit';
}

const all = [];
for (const r of ROOTS) {
  const abs = path.join(root, r);
  if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs, all);
}
let files = all
  .map((f) => ({ file: f, group: classify(f) }))
  .filter((t) => (group === 'all' ? t.group !== 'e2e' : t.group === group))
  .filter((t) => (filter ? t.file.includes(filter) : true))
  .sort((a, b) => a.file.localeCompare(b.file));

if (files.length === 0) {
  console.log(`[tests] no test files for group "${group}"${filter ? ` filter "${filter}"` : ''}`);
  process.exit(0);
}

const env = { ...process.env };
if (group === 'offline') env.WORLDVIEW_NETWORK = 'off';
// tsx applies compilerOptions (JSX runtime, paths) only to files matched by its tsconfig; the root
// tsconfig.json excludes the renderer program, so point the loader at a workspace-wide config.
if (!env.TSX_TSCONFIG_PATH) env.TSX_TSCONFIG_PATH = path.join(root, 'tools', 'dev', 'tsconfig.tsx-loader.json');

const started = Date.now();
// test-hooks.mjs stubs stylesheet imports (Vite handles them in the app; node:test needs an empty module).
const nodeArgs = ['--import', 'tsx', '--import', pathToFileURL(path.join(root, 'tools', 'dev', 'test-hooks.mjs')).href, '--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=tap', '--test-reporter-destination=' + path.join(root, 'artifacts', 'verification', 'tests', `${group}.tap`)];
mkdirSync(path.join(root, 'artifacts', 'verification', 'tests'), { recursive: true });
const result = spawnSync(process.execPath, [...nodeArgs, ...files.map((t) => t.file)], {
  cwd: root,
  env,
  stdio: 'inherit',
});

// Parse the TAP summary for evidence.
let summary = { pass: 0, fail: 0, skipped: 0, todo: 0, duration_ms: Date.now() - started };
try {
  const tap = (await import('node:fs')).readFileSync(path.join(root, 'artifacts', 'verification', 'tests', `${group}.tap`), 'utf8');
  for (const [key, re] of Object.entries({ pass: /^# pass (\d+)/m, fail: /^# fail (\d+)/m, skipped: /^# skipped (\d+)/m, todo: /^# todo (\d+)/m })) {
    const m = tap.match(re);
    if (m) summary[key] = Number(m[1]);
  }
} catch {}

const evidence = {
  group,
  ranAt: new Date().toISOString(),
  node: process.version,
  files: files.map((t) => path.relative(root, t.file).split(path.sep).join('/')),
  fileCount: files.length,
  ...summary,
  exitCode: result.status ?? 1,
};
const outPath = jsonOut || path.join(root, 'artifacts', 'verification', 'tests', `${group}.json`);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n');
console.log(`\n[tests] group=${group} files=${files.length} pass=${summary.pass} fail=${summary.fail} -> ${path.relative(root, outPath)}`);
process.exit(result.status ?? 1);
