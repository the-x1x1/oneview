import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * These assert a property of the *source text*, not of a value, because the property
 * only exists at bundling time: which package the renderer chunk pulls in.
 *
 * WORLDVIEW's packaged renderer opened to a blank window for exactly one reason — the
 * adapter imported `cesium`, which re-exports @cesium/widgets, which bundles Knockout,
 * whose module-scope `(0, eval)("this")` is refused by `script-src 'self'
 * 'wasm-unsafe-eval'`. Nothing in the running program can notice the regression coming
 * back: the import is evaluated before any WORLDVIEW code, so the failure is a dead
 * window and a console entry, which is what this project keeps mistaking for progress.
 * A string check on the specifier is crude and it is the only check that runs early
 * enough to matter.
 */
const moduleSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cesium-module.ts'), 'utf8');

/** `import x from 'spec'`, `import type … from 'spec'`, `export … from 'spec'`, `import('spec')`. */
function importedSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

test('cesium adapter: imports the engine and never the widgets (CSP forbids Knockout eval)', () => {
  const specs = importedSpecifiers(moduleSource);
  assert.ok(specs.includes('@cesium/engine'), `expected an @cesium/engine import, saw ${specs.join(', ')}`);
  for (const spec of specs) {
    assert.notEqual(spec, 'cesium', 'importing `cesium` re-exports @cesium/widgets and its Knockout eval');
    assert.ok(!spec.startsWith('@cesium/widgets'), `@cesium/widgets must not reach the renderer bundle (saw ${spec})`);
  }
});

test('cesium adapter: the runtime import is dynamic, so a 2D-only session never loads the engine', () => {
  assert.match(moduleSource, /await import\('@cesium\/engine'\)/);
  assert.match(moduleSource, /import type \* as Cesium from '@cesium\/engine'/);
});
