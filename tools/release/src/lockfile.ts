/**
 * Minimal pnpm-lock.yaml reader.
 *
 * The SBOM must list what a build actually resolved, so it is derived from the
 * lockfile rather than from package.json ranges. pnpm's lockfile is a small, regular
 * subset of YAML (two-space indentation, quoted keys, scalar values), so this parser
 * handles that subset directly instead of taking a YAML dependency — one less thing
 * in the supply chain of the tool that audits the supply chain.
 *
 * Supported: lockfileVersion 6.x and 9.x (`packages:` / `snapshots:` sections).
 */
export interface LockedPackage {
  /** Bare package name, e.g. `@duckdb/node-api`. */
  name: string;
  version: string;
  /** Integrity hash as recorded by the registry (sha512-…). */
  integrity?: string;
  /** True when the package is only needed to build/test, never shipped. */
  dev: boolean;
  /** Direct importers that requested it (workspace paths), when the lockfile records them. */
  importers: string[];
}

export interface ParsedLockfile {
  lockfileVersion: string;
  packages: LockedPackage[];
  /** Workspace importers (`.`, `apps/desktop`, `packages/core`, …). */
  importers: string[];
}

interface Line {
  indent: number;
  key?: string;
  value?: string;
  raw: string;
}

function scan(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();
    const m = body.match(/^('([^']*)'|"([^"]*)"|[^:]+):\s*(.*)$/);
    if (m) {
      const value = m[4] === '' ? undefined : m[4];
      out.push({ indent, key: m[2] ?? m[3] ?? m[1]!.trim(), ...(value !== undefined ? { value } : {}), raw });
    } else out.push({ indent, raw: body });
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

/** `/@scope/name@1.2.3(peer@1)` or `@scope/name@1.2.3` → { name, version }. */
export function parsePackageKey(key: string): { name: string; version: string } | undefined {
  let k = unquote(key);
  if (k.startsWith('/')) k = k.slice(1);
  k = k.replace(/\(.*\)$/, '');
  const at = k.lastIndexOf('@');
  if (at <= 0) return undefined;
  const name = k.slice(0, at);
  const version = k.slice(at + 1);
  if (!name || !version || !/^[0-9]/.test(version)) return undefined;
  return { name, version };
}

export function parseLockfile(text: string): ParsedLockfile {
  const lines = scan(text);
  const versionLine = lines.find((l) => l.key === 'lockfileVersion');
  const lockfileVersion = versionLine?.value ? unquote(versionLine.value) : 'unknown';

  const importers: string[] = [];
  const packages = new Map<string, LockedPackage>();

  let section: 'importers' | 'packages' | 'snapshots' | undefined;
  let sectionIndent = 0;
  let current: LockedPackage | undefined;
  let currentIndent = 0;

  for (const line of lines) {
    if (line.indent === 0 && line.key) {
      section = line.key === 'importers' || line.key === 'packages' || line.key === 'snapshots' ? line.key : undefined;
      sectionIndent = 0;
      current = undefined;
      continue;
    }
    if (!section) continue;

    if (section === 'importers') {
      if (line.indent === sectionIndent + 2 && line.key) importers.push(unquote(line.key));
      continue;
    }

    // packages: / snapshots:
    if (line.indent === sectionIndent + 2 && line.key) {
      const parsed = parsePackageKey(line.key);
      currentIndent = line.indent;
      current = undefined;
      if (!parsed) continue;
      const id = `${parsed.name}@${parsed.version}`;
      current = packages.get(id) ?? { name: parsed.name, version: parsed.version, dev: false, importers: [] };
      packages.set(id, current);
      continue;
    }
    if (current && line.indent > currentIndent && line.key) {
      // v9 records the hash inline: `resolution: {integrity: sha512-…}`; v6 nests it.
      if (line.key === 'resolution' && line.value) {
        const inline = line.value.match(/integrity:\s*([A-Za-z0-9+/=-]+)/);
        if (inline?.[1]) current.integrity = inline[1];
      }
      if (line.key === 'integrity' && line.value) current.integrity = unquote(line.value);
      if (line.key === 'dev' && line.value) current.dev = unquote(line.value) === 'true';
    }
  }

  return {
    lockfileVersion,
    importers,
    packages: [...packages.values()].sort((a, b) =>
      a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
    ),
  };
}
