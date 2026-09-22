#!/usr/bin/env node
/**
 * Bundles the Electron main process and the preload script with esbuild.
 *
 *   node scripts/build-main.mjs            one-shot build → dist/main/main.cjs, dist/preload/preload.cjs
 *   node scripts/build-main.mjs --watch    rebuild on change (pnpm dev)
 *
 * Cesium's static assets are staged into .vite-public/cesium (scripts/renderer-assets.mjs)
 * on every run, watch included; `vite build` copies that directory into dist/renderer
 * after emptying it. Writing them straight into dist/renderer does not survive.
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
import path from 'node:path';
import { appDir, workspaceRoot, stageRendererAssets } from './renderer-assets.mjs';

const require = createRequire(import.meta.url);

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('[build-main] esbuild is not installed (pnpm install). Nothing built.');
  process.exit(2);
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const build = {
  commit: process.env.WORLDVIEW_COMMIT || gitCommit(),
  channel:
    process.env.WORLDVIEW_CHANNEL === 'stable'
      ? 'stable'
      : process.env.WORLDVIEW_CHANNEL === 'prerelease'
        ? 'prerelease'
        : 'dev',
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
  {
    ...common,
    entryPoints: [path.join(appDir, 'src', 'main', 'main.ts')],
    outfile: path.join(appDir, 'dist', 'main', 'main.cjs'),
  },
  {
    ...common,
    entryPoints: [path.join(appDir, 'src', 'preload', 'preload.ts')],
    outfile: path.join(appDir, 'dist', 'preload', 'preload.cjs'),
    external: ['electron'],
  },
];

try {
  const staged = stageRendererAssets();
  console.log(`[build-main] staged cesium assets → ${path.relative(workspaceRoot, staged.cesium)}`);
  console.log(
    `[build-main] staged maplibre-gl ${staged.maplibre.version} runtime files (${staged.maplibre.files.join(', ')}) → ${path.relative(workspaceRoot, staged.maplibre.dir)}`,
  );
} catch (error) {
  console.error(`[build-main] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build-main] watching main + preload');
} else {
  for (const t of targets) await esbuild.build(t);
  console.log(
    `[build-main] built main + preload (commit ${build.commit}, channel ${build.channel}, signed ${build.signed})`,
  );
}
