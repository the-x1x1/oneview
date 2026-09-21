#!/usr/bin/env node
// Type-checks the whole workspace as source (packages are consumed as TypeScript source;
// bundlers — Vite/esbuild — do the emitting). Runs the node-side program and the
// renderer (React/JSX) program separately because they need different libs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
const programs = ['tsconfig.json', 'tsconfig.renderer.json'].filter((p) => existsSync(path.join(root, p)));
let failed = false;
for (const p of programs) {
  console.log(`[typecheck] ${p}`);
  const r = spawnSync(tsc, ['-p', p, '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
