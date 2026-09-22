#!/usr/bin/env node
/**
 * pnpm todo-report — scans the production trees for unresolved work markers
 * (directive §137) and writes artifacts/verification/todo-report.json.
 * Exits non-zero when markers exist so the release gate sees them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { todoReport } = await import(
  pathToFileURL(path.join(root, 'packages', 'diagnostics', 'src', 'todo-report.ts')).href
);
const report = await todoReport(root);
mkdirSync(path.join(root, 'artifacts', 'verification'), { recursive: true });
writeFileSync(path.join(root, 'artifacts', 'verification', 'todo-report.json'), JSON.stringify(report, null, 2) + '\n');
for (const e of report.entries) console.log(`${e.file}:${e.line} ${e.tag} ${e.text}`);
console.log(`[todo-report] files=${report.filesScanned} markers=${report.count}`);
process.exit(report.count === 0 ? 0 : 1);
