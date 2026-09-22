import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * userData layout. Every path the main process touches is derived from here so the
 * threat model can reason about one directory tree (docs/security/THREAT-MODEL.md,
 * "path traversal").
 *
 *   <userData>/
 *     settings.json          typed AppSettings + schemaVersion (SettingsStore)
 *     credentials.json       safeStorage-encrypted blobs (CredentialStore)
 *     collections.json       user collections
 *     watchzones.json        watch zones
 *     lenses.json            user lenses
 *     cameras.json           registered camera sources (URLs, no secrets)
 *     history/               DuckDB partitions (history-store)
 *     worldpacks/            installed offline packs
 *     cache/                 provider caches (bounded, deletable)
 *     logs/app.log           RotatingFileSink (JSON lines)
 */
export interface DataDirs {
  readonly root: string;
  readonly settingsFile: string;
  readonly credentialsFile: string;
  readonly collectionsFile: string;
  readonly watchzonesFile: string;
  readonly lensesFile: string;
  readonly camerasFile: string;
  readonly historyDir: string;
  readonly worldpacksDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly logFile: string;
}

export function dataDirs(root: string): DataDirs {
  const abs = path.resolve(root);
  return Object.freeze({
    root: abs,
    settingsFile: path.join(abs, 'settings.json'),
    credentialsFile: path.join(abs, 'credentials.json'),
    collectionsFile: path.join(abs, 'collections.json'),
    watchzonesFile: path.join(abs, 'watchzones.json'),
    lensesFile: path.join(abs, 'lenses.json'),
    camerasFile: path.join(abs, 'cameras.json'),
    historyDir: path.join(abs, 'history'),
    worldpacksDir: path.join(abs, 'worldpacks'),
    cacheDir: path.join(abs, 'cache'),
    logsDir: path.join(abs, 'logs'),
    logFile: path.join(abs, 'logs', 'app.log'),
  });
}

export const DATA_SUBDIRS = [
  'historyDir',
  'worldpacksDir',
  'cacheDir',
  'logsDir',
] as const satisfies readonly (keyof DataDirs)[];

export async function ensureDataDirs(dirs: DataDirs): Promise<void> {
  await fs.mkdir(dirs.root, { recursive: true });
  for (const key of DATA_SUBDIRS) await fs.mkdir(dirs[key], { recursive: true });
}

/**
 * True when `candidate` resolves inside `root` (no `..` escapes, no absolute jumps).
 * Used by every code path that turns user- or pack-supplied names into file paths.
 */
export function isInsideDir(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(root, candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Probe write to check that a directory is writable; the probe file is removed again. */
export async function probeWritable(dir: string): Promise<{ writable: boolean; error?: string }> {
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, 'probe');
    await fs.unlink(probe);
    return { writable: true };
  } catch (err) {
    return { writable: false, error: err instanceof Error ? err.message : String(err) };
  }
}
