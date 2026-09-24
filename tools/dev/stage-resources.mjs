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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The desktop app grants `<appPath>/resources/data` to filesystem providers in a dev run
// (app.getAppPath() === apps/desktop) and electron-builder copies the same directory into
// the package as `resources/data`.
const STAGED = [
  { from: 'fixtures/airports/seed-airports.geojson', to: 'apps/desktop/resources/data/airports.geojson' },
  // Demo mode replays this through the real USGS normalizer. It has to be a packaged
  // resource, not a repo path: the main bundle is CJS, where `import.meta.url` is empty,
  // and fixtures/ does not exist beside an installed application at all.
  { from: 'fixtures/usgs/normal.geojson', to: 'apps/desktop/resources/data/demo-earthquakes.geojson' },
];

/**
 * Directories staged whole: every matching file is copied, and a staged file whose source
 * is gone is removed, so the package never ships a definition the repository dropped.
 * Shipped connector definitions (ADR-013) live in connectors/enabled/ and are read by the
 * runtime from resources/data/connectors/enabled/.
 */
const STAGED_DIRS = [
  {
    from: 'connectors/enabled',
    to: 'apps/desktop/resources/data/connectors/enabled',
    keep: (name) => name.endsWith('.json') && !name.endsWith('.test.json') && !name.startsWith('.'),
  },
];

const check = process.argv.includes('--check');
let drift = 0;
for (const dir of STAGED_DIRS) {
  const srcDir = path.join(root, dir.from);
  const dstDir = path.join(root, dir.to);
  const sources = existsSync(srcDir) ? readdirSync(srcDir).filter(dir.keep).sort() : [];
  const staged = existsSync(dstDir) ? readdirSync(dstDir).filter(dir.keep).sort() : [];
  for (const name of sources) STAGED.push({ from: `${dir.from}/${name}`, to: `${dir.to}/${name}` });
  for (const name of staged) {
    if (sources.includes(name)) continue;
    if (check) {
      console.error(`[stage-resources] stale: ${dir.to}/${name} has no source (run "pnpm stage:resources")`);
      drift++;
      continue;
    }
    unlinkSync(path.join(dstDir, name));
    console.log(`[stage-resources] removed ${dir.to}/${name}`);
  }
}
for (const entry of STAGED) {
  const src = path.join(root, entry.from);
  const dst = path.join(root, entry.to);
  if (!existsSync(src)) {
    console.error(`[stage-resources] missing source ${entry.from}`);
    process.exit(1);
  }
  const srcHash = createHash('sha256').update(readFileSync(src)).digest('hex');
  const dstHash = existsSync(dst) ? createHash('sha256').update(readFileSync(dst)).digest('hex') : '';
  if (srcHash === dstHash) {
    console.log(`[stage-resources] up to date: ${entry.to}`);
    continue;
  }
  if (check) {
    console.error(`[stage-resources] stale: ${entry.to} (run "pnpm stage:resources")`);
    drift++;
    continue;
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`[stage-resources] staged ${entry.from} → ${entry.to}`);
}
process.exit(drift ? 1 : 0);
