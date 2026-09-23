#!/usr/bin/env node
/**
 * `pnpm perf:budget [--budgets config/perf-budgets.json] [--out artifacts/verification]`
 * Measures what config/perf-budgets.json budgets, writes perf-budget.json, exits 1 over budget.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport, parseBudgets, runBudgets } from './budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const budgetsFile = path.resolve(root, opt('--budgets') ?? path.join('config', 'perf-budgets.json'));
const outDir = path.resolve(root, opt('--out') ?? path.join('artifacts', 'verification'));

const budgets = parseBudgets(JSON.parse(await fs.readFile(budgetsFile, 'utf8')));
const report = await runBudgets(budgets, path.join(os.tmpdir(), 'worldview-perf-budget'));
await fs.mkdir(outDir, { recursive: true });
const file = path.join(outDir, 'perf-budget.json');
await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(formatReport(report));
console.log(`\n[perf-budget] wrote ${path.relative(root, file)}`);
process.exitCode = report.passed ? 0 : 1;
