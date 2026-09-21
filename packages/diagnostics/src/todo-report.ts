import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Production-tree marker report (directive §140: no deferred work hiding in shipped
 * code). Scans source trees for work-marker tags inside comments and reports each
 * occurrence; the release gate fails when the count is non-zero.
 *
 * Only comment lines are considered (`//`, `/*`, `*`, `#`, `<!--`) so identifiers
 * that happen to contain a tag word (environment variable names, constants) do not
 * count. Tests, fixtures, docs and generated output are excluded because they
 * legitimately describe these markers.
 */
export const TODO_TAGS = ['TODO', 'FIXME', 'HACK', 'TEMP', 'PLACEHOLDER', 'XXX'] as const;
export type TodoTag = (typeof TODO_TAGS)[number];

export interface TodoEntry { file: string; line: number; tag: TodoTag; text: string }

export interface TodoReport {
  ranAt: string;
  root: string;
  roots: string[];
  filesScanned: number;
  count: number;
  entries: TodoEntry[];
}

export interface TodoReportOptions {
  /** Relative directories to scan; defaults to the production trees. */
  roots?: string[];
  extensions?: string[];
  now?: () => number;
}

export const DEFAULT_TODO_ROOTS = ['packages', 'providers', 'apps', 'tools'];
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '.css', '.html', '.yml', '.yaml', '.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'release', '.vite', 'build-output', 'test', 'tests', '__tests__', 'fixtures', 'docs', 'type-shims', '.git']);
const TAG_RE = new RegExp(`\\b(${TODO_TAGS.join('|')})\\b`);
const COMMENT_RE = /(^|\s)(\/\/|\/\*|\*|#|<!--)/;

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else if (e.isFile()) yield abs;
  }
}

export function scanText(text: string): Array<{ line: number; tag: TodoTag; text: string }> {
  const out: Array<{ line: number; tag: TodoTag; text: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const commentAt = line.search(COMMENT_RE);
    if (commentAt < 0) continue;
    const comment = line.slice(commentAt);
    const m = TAG_RE.exec(comment);
    if (!m) continue;
    out.push({ line: i + 1, tag: m[1] as TodoTag, text: comment.trim().slice(0, 200) });
  }
  return out;
}

export async function todoReport(rootDir: string, opts: TodoReportOptions = {}): Promise<TodoReport> {
  const roots = opts.roots ?? DEFAULT_TODO_ROOTS;
  const exts = new Set(opts.extensions ?? DEFAULT_EXTENSIONS);
  const entries: TodoEntry[] = [];
  let filesScanned = 0;
  for (const rel of roots) {
    for await (const file of walk(path.join(rootDir, rel))) {
      if (!exts.has(path.extname(file)) || isTestFile(path.basename(file))) continue;
      filesScanned++;
      const text = await fs.readFile(file, 'utf8');
      const relFile = path.relative(rootDir, file).split(path.sep).join('/');
      for (const hit of scanText(text)) entries.push({ file: relFile, ...hit });
    }
  }
  entries.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return { ranAt: new Date((opts.now ?? Date.now)()).toISOString(), root: path.resolve(rootDir), roots, filesScanned, count: entries.length, entries };
}
