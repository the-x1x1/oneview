#!/usr/bin/env node
/**
 * Bundles the Electron main process and the preload script with esbuild.
 *
 *   node scripts/build-main.mjs            one-shot build → dist/main/main.cjs, dist/preload/preload.cjs
 *   node scripts/build-main.mjs --watch    rebuild on change (pnpm dev)
 *   node scripts/build-main.mjs --cesium-assets   also copy Cesium's static assets into dist/renderer/cesium
 *
 * Both outputs are CommonJS: sandboxed preloads cannot load ESM, and one module
 * format keeps electron-builder's `main` entry unambiguous. Workspace packages are
 * bundled from TypeScript source through tsconfig.base.json `paths`; Electron and
 * native modules stay external. Build facts (commit, channel, signing) are injected
 * as `__WORLDVIEW_BUILD__` (src/main/build-info.ts).
 *
 * esbuild is resolved from node_modules at run time so this script can be linted
 * and type-checked in environments where it is not installed.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const workspaceRoot = path.resolve(appDir, '..', '..');
const require = createRequire(import.meta.url);

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const copyCesium = args.has('--cesium-assets') || !watch;

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('[build-main] esbuild is not installed (pnpm install). Nothing built.');
  process.exit(2);
}

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

const build = {
  commit: process.env.WORLDVIEW_COMMIT || gitCommit(),
  channel: process.env.WORLDVIEW_CHANNEL === 'stable' ? 'stable' : process.env.WORLDVIEW_CHANNEL === 'prerelease' ? 'prerelease' : 'dev',
  // Only the packaging job sets this, and only when a certificate was actually used (ADR-012).
  signed: process.env.WORLDVIEW_SIGNED === '1',
  buildTime: new Date().toISOString(),
};

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  sourcemap: true,
  minify: false,
  legalComments: 'linked',
  tsconfig: path.join(workspaceRoot, 'tsconfig.base.json'),
  external: ['electron', 'electron-updater', '@duckdb/node-api', '@duckdb/node-bindings'],
  define: { __WORLDVIEW_BUILD__: JSON.stringify(build) },
  logLevel: 'info',
};

const targets = [
  { ...common, entryPoints: [path.join(appDir, 'src', 'main', 'main.ts')], outfile: path.join(appDir, 'dist', 'main', 'main.cjs') },
  { ...common, entryPoints: [path.join(appDir, 'src', 'preload', 'preload.ts')], outfile: path.join(appDir, 'dist', 'preload', 'preload.cjs'), external: ['electron'] },
];

function copyCesiumAssets() {
  // pnpm does not hoist: cesium is a dependency of apps/desktop and lives in
  // apps/desktop/node_modules, not the workspace root. Looking only at the root meant
  // this step warned and skipped on every real install, so the packaged app shipped
  // without the Workers, Assets and Widgets the 3D globe loads at runtime — a warning
  // in the middle of a successful build, and a globe that would never appear.
  const candidates = [appDir, workspaceRoot].map((dir) => path.join(dir, 'node_modules', 'cesium', 'Build', 'Cesium'));
  const source = candidates.find((c) => existsSync(c));
  const dest = path.join(appDir, 'dist', 'renderer', 'cesium');
  if (!source) {
    console.error(`[build-main] cesium assets not found (looked in ${candidates.join(', ')}); the 3D globe cannot load without them`);
    process.exitCode = 1;
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const sub of ['Workers', 'Assets', 'ThirdParty', 'Widgets']) cpSync(path.join(source, sub), path.join(dest, sub), { recursive: true });
  console.log('[build-main] copied Cesium assets → dist/renderer/cesium');
}

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build-main] watching main + preload');
} else {
  for (const t of targets) await esbuild.build(t);
  if (copyCesium) copyCesiumAssets();
  console.log(`[build-main] built main + preload (commit ${build.commit}, channel ${build.channel}, signed ${build.signed})`);
}
