import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  for (const block of doc.split(/\n(?=\*)/)) {
    if (!block.startsWith('*Verification:*')) continue;
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
    for (const field of ['*Threat:*', '*Mitigation:*', '*Verification:*', '*Residual:*']) {
      assert.ok(section.includes(field), `${heading} is missing ${field}`);
    }
  }
});

test('docs: the ADR index lists every ADR file', () => {
  const adrDir = path.join(root, 'docs', 'adr');
  const files = readdirSync(adrDir).filter((f) => /^ADR-\d+-.*\.md$/.test(f)).sort();
  const index = readFileSync(path.join(adrDir, 'README.md'), 'utf8');
  const missing = files.filter((f) => !index.includes(f.replace(/\.md$/, '')) && !index.includes(f));
  assert.deepEqual(missing, [], 'ADRs missing from docs/adr/README.md');
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(statSync(path.join(adrDir, f)).size > 200, `${f} is too short to be a decision record`);
});
