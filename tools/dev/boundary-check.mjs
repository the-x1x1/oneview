#!/usr/bin/env node
/**
 * Dependency-direction check (directive §19). Fails closed.
 *
 * Rules (importer → forbidden imports):
 *   world-model            → anything @worldview/* (must stay dependency-free)
 *   provider-sdk           → anything except world-model
 *   providers/*            → react, react-dom, cesium, maplibre-gl, deck.gl, @worldview/render-*, @worldview/ui, electron, node:fs, node:child_process, undici/ws (network only via ProviderContext)
 *   render-*               → @worldview/provider-*, providers/*, @worldview/provider-runtime, node:http(s), undici, ws (renderers never fetch providers)
 *   ui                     → @worldview/provider-*, providers/*, @worldview/state-engine, @worldview/history-store, @worldview/provider-runtime, cesium, maplibre-gl, electron, node:*
 *   apps/desktop/renderer  → providers/*, @worldview/provider-runtime, @worldview/history-store, electron (except type imports), node:*
 *   state-engine           → @worldview/provider-runtime, render-*, ui
 *   identity               → anything except world-model
 *   hot-spatial-index      → anything except world-model
 *   event-engine/query-engine → render-*, ui, provider-runtime
 *
 * Usage: node tools/dev/boundary-check.mjs [--json]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'out', 'release', '.vite', 'build-output']);

const RULES = [
  { name: 'world-model is dependency-free', match: (f) => f.startsWith('packages/world-model/'), forbid: [/^@worldview\//] },
  { name: 'provider-sdk depends only on world-model', match: (f) => f.startsWith('packages/provider-sdk/'), forbid: [/^@worldview\/(?!world-model$)/] },
  { name: 'identity depends only on world-model', match: (f) => f.startsWith('packages/identity/'), forbid: [/^@worldview\/(?!world-model$)/] },
  { name: 'hot-spatial-index depends only on world-model', match: (f) => f.startsWith('packages/hot-spatial-index/'), forbid: [/^@worldview\/(?!world-model$)/] },
  { name: 'providers never render or touch UI/Electron/raw network/fs', match: (f) => f.startsWith('providers/') && !/\/test\//.test(f), forbid: [/^react/, /^cesium/, /^maplibre-gl/, /^@deck\.gl/, /^@worldview\/render-/, /^@worldview\/ui$/, /^electron/, /^node:fs/, /^node:child_process/, /^node:http/, /^node:net/, /^undici$/, /^ws$/, /^@worldview\/state-engine$/, /^@worldview\/history-store$/] },
  { name: 'renderers never fetch providers', match: (f) => /^packages\/render-/.test(f), forbid: [/^@worldview\/provider-/, /^@worldview\/providers$/, /^node:http/, /^undici$/, /^ws$/, /^@worldview\/state-engine$/, /^@worldview\/history-store$/] },
  { name: 'ui consumes typed APIs only', match: (f) => f.startsWith('packages/ui/'), forbid: [/^@worldview\/provider-/, /^@worldview\/providers$/, /^@worldview\/state-engine$/, /^@worldview\/history-store$/, /^cesium/, /^maplibre-gl/, /^electron/, /^node:/] },
  { name: 'renderer app never imports providers/runtime internals or node', match: (f) => f.startsWith('apps/desktop/src/renderer/'), forbid: [/^@worldview\/provider-runtime$/, /^@worldview\/providers$/, /^@worldview\/provider-(?!sdk$)/, /^@worldview\/history-store$/, /^@worldview\/runtime$/, /^node:/, /^electron$/] },
  { name: 'state-engine stays below presentation', match: (f) => f.startsWith('packages/state-engine/'), forbid: [/^@worldview\/provider-runtime$/, /^@worldview\/render-/, /^@worldview\/ui$/, /^react/] },
  { name: 'engines stay below presentation', match: (f) => /^packages\/(event-engine|query-engine)\//.test(f), forbid: [/^@worldview\/render-/, /^@worldview\/ui$/, /^@worldview\/provider-runtime$/, /^react/] },
  { name: 'no package imports another package by relative path', match: (f) => /^(packages|providers|tools)\//.test(f), forbid: [/^\.\.\/\.\.\/\.\.\/(packages|providers)\//, /^\.\.\/\.\.\/(packages|providers)\//] },
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;

// Test files may use the Node test runner and assertions even in browser-only trees (ui, renderer);
// everything else in those trees is still checked.
const TEST_FILE_RE = /\.test\.tsx?$/;
const TEST_ONLY_ALLOWED = new Set(['node:test', 'node:assert', 'node:assert/strict']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(e.name)) yield abs;
  }
}

const violations = [];
let filesChecked = 0;
for (const top of ['packages', 'providers', 'apps', 'tools']) {
  const abs = path.join(root, top);
  try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
  for (const file of walk(abs)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const rules = RULES.filter((r) => r.match(rel));
    if (!rules.length) continue;
    filesChecked++;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const isTypeOnly = /^\s*(?:import|export)\s+type\s/.test(m[0]);
      for (const rule of rules) {
        for (const re of rule.forbid) {
          if (re.test(spec)) {
            // Type-only imports of contracts are allowed for electron in renderer (types) — still flag runtime imports.
            if (isTypeOnly && /^electron$/.test(spec)) continue;
            if (TEST_FILE_RE.test(rel) && TEST_ONLY_ALLOWED.has(spec)) continue;
            violations.push({ file: rel, import: spec, rule: rule.name });
          }
        }
      }
    }
  }
}

const report = { ranAt: new Date().toISOString(), filesChecked, violations, passed: violations.length === 0 };
mkdirSync(path.join(root, 'artifacts', 'verification'), { recursive: true });
writeFileSync(path.join(root, 'artifacts', 'verification', 'boundary-check.json'), JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const v of violations) console.log(`VIOLATION ${v.file}: imports "${v.import}" (${v.rule})`);
  console.log(`[boundary-check] files=${filesChecked} violations=${violations.length} → ${report.passed ? 'PASS' : 'FAIL'}`);
}
process.exit(report.passed ? 0 : 1);
