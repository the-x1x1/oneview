import { promises as fs, type Dirent } from 'node:fs';
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
 *     provider-cache/        provider response caches (bounded, deletable)
 *     tiles/                 map tiles kept by the desktop's tile cache (size-capped)
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
    // Not `cache`: Electron keeps Chromium's HTTP cache in `<userData>/Cache`, and on
    // Windows (and a default macOS volume) that is the same directory.
    cacheDir: path.join(abs, 'provider-cache'),
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
  await moveLegacyProviderCache(dirs);
}

/** Where provider caches lived until 0.1.0-rc.3: inside Chromium's `Cache` directory on Windows. */
export const LEGACY_PROVIDER_CACHE_DIR = 'cache';

/**
 * Carry provider cache files over from `<userData>/cache`, which on Windows is Chromium's
 * own `Cache` directory under another spelling. Only top-level `*.json` files move —
 * Chromium keeps its cache in subdirectories there and writes no such files — and only
 * where the new directory has no file of that name. Nothing is deleted; a file that cannot
 * be moved is left where it is and fetched afresh.
 */
export async function moveLegacyProviderCache(dirs: DataDirs): Promise<number> {
  const legacy = path.join(dirs.root, LEGACY_PROVIDER_CACHE_DIR);
  if (path.resolve(legacy) === path.resolve(dirs.cacheDir)) return 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(legacy, { withFileTypes: true });
  } catch {
    return 0;
  }
  let moved = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const target = path.join(dirs.cacheDir, e.name);
    try {
      await fs.access(target);
      continue;
    } catch {
      /* not there yet */
    }
    try {
      await fs.rename(path.join(legacy, e.name), target);
      moved++;
    } catch {
      /* left in place */
    }
  }
  return moved;
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
