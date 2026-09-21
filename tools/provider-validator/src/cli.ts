#!/usr/bin/env node
/**
 * pnpm provider:test <provider-dir> [--all] [--json]
 *
 * Runs the provider contract checklist against fixtures (no network) and writes
 * artifacts/verification/providers/<providerId>.json as evidence.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProviderChecklist, formatReport } from './runner.js';
import type { ProviderTestPlan } from './plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const json = args.includes('--json');
const names = args.filter((a) => !a.startsWith('--'));

async function loadPlan(dir: string): Promise<ProviderTestPlan | undefined> {
  const file = path.join(root, 'providers', dir, 'test', 'contract', 'plan.ts');
  if (!existsSync(file)) return undefined;
  const mod = (await import(pathToFileURL(file).href)) as { plan?: ProviderTestPlan; default?: ProviderTestPlan };
  return mod.plan ?? mod.default;
}

const targets = all ? readdirSync(path.join(root, 'providers'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'registry').map((d) => d.name) : names;
if (targets.length === 0) {
  console.error('usage: pnpm provider:test <provider-dir> | --all');
  process.exit(2);
}

let failed = false;
for (const dir of targets) {
  const plan = await loadPlan(dir);
  if (!plan) { console.log(`providers/${dir}: no test/contract/plan.ts (SKIP)`); continue; }
  const report = await runProviderChecklist(plan, { repoRoot: root });
  const outDir = path.join(root, 'artifacts', 'verification', 'providers');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${report.providerId}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  console.log('');
  if (!report.passed) failed = true;
}
process.exit(failed ? 1 : 0);
