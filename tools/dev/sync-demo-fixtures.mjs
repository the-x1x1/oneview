#!/usr/bin/env node
/**
 * Regenerates the TypeScript copies of fixtures used by the renderer demo client
 * (apps/desktop/src/renderer/demo/fixtures/*). The renderer cannot read the filesystem,
 * so fixtures it needs are embedded as modules; this keeps them identical to the source.
 * Usage: node tools/dev/sync-demo-fixtures.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const check = process.argv.includes('--check');

const FIXTURES = [
  {
    source: 'fixtures/usgs/normal.geojson',
    target: 'apps/desktop/src/renderer/demo/fixtures/usgs-normal.ts',
    exportName: 'USGS_NORMAL_FIXTURE',
    header: `/**
 * Copy of fixtures/usgs/normal.geojson as a TypeScript module so the demo client can load
 * it in the browser (Vite) and under node:test without filesystem access. Synthetic
 * contract fixture (see fixtures/usgs/README.md): generated in-repo, not recorded from
 * the live feed. Reference time 2026-09-21T08:00:00Z.
 * apps/desktop/test/unit/demo-fixture-sync.test.ts asserts this stays identical to the
 * source file; regenerate it with \`node tools/dev/sync-demo-fixtures.mjs\`.
 */`,
  },
];

export function renderFixtureModule({ source, exportName, header }) {
  const data = JSON.parse(readFileSync(path.join(root, source), 'utf8'));
  return `${header}\nexport const ${exportName} = ${JSON.stringify(data, null, 1)} as const;\n`;
}

let stale = 0;
for (const f of FIXTURES) {
  const expected = renderFixtureModule(f);
  const targetPath = path.join(root, f.target);
  let current = '';
  try { current = readFileSync(targetPath, 'utf8'); } catch {}
  if (current === expected) continue;
  if (check) { console.log(`[sync-demo-fixtures] stale: ${f.target}`); stale++; continue; }
  writeFileSync(targetPath, expected);
  console.log(`[sync-demo-fixtures] wrote ${f.target}`);
}
if (check && stale) process.exit(1);
