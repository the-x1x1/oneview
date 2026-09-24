import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OGR_INPUT_EXTENSIONS,
  OGR_LAYER_NAME,
  ProviderError,
  checkRelativePath,
  extensionOf,
  type GrantedFileStat,
  type Ogr2ogrAccess,
  type Ogr2ogrDetection,
  type Ogr2ogrRequest,
} from '@worldview/provider-sdk';

/**
 * The host side of a granted folder (ADR-003, amendments 2026-09-23 for phase `files`).
 *
 * Reads inside a granted folder: the relative path passes the SDK's own rule
 * (`checkRelativePath`), then the folder's and the file's real paths (links, junctions and
 * `..` resolved by the OS) are compared, so a link that leads out of the folder is refused
 * however it is spelt. Only regular files are read (a FIFO would block forever); the handle
 * opened is checked to be the file that was checked (same device and inode) before a byte is
 * read, and one byte past the limit is read so a file that grew is refused, not cut.
 *
 * ogr2ogr: found on PATH (an `.exe` on Windows: Node refuses to run `.bat`/`.cmd` without a
 * shell, and there is never a shell), run with a fixed argument list, a minimal environment
 * (no WORLDVIEW secrets), a timeout and a fresh temporary directory that is always removed.
 * GDAL is the user's own install; the app never distributes or installs it (directive §141).
 */
export const HOST_MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface ResolvedGrantedPath {
  root: string;
  real: string;
  stat: Stats;
}

async function realFolderOf(folder: string | undefined): Promise<string> {
  if (!folder || !folder.trim())
    throw new ProviderError('UNSUPPORTED', 'no folder is granted to this source; name one in its folder setting', {
      retryable: false,
    });
  try {
    const real = await fs.realpath(folder);
    if (!(await fs.stat(real)).isDirectory()) throw new Error('not a folder');
    return real;
  } catch {
    throw new ProviderError('UNSUPPORTED', 'the granted folder does not exist or is not a folder', {
      retryable: false,
    });
  }
}

/** Whether `target` is strictly inside `root` (both real paths). Case-insensitive on Windows, as the file system is. */
export function isStrictlyInside(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
}

/** A relative path resolved against the granted folder's real path, or the typed refusal. */
export async function resolveGrantedPath(
  folder: string | undefined,
  relative: string,
  opts: { allowDirectory?: boolean } = {},
): Promise<ResolvedGrantedPath> {
  const verdict = checkRelativePath(relative);
  if (!verdict.ok) throw new ProviderError('HOST_NOT_ALLOWED', verdict.reason, { retryable: false });
  const root = await realFolderOf(folder);
  const candidate = path.join(root, ...verdict.segments);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP')
      throw new ProviderError('HOST_NOT_ALLOWED', `${verdict.path} is a loop of links`, { retryable: false });
    throw new ProviderError('UNSUPPORTED', `${verdict.path} does not exist in the granted folder`, {
      retryable: false,
    });
  }
  if (!isStrictlyInside(root, real))
    throw new ProviderError(
      'HOST_NOT_ALLOWED',
      `${verdict.path} leads outside the granted folder (a link or junction)`,
      {
        retryable: false,
      },
    );
  const stat = await fs.stat(real);
  if (stat.isDirectory() && !opts.allowDirectory)
    throw new ProviderError('UNSUPPORTED', `${verdict.path} is a folder, not a file`, { retryable: false });
  if (!stat.isFile() && !stat.isDirectory())
    throw new ProviderError('UNSUPPORTED', `${verdict.path} is not a regular file`, { retryable: false });
  return { root, real, stat };
}

/** Size and modification time of a granted file, under the same checks as a read. */
export async function statGrantedFile(folder: string | undefined, relative: string): Promise<GrantedFileStat> {
  const { stat } = await resolveGrantedPath(folder, relative);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

/** The bytes of a granted file, refused before a byte is read when over `limit`. */
export async function readGrantedFile(
  folder: string | undefined,
  relative: string,
  limit: number,
): Promise<Uint8Array> {
  const { real, stat } = await resolveGrantedPath(folder, relative);
  if (stat.size > limit) throw new ProviderError('TOO_LARGE', `the file exceeds ${limit} bytes`, { retryable: false });
  const handle = await fs.open(real, fsConstants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new ProviderError('HOST_NOT_ALLOWED', 'the file was replaced while it was opened', { retryable: false });
    // Read one byte past the limit: a file that grew after the check is refused, not cut.
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(opened.size, 0) + 1));
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled >= buffer.length) break;
    }
    if (filled > limit) throw new ProviderError('TOO_LARGE', `the file exceeds ${limit} bytes`, { retryable: false });
    return new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
  } finally {
    await handle.close();
  }
}

// ── ogr2ogr ──────────────────────────────────────────────────────────────────

export interface Ogr2ogrHostOptions {
  /** The folder granted to the source, or a function answering the current one. */
  folder: string | undefined | (() => string | undefined);
  /** How ogr2ogr is started. Default: found on PATH. `null`: not installed. Tests pass a stand-in. */
  program?: { command: string; args: string[] } | null;
  /** The PATH searched (default: this process's). */
  searchPath?: string;
  /** The environment the child's is filtered from (default: this process's). */
  env?: NodeJS.ProcessEnv;
  tmpDir?: string;
}

const SHAPEFILE_PARTS = ['shp', 'shx', 'dbf', 'prj', 'cpg'];
/** Variables passed to ogr2ogr: what it needs to run and find its data. Nothing else (no WORLDVIEW secrets). */
const ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL|LC_CTYPE)$/i;
const ENV_KEEP_PREFIX = /^(GDAL_|PROJ_|OGR_|CPL_|GEOTIFF_)/i;

export function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent))
    if (v !== undefined && (ENV_KEEP.test(k) || ENV_KEEP_PREFIX.test(k)) && !/^(ONEVIEW|WORLDVIEW)_/i.test(k))
      out[k] = v;
  return out;
}

export async function findOnPath(
  name: string,
  searchPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<{ command: string; args: string[] } | undefined> {
  const dirs = (searchPath ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    try {
      const st = await fs.stat(candidate);
      if (!st.isFile()) continue;
      if (platform !== 'win32') await fs.access(candidate, fsConstants.X_OK);
      return { command: candidate, args: [] };
    } catch {
      /* not in this directory */
    }
  }
  return undefined;
}

function run(
  command: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: opts.timeoutMs,
        env: opts.env,
        windowsHide: true,
        shell: false,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (opts.signal?.aborted || e.name === 'AbortError')
          return reject(new ProviderError('CANCELLED', 'the conversion was cancelled'));
        if (e.code === 'ENOENT' || e.code === 'EACCES')
          return reject(new ProviderError('UNSUPPORTED', 'ogr2ogr could not be started', { retryable: false }));
        if (e.killed || e.signal === 'SIGTERM')
          return reject(new ProviderError('TIMEOUT', `ogr2ogr did not finish within ${opts.timeoutMs} ms`));
        const last = String(stderr).trim().split(/\r?\n/).pop() ?? '';
        reject(
          new ProviderError('MALFORMED', `ogr2ogr failed${last ? `: ${last.slice(0, 300)}` : ''}`, {
            retryable: false,
          }),
        );
      },
    );
  });
}

/**
 * The files GDAL will open for a dataset: a shapefile's parts beside it, or the files directly
 * inside a `.gdb` folder. Each must really be inside the granted folder — a part that is a link
 * out of it would have GDAL read outside the grant — or the dataset is refused.
 */
async function datasetParts(resolved: ResolvedGrantedPath, ext: string): Promise<Stats[]> {
  const { root, real, stat } = resolved;
  const inside = async (file: string): Promise<Stats> => {
    const partReal = await fs.realpath(file);
    if (!isStrictlyInside(root, partReal))
      throw new ProviderError('HOST_NOT_ALLOWED', `${path.basename(file)} leads outside the granted folder`, {
        retryable: false,
      });
    return fs.stat(partReal);
  };
  if (stat.isDirectory()) {
    if (ext !== 'gdb')
      throw new ProviderError('UNSUPPORTED', 'a folder was named where a file was expected', { retryable: false });
    const parts: Stats[] = [];
    for (const entry of await fs.readdir(real, { withFileTypes: true }))
      if (entry.isFile() || entry.isSymbolicLink()) {
        const st = await inside(path.join(real, entry.name));
        if (st.isFile()) parts.push(st);
      }
    return parts;
  }
  const parts: Stats[] = [stat];
  if (ext === 'shp') {
    const dir = path.dirname(real);
    const base = path.basename(real).slice(0, -4).toLowerCase();
    for (const entry of await fs.readdir(dir)) {
      const lower = entry.toLowerCase();
      const dot = lower.lastIndexOf('.');
      if (dot < 0 || lower.slice(0, dot) !== base) continue;
      const partExt = lower.slice(dot + 1);
      if (partExt === 'shp' || !SHAPEFILE_PARTS.includes(partExt)) continue;
      parts.push(await inside(path.join(dir, entry)));
    }
  }
  return parts;
}

export function createOgr2ogrAccess(opts: Ogr2ogrHostOptions): Ogr2ogrAccess {
  const env = childEnvironment(opts.env ?? process.env);
  const folder = (): string | undefined => (typeof opts.folder === 'function' ? opts.folder() : opts.folder);
  const program = async () =>
    opts.program !== undefined
      ? (opts.program ?? undefined)
      : findOnPath('ogr2ogr', opts.searchPath ?? process.env['PATH'] ?? process.env['Path']);
  const checkInput = (input: string) => {
    const verdict = checkRelativePath(input);
    if (!verdict.ok) throw new ProviderError('HOST_NOT_ALLOWED', verdict.reason, { retryable: false });
    const ext = extensionOf(verdict.path);
    if (!OGR_INPUT_EXTENSIONS.includes(ext))
      throw new ProviderError('UNSUPPORTED', `.${ext || '(none)'} is not a format the host converts`, {
        retryable: false,
      });
    return ext;
  };
  return {
    async detect(): Promise<Ogr2ogrDetection> {
      const p = await program();
      if (!p) return { found: false, reason: 'ogr2ogr is not on PATH' };
      try {
        const { stdout } = await run(p.command, [...p.args, '--version'], { timeoutMs: 10_000, env });
        const m = /GDAL\s+(\d+(?:\.\d+){1,3}[^,\s]*)/.exec(stdout);
        return m
          ? { found: true, version: m[1]! }
          : { found: false, reason: 'ogr2ogr --version named no GDAL version' };
      } catch (err) {
        return { found: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async datasetStat(input): Promise<GrantedFileStat> {
      const ext = checkInput(input);
      const resolved = await resolveGrantedPath(folder(), input, { allowDirectory: ext === 'gdb' });
      let size = 0;
      let mtimeMs = resolved.stat.mtimeMs;
      for (const part of await datasetParts(resolved, ext)) {
        size += part.size;
        mtimeMs = Math.max(mtimeMs, part.mtimeMs);
      }
      return { size, mtimeMs };
    },
    async toGeoJson(req: Ogr2ogrRequest): Promise<Uint8Array> {
      const ext = checkInput(req.input);
      if (req.layer !== undefined && !OGR_LAYER_NAME.test(req.layer))
        throw new ProviderError('HOST_NOT_ALLOWED', 'the layer name is not allowed', { retryable: false });
      const resolved = await resolveGrantedPath(folder(), req.input, { allowDirectory: ext === 'gdb' });
      await datasetParts(resolved, ext);
      const real = resolved.real;
      const p = await program();
      if (!p) throw new ProviderError('UNSUPPORTED', 'ogr2ogr is not installed', { retryable: false });
      const limit = Math.min(req.maxOutputBytes ?? HOST_MAX_FILE_BYTES, HOST_MAX_FILE_BYTES);
      if (limit <= 0) throw new ProviderError('TOO_LARGE', 'no room left under the size limit', { retryable: false });
      const tmp = await fs.mkdtemp(path.join(opts.tmpDir ?? os.tmpdir(), 'worldview-ogr-'));
      try {
        const out = path.join(tmp, 'out.geojson');
        const args = [
          ...p.args,
          '-f',
          'GeoJSON',
          '-t_srs',
          'EPSG:4326',
          '-lco',
          'RFC7946=YES',
          out,
          real,
          ...(req.layer ? [req.layer] : []),
        ];
        await run(p.command, args, {
          timeoutMs: req.timeoutMs ?? 120_000,
          env,
          ...(req.signal ? { signal: req.signal } : {}),
        });
        let st: Stats;
        try {
          st = await fs.stat(out);
        } catch {
          throw new ProviderError('MALFORMED', 'ogr2ogr finished but wrote nothing', { retryable: false });
        }
        if (st.size > limit)
          throw new ProviderError('TOO_LARGE', `the converted GeoJSON exceeds ${limit} bytes`, { retryable: false });
        return new Uint8Array(await fs.readFile(out));
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  };
}
