/**
 * How a path is classified against docs/roadmap/phases/ownership.json: owned by the phase,
 * a shared slot file, another phase's, frozen, or nobody's. `phase-check.mjs` runs it over a
 * branch's changes; `phase-check.test.ts` runs it over the repository's files to check that
 * the ownership file itself says what the round means it to (a shipped connector is frozen,
 * not owned). Pure: no git, no file system.
 */

/** `**` any depth, `*` within one segment; case-insensitive; a trailing `/**` also matches the directory itself. */
export function globToRegExp(glob) {
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

/**
 * A classifier for one phase: `(file) → { kind, detail? }`, kind being `owned`, `shared`,
 * `other-phase` (detail: its id), `frozen` (detail: the glob) or `unowned`. A phase's own
 * globs win over everything, so a phase may own a subdirectory of a frozen one.
 */
export function classifierFor(ownership, phase) {
  const frozen = compile(ownership.frozen.paths);
  const shared = compile(ownership.shared.paths);
  const mine = compile(ownership.phases[phase].owns);
  const others = Object.entries(ownership.phases)
    .filter(([id]) => id !== phase)
    .map(([id, p]) => ({ id, rules: compile(p.owns) }));
  return (file) => {
    if (mine.some((r) => r.re.test(file))) return { kind: 'owned' };
    if (shared.some((r) => r.re.test(file))) return { kind: 'shared' };
    const other = others.find((o) => o.rules.some((r) => r.re.test(file)));
    if (other) return { kind: 'other-phase', detail: other.id };
    const f = frozen.find((r) => r.re.test(file));
    if (f) return { kind: 'frozen', detail: f.glob };
    return { kind: 'unowned' };
  };
}
