#!/usr/bin/env node
/**
 * pnpm phase-check [<phase>] [--base <ref>] [--json] [--list]
 *
 * Checks that a phase branch changed only what its phase owns (docs/roadmap/phases/
 * ownership.json): owned paths are fine, shared slot files are fine and listed for the
 * integrator, frozen contracts and another phase's paths are violations, and so is any
 * path nobody owns. The phase is taken from the argument or from the branch name
 * (`phase/<id>`); the base is the integration branch unless `--base` says otherwise. Exit 1
 * on a violation, 2 on a usage error. Read-only: it runs git diff and nothing else.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ownership = JSON.parse(readFileSync(path.join(root, 'docs', 'roadmap', 'phases', 'ownership.json'), 'utf8'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const list = args.includes('--list');
const baseIndex = args.indexOf('--base');
const baseArg = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== baseIndex + 1);

const gitRaw = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const git = (...a) => gitRaw(...a).trim();

if (list) {
  for (const [id, p] of Object.entries(ownership.phases)) {
    console.log(`${id.padEnd(20)} ${p.title}`);
    for (const g of p.owns) console.log(`${''.padEnd(20)}   ${g}`);
  }
  process.exit(0);
}

let phase = positional[0];
let branch = '';
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD');
} catch {
  console.error('[phase-check] not a git repository');
  process.exit(2);
}
if (!phase && branch.startsWith(ownership.branchPrefix))
  phase = branch.slice(ownership.branchPrefix.length).split('/')[0];
if (!phase || !ownership.phases[phase]) {
  console.error(
    `[phase-check] usage: pnpm phase-check <phase> [--base <ref>] — phases: ${Object.keys(ownership.phases).join(', ')}` +
      (phase ? ` (got "${phase}")` : ' (or check out a phase/<id> branch)'),
  );
  process.exit(2);
}
const base = baseArg ?? ownership.integrationBranch;
let mergeBase;
try {
  mergeBase = git('merge-base', base, 'HEAD');
} catch {
  console.error(`[phase-check] cannot find a merge base with ${base}; fetch it or pass --base`);
  process.exit(2);
}
const changed = git('diff', '--name-only', `${mergeBase}..HEAD`).split('\n').filter(Boolean);
const uncommitted = gitRaw('status', '--porcelain', '--untracked-files=all')
  .split('\n')
  .filter((l) => l.length > 3)
  .map((l) =>
    l
      .slice(3)
      .trim()
      .replace(/^.* -> /, ''),
  );

/** `**` any depth, `*` within one segment; case-insensitive; a trailing `/**` also matches the directory itself. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
const compile = (globs) => globs.map((g) => ({ glob: g, re: globToRegExp(g) }));
const frozen = compile(ownership.frozen.paths);
const shared = compile(ownership.shared.paths);
const mine = compile(ownership.phases[phase].owns);
const others = Object.entries(ownership.phases)
  .filter(([id]) => id !== phase)
  .map(([id, p]) => ({ id, rules: compile(p.owns) }));

function classify(file) {
  if (mine.some((r) => r.re.test(file))) return { kind: 'owned' };
  if (shared.some((r) => r.re.test(file))) return { kind: 'shared' };
  const other = others.find((o) => o.rules.some((r) => r.re.test(file)));
  if (other) return { kind: 'other-phase', detail: other.id };
  const f = frozen.find((r) => r.re.test(file));
  if (f) return { kind: 'frozen', detail: f.glob };
  return { kind: 'unowned' };
}

const files = [...new Set([...changed, ...uncommitted])].sort().map((file) => ({ file, ...classify(file) }));
const violations = files.filter((f) => f.kind !== 'owned' && f.kind !== 'shared');
const result = {
  phase,
  branch,
  base,
  mergeBase,
  files,
  sharedTouched: files.filter((f) => f.kind === 'shared').map((f) => f.file),
  violations: violations.map((f) => ({ file: f.file, kind: f.kind, detail: f.detail })),
  passed: violations.length === 0,
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(
    `[phase-check] phase=${phase} branch=${branch} base=${base} (${mergeBase.slice(0, 10)}) files=${files.length}`,
  );
  for (const f of files) {
    const mark = f.kind === 'owned' ? '  ' : f.kind === 'shared' ? ' ~' : ' ✗';
    console.log(`${mark} ${f.file}${f.kind === 'owned' ? '' : `  [${f.kind}${f.detail ? `: ${f.detail}` : ''}]`}`);
  }
  if (result.sharedTouched.length)
    console.log(
      `[phase-check] shared slot files touched: ${result.sharedTouched.length} (integrator reviews the slot lines)`,
    );
  if (violations.length) {
    console.log(`[phase-check] ${violations.length} violation(s):`);
    for (const v of violations)
      console.log(
        `  ${v.file}: ${
          v.kind === 'frozen'
            ? `frozen contract (${v.detail}) — request an amendment in docs/roadmap/phases/${phase}.md instead`
            : v.kind === 'other-phase'
              ? `owned by phase "${v.detail}"`
              : 'nobody owns this path; add it to the phase in ownership.json through the integrator'
        }`,
      );
  }
  console.log(`[phase-check] ${result.passed ? 'PASS' : 'FAIL'}`);
}
process.exit(result.passed ? 0 : 1);
