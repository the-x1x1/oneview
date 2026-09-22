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
const shimRoot = path.join(root, 'tools', 'dev', 'type-shims');

/**
 * pnpm does not hoist: a dependency of apps/desktop is linked into
 * apps/desktop/node_modules, not the root. Looking only at the root made every real
 * package invisible, so this tool shimmed Cesium, Electron, MapLibre, React and DuckDB
 * on a machine where all of them were installed — type-checking the workspace against
 * hand-written declarations instead of the libraries it actually builds against.
 */
function packageDirs() {
  const dirs = [root];
  for (const group of ['apps', 'packages', 'providers', 'tools']) {
    const groupDir = path.join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(groupDir, entry.name));
    }
  }
  return dirs;
}

/**
 * Run the compiler as a script through this Node, not through node_modules/.bin/tsc.
 * That path is an extensionless shell script on Windows, which spawnSync cannot execute
 * without a shell: it failed with no output at all and a non-zero exit, so `pnpm
 * typecheck` reported failure without ever printing a type error.
 */
function tscEntry() {
  for (const dir of packageDirs()) {
    const entry = path.join(dir, 'node_modules', 'typescript', 'lib', 'tsc.js');
    if (existsSync(entry)) return entry;
  }
  return undefined;
}

function activeShims() {
  if (!existsSync(shimRoot)) return [];
  const out = [];
  for (const entry of readdirSync(shimRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const lib = entry.name.replace(/__/g, '/'); // "@duckdb__node-api" → "@duckdb/node-api"
    if (!hasTypes(lib)) out.push({ lib, dir: path.join(shimRoot, entry.name) });
  }
  return out;
}

/**
 * A shim is used only when neither the package's own declarations nor an @types
 * package are installed (react/react-dom ship without types; their @types packages
 * are not available without registry access).
 */
function hasTypes(lib) {
  for (const dir of packageDirs()) {
    const pkgDir = path.join(dir, 'node_modules', ...lib.split('/'));
    const pkgJson = path.join(pkgDir, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
        if (pkg.types || pkg.typings) return true;
        const exp = pkg.exports?.['.'];
        if (exp && typeof exp === 'object' && exp.types) return true;
      } catch {}
      if (existsSync(path.join(pkgDir, 'index.d.ts'))) return true;
    }
    const typesName = lib.startsWith('@') ? lib.slice(1).replace('/', '__') : lib; // "@scope/name" → "scope__name"
    const [typesPkg] = typesName.split('/');
    if (existsSync(path.join(dir, 'node_modules', '@types', typesPkg, 'package.json'))) return true;
  }
  return false;
}

const tsc = tscEntry();
if (!tsc) {
  console.error('[typecheck] typescript is not installed anywhere in this workspace — run pnpm install');
  process.exit(1);
}

const shims = activeShims();
if (shims.length === 0) console.log('[typecheck] every third-party library resolved to its own types; no shims in use');
const programs = ['tsconfig.json', 'tsconfig.renderer.json'].filter((p) => existsSync(path.join(root, p)));
const generated = [];
let failed = false;
for (const p of programs) {
  let target = p;
  if (shims.length) {
    const paths = {};
    for (const s of shims) {
      // `paths` entries must be relative (no baseUrl is set), hence the leading "./".
      paths[s.lib] = ['./' + path.relative(root, path.join(s.dir, 'index.d.ts')).split(path.sep).join('/')];
      paths[`${s.lib}/*`] = ['./' + path.relative(root, path.join(s.dir, '*')).split(path.sep).join('/')];
    }
    target = p.replace('.json', '.generated.json');
    writeFileSync(
      path.join(root, target),
      JSON.stringify({ extends: `./${p}`, compilerOptions: { paths: { ...readPaths(p), ...paths } } }, null, 2),
    );
    generated.push(target);
  }
  console.log(`[typecheck] ${p}${shims.length ? ` (shims: ${shims.map((s) => s.lib).join(', ')})` : ''}`);
  const r = spawnSync(process.execPath, [tsc, '-p', target, '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
  if (r.error) {
    console.error(`[typecheck] could not run the compiler: ${r.error.message}`);
    failed = true;
  } else if (r.status !== 0) {
    if (r.status === null)
      console.error(`[typecheck] the compiler was terminated by ${r.signal ?? 'an unknown signal'}`);
    failed = true;
  }
}
for (const g of generated) {
  try {
    unlinkSync(path.join(root, g));
  } catch {}
}
mkdirSync(path.join(root, 'artifacts', 'verification'), { recursive: true });
writeFileSync(
  path.join(root, 'artifacts', 'verification', 'typecheck.json'),
  JSON.stringify(
    { ranAt: new Date().toISOString(), programs, passed: !failed, shimsActive: shims.map((s) => s.lib) },
    null,
    2,
  ) + '\n',
);
process.exit(failed ? 1 : 0);

function readPaths(p) {
  // Merge base paths so generated config keeps @worldview/* mappings.
  try {
    const base = JSON.parse(readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8'));
    return base.compilerOptions?.paths ?? {};
  } catch {
    return {};
  }
}
