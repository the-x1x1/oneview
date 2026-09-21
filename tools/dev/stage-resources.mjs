#!/usr/bin/env node
/**
 * Stages bundled read-only data into `resources/data/`, which the desktop app grants to
 * filesystem providers (dev run) and electron-builder copies into the package
 * (`extraResources`). Keeping the canonical copy in `fixtures/` and staging it here
 * means a dataset has exactly one source of truth.
 *
 *   node tools/dev/stage-resources.mjs           stage
 *   node tools/dev/stage-resources.mjs --check   verify the staged copies are current (CI)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The desktop app grants `<appPath>/resources/data` to filesystem providers in a dev run
// (app.getAppPath() === apps/desktop) and electron-builder copies the same directory into
// the package as `resources/data`.
const STAGED = [
  { from: 'fixtures/airports/seed-airports.geojson', to: 'apps/desktop/resources/data/airports.geojson' },
];

const check = process.argv.includes('--check');
let drift = 0;
for (const entry of STAGED) {
  const src = path.join(root, entry.from);
  const dst = path.join(root, entry.to);
  if (!existsSync(src)) { console.error(`[stage-resources] missing source ${entry.from}`); process.exit(1); }
  const srcHash = createHash('sha256').update(readFileSync(src)).digest('hex');
  const dstHash = existsSync(dst) ? createHash('sha256').update(readFileSync(dst)).digest('hex') : '';
  if (srcHash === dstHash) { console.log(`[stage-resources] up to date: ${entry.to}`); continue; }
  if (check) { console.error(`[stage-resources] stale: ${entry.to} (run "pnpm stage:resources")`); drift++; continue; }
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`[stage-resources] staged ${entry.from} → ${entry.to}`);
}
process.exit(drift ? 1 : 0);
