import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'out', 'release', '.vite', 'build-output', '.git', 'artifacts']);

/**
 * Directive §139: a document may not claim a verification that does not exist. The
 * threat model names the test that proves each mitigation, so those names are checked
 * against the suite rather than trusted — a renamed or deleted test fails here instead
 * of quietly turning the document into a promise nobody keeps.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

function testNames(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
      names.add(m[2]!.replace(/\\(['"`])/g, '$1'));
    }
  }
  return names;
}

test('threat model: every named verification test exists in the suite', () => {
  const doc = readFileSync(path.join(root, 'docs', 'security', 'THREAT-MODEL.md'), 'utf8');
  const names = testNames();
  assert.ok(names.size > 100, `expected the suite to be discovered, found ${names.size} test names`);

  // Verification lines quote test names in backticks; a line may name several, and
  // markdown wraps them across lines, so both sides are compared on collapsed
  // whitespace. A citation ending in an ellipsis is a deliberate abbreviation of a long
  // test name and matches by prefix.
  const collapse = (v: string) => v.replace(/\s+/g, ' ').trim();
  const normalized = new Set([...names].map(collapse));
  const missing: string[] = [];
  let claimed = 0;
  // Prettier normalises markdown emphasis, rewriting *Verification:* as _Verification:_.
  // Matching the literal asterisk form silently found zero citations and this assertion
  // was the only thing that noticed, so both markers are accepted.
  for (const block of doc.split(/\n(?=[*_])/)) {
    if (!/^[*_]Verification:[*_]/.test(block)) continue;
    for (const m of block.matchAll(/`([^`]+)`/g)) {
      const quoted = collapse(m[1]!);
      // Only sentences read as test names; identifiers, paths and commands do not.
      if (!/\s/.test(quoted) || /^[\w@./-]+$/.test(quoted)) continue;
      if (/^(?:pnpm|npm|npx|node|git|corepack) /.test(quoted)) continue;
      claimed++;
      const prefix = quoted.replace(/\s*(?:…|\.\.\.)$/, '');
      const found = prefix === quoted ? normalized.has(quoted) : [...normalized].some((n) => n.startsWith(prefix));
      if (!found) missing.push(quoted);
    }
  }
  assert.ok(claimed >= 10, `expected the threat model to cite tests, found ${claimed} citations`);
  assert.deepEqual(missing, [], 'threat-model verification names with no matching test');
});

test('threat model: every threat states its mitigation, verification and residual risk', () => {
  const doc = readFileSync(path.join(root, 'docs', 'security', 'THREAT-MODEL.md'), 'utf8');
  const sections = doc.split(/\n(?=### T\d+ )/).filter((s) => s.startsWith('### T'));
  assert.ok(sections.length >= 15, `expected the full threat list, found ${sections.length}`);
  for (const section of sections) {
    const heading = section.split('\n')[0]!;
    // Either emphasis marker: Prettier rewrites *Threat:* as _Threat:_ (see above).
    for (const field of ['Threat', 'Mitigation', 'Verification', 'Residual']) {
      const present = new RegExp(`[*_]${field}:[*_]`).test(section);
      assert.ok(present, `${heading} is missing *${field}:*`);
    }
  }
});

test('docs: the ADR index lists every ADR file', () => {
  const adrDir = path.join(root, 'docs', 'adr');
  const files = readdirSync(adrDir)
    .filter((f) => /^ADR-\d+-.*\.md$/.test(f))
    .sort();
  const index = readFileSync(path.join(adrDir, 'README.md'), 'utf8');
  const missing = files.filter((f) => !index.includes(f.replace(/\.md$/, '')) && !index.includes(f));
  assert.deepEqual(missing, [], 'ADRs missing from docs/adr/README.md');
  assert.ok(files.length > 0);
  for (const f of files)
    assert.ok(statSync(path.join(adrDir, f)).size > 200, `${f} is too short to be a decision record`);
});

/**
 * A package.json script whose name is also a pnpm command is shadowed: `pnpm <name>`
 * silently runs pnpm's own command instead of the script. `pnpm doctor` did exactly
 * that — CI ran pnpm's diagnostics for a step that was supposed to be ours, with
 * `continue-on-error: false` making it look enforced.
 */
const PNPM_COMMANDS = new Set([
  'add',
  'approve-builds',
  'audit',
  'bin',
  'config',
  'create',
  'dedupe',
  'deploy',
  'dlx',
  'doctor',
  'env',
  'exec',
  'fetch',
  'import',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'ls',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'root',
  'run',
  'server',
  'setup',
  'store',
  'unlink',
  'update',
  'why',
]);

test('scripts: no script name is shadowed by a pnpm command, or it is always invoked with "run"', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const shadowed = Object.keys(pkg.scripts ?? {}).filter((name) => PNPM_COMMANDS.has(name));

  // Wherever a shadowed script is documented or run in CI, it must say `pnpm run <name>`.
  const files = [
    '.github/workflows/build-desktop.yml',
    'CONTRIBUTING.md',
    'README.md',
    'docs/OPERATOR-GUIDE.md',
    'docs/DEVELOPMENT.md',
    'docs/releases/RELEASE-PROCESS.md',
  ].filter((f) => existsSync(path.join(root, f)));

  for (const name of shadowed) {
    for (const file of files) {
      const text = readFileSync(path.join(root, file), 'utf8');
      const bare = new RegExp(`(?<!run )\\bpnpm ${name}\\b`);
      assert.ok(!bare.test(text), `${file} invokes the shadowed script as "pnpm ${name}"; use "pnpm run ${name}"`);
    }
  }
});
