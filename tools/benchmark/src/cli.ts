#!/usr/bin/env node
/**
 * `pnpm benchmark [--sizes 1000,10000,50000,100000] [--iterations 9] [--out artifacts/verification/benchmarks]`
 * Runs the presentation benchmark and writes presentation.json as evidence.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSummary, runAndWrite } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const sizes = (opt('--sizes') ?? '1000,10000,50000,100000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const iterations = Number(opt('--iterations') ?? 9);
const outDir = path.resolve(root, opt('--out') ?? path.join('artifacts', 'verification', 'benchmarks'));

const { report, file } = runAndWrite({ sizes, iterations, outDir });
console.log(formatSummary(report));
console.log(`\n[benchmark] wrote ${path.relative(root, file)}`);
