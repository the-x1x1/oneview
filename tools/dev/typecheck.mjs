#!/usr/bin/env node
/**
 * Type-checks the whole workspace as source (packages are consumed as TypeScript
 * source; Vite/esbuild emit). Two programs: node-side (tsconfig.json) and renderer
 * (tsconfig.renderer.json: React/JSX + DOM).
 *
 * Third-party libraries that are not installed (no registry access in some build
 * environments) are substituted with declaration shims from tools/dev/type-shims/<lib>/
 * via generated `paths` mappings, so the workspace still type-checks structurally.
 * When the real package is installed the shim is NOT used. A summary of which shims
 * were active is written to artifacts/verification/typecheck.json so evidence is honest.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
const shimRoot = path.join(root, 'tools', 'dev', 'type-shims');

function activeShims() {
  if (!existsSync(shimRoot)) return [];
  const out = [];
  for (const entry of readdirSync(shimRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const lib = entry.name.replace(/__/g, '/'); // "@duckdb__node-api" → "@duckdb/node-api"
    const installed = existsSync(path.join(root, 'node_modules', ...lib.split('/'), 'package.json'));
    if (!installed) out.push({ lib, dir: path.join(shimRoot, entry.name) });
  }
  return out;
}

const shims = activeShims();
const programs = ['tsconfig.json', 'tsconfig.renderer.json'].filter((p) => existsSync(path.join(root, p)));
const generated = [];
let failed = false;
for (const p of programs) {
  let target = p;
  if (shims.length) {
    const paths = {};
    for (const s of shims) {
      paths[s.lib] = [path.relative(root, path.join(s.dir, 'index.d.ts')).split(path.sep).join('/')];
      paths[`${s.lib}/*`] = [path.relative(root, path.join(s.dir, '*')).split(path.sep).join('/')];
    }
    target = p.replace('.json', '.generated.json');
    writeFileSync(path.join(root, target), JSON.stringify({ extends: `./${p}`, compilerOptions: { paths: { ...readPaths(p), ...paths } } }, null, 2));
    generated.push(target);
  }
  console.log(`[typecheck] ${p}${shims.length ? ` (shims: ${shims.map((s) => s.lib).join(', ')})` : ''}`);
  const r = spawnSync(tsc, ['-p', target, '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
for (const g of generated) { try { unlinkSync(path.join(root, g)); } catch {} }
mkdirSync(path.join(root, 'artifacts', 'verification'), { recursive: true });
writeFileSync(path.join(root, 'artifacts', 'verification', 'typecheck.json'), JSON.stringify({ ranAt: new Date().toISOString(), programs, passed: !failed, shimsActive: shims.map((s) => s.lib) }, null, 2) + '\n');
process.exit(failed ? 1 : 0);

function readPaths(p) {
  // Merge base paths so generated config keeps @worldview/* mappings.
  try {
    const base = JSON.parse(readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8'));
    return base.compilerOptions?.paths ?? {};
  } catch { return {}; }
}
