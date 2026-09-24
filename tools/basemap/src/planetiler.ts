import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { GeoBounds } from '@worldview/world-model';

/**
 * Planetiler, as the basemap builder uses it: found on this machine, never downloaded, and
 * run with every download switch off on inputs the operator already has.
 *
 * The profile is Protomaps' own (github.com/protomaps/basemaps, `tiles/`), which is a
 * Planetiler application: its jar bundles Planetiler and writes the Protomaps basemap
 * schema (`earth`, `water`, `roads`, `places`, `boundaries`, …) that the app's 2D styles
 * read. Planetiler's stock OpenMapTiles profile writes different layers, which those styles
 * would not draw, so a jar without `com/protomaps/basemap/Basemap.class` is refused.
 *
 * The profile would fetch inputs on its own: every source with `--download` or a
 * `refresh_<source>` switch, and two files (`qrank.csv.gz`, `pgf-encoding.zip`) whenever
 * they are absent from `data/sources/` under its working directory, flag or no flag. So:
 *
 *   - every input must be on disk before Java starts;
 *   - the jar is recognised from its contents and never run to ask what it is (running it
 *     with an unknown argument would start a build in whatever directory it was run from);
 *   - the command line sets `download`, `only_download`, `refresh_sources`, each
 *     `refresh_<source>` and `fetch_wikidata` to false (explicit arguments win over
 *     Planetiler's other two argument sources);
 *   - Java runs without `PLANETILER_*` variables and without `JAVA_TOOL_OPTIONS`,
 *     `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS`, through which a `planetiler.*` property (a
 *     `planetiler.config` file, say) could switch anything back on.
 */

/** Planetiler and the Protomaps profile need Java 21 or newer (protomaps/basemaps README). */
export const MIN_JAVA_MAJOR = 21;
/** The class every Protomaps basemap jar carries; how a jar is recognised without running it. */
export const PROTOMAPS_PROFILE_CLASS = 'com/protomaps/basemap/Basemap.class';
/** File names the builder looks for on PATH when no jar is named. */
export const PROTOMAPS_JAR_PATTERN = /^protomaps-basemap-.*-with-deps\.jar$/i;
/** Environment variable naming the jar (the CLI's `--jar` wins over it). */
export const JAR_ENV = 'ONEVIEW_PLANETILER_JAR';

/**
 * The inputs the Protomaps profile reads besides the OSM extract, all under
 * `<work>/data/sources/` (the two without an argument are read from exactly there).
 * `url` is where the operator can get each one; the builder never fetches it.
 */
export interface ProfileSource {
  file: string;
  /** Planetiler argument that names the path, when the profile has one. */
  arg?: string;
  what: string;
  url: string;
  licence: string;
}

export const PROFILE_SOURCES: readonly ProfileSource[] = Object.freeze([
  {
    file: 'natural_earth_vector.gpkg.zip',
    arg: 'ne_path',
    what: 'Natural Earth vector data (low zooms)',
    url: 'https://naciscdn.org/naturalearth/packages/natural_earth_vector.gpkg.zip',
    licence: 'public domain',
  },
  {
    file: 'water-polygons-split-3857.zip',
    arg: 'osm_water_path',
    what: 'OSM water polygons (osmcoastline)',
    url: 'https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip',
    licence: 'ODbL 1.0, © OpenStreetMap contributors',
  },
  {
    file: 'land-polygons-split-3857.zip',
    arg: 'osm_land_path',
    what: 'OSM land polygons (osmcoastline)',
    url: 'https://osmdata.openstreetmap.de/download/land-polygons-split-3857.zip',
    licence: 'ODbL 1.0, © OpenStreetMap contributors',
  },
  {
    file: 'daylight-landcover.gpkg',
    arg: 'landcover_path',
    what: 'Daylight landcover (from ESA WorldCover)',
    url: 'https://r2-public.protomaps.com/datasets/daylight-landcover.gpkg',
    licence: 'CC BY 4.0, ESA WorldCover',
  },
  {
    file: 'qrank.csv.gz',
    what: 'QRank (Wikidata popularity, orders place labels)',
    url: 'https://qrank.toolforge.org/download/qrank.csv.gz',
    licence: 'CC0 1.0',
  },
  {
    file: 'pgf-encoding.zip',
    what: 'Font encoding tables for label text',
    url: 'https://wipfli.github.io/pgf-encoding/pgf-encoding.zip',
    licence: 'encodings CC0, fonts SIL Open Font License, code MIT',
  },
]);

export type Platform = NodeJS.Platform;

/** A command's result; `error` when it could not be started at all. */
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type Exec = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

/** Output beyond this is dropped: `java -version` and `--version` print a few lines. */
const EXEC_OUTPUT_CAP = 64 * 1024;

export const execCommand: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: errText(err) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout, stderr, error: `timed out after ${opts.timeoutMs} ms` });
    }, opts.timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < EXEC_OUTPUT_CAP) stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < EXEC_OUTPUT_CAP) stderr += b.toString('utf8');
    });
    child.on('error', (err) => done({ code: null, stdout, stderr, error: errText(err) }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });

/**
 * The Java launcher variables that can carry `-Dplanetiler.*` system properties, directly or
 * through an `@argfile` or `-XX:VMOptionsFile` whose contents the variable does not show.
 * Planetiler needs nothing from them, so Java runs without them.
 */
export const JVM_OPTION_VARIABLES: readonly string[] = Object.freeze([
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  '_JAVA_OPTIONS',
]);

/** The environment Java runs with: this process's, minus anything that could configure Planetiler. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env))
    if (!/^planetiler_/i.test(k) && !JVM_OPTION_VARIABLES.includes(k.toUpperCase())) out[k] = v;
  return out;
}

/** `java -version` output → the major version (8 for `1.8.0_392`, 21 for `21.0.10`). */
export function parseJavaMajor(text: string): number | undefined {
  const m = /version\s+"(\d+)(?:\.(\d+))?[^"]*"/.exec(text);
  if (!m) return undefined;
  const first = Number(m[1]);
  if (first === 1 && m[2] !== undefined) return Number(m[2]);
  return Number.isFinite(first) ? first : undefined;
}

function pathEntries(env: NodeJS.ProcessEnv, platform: Platform): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  return raw
    .split(platform === 'win32' ? ';' : ':')
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
    .filter((p) => p !== '');
}

function executableNames(base: string, env: NodeJS.ProcessEnv, platform: Platform): string[] {
  if (platform !== 'win32') return [base];
  const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  return [base, ...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)];
}

export interface FileProbe {
  isFile(p: string): Promise<boolean>;
  listDir(dir: string): Promise<string[]>;
}

export const diskProbe: FileProbe = {
  async isFile(p) {
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) return false;
      await fs.access(p, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  async listDir(dir) {
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  },
};

/** Where `java` is looked for, in order: the flag, JAVA_HOME, then every PATH entry. */
export async function javaCandidates(
  opts: { javaFlag?: string; env: NodeJS.ProcessEnv; platform: Platform },
  probe: FileProbe = diskProbe,
): Promise<string[]> {
  if (opts.javaFlag) return [opts.javaFlag];
  const out: string[] = [];
  const pathMod = opts.platform === 'win32' ? path.win32 : path.posix;
  const home = opts.env.JAVA_HOME?.trim();
  if (home)
    for (const name of executableNames('java', opts.env, opts.platform)) {
      const p = pathMod.join(home, 'bin', name);
      if (await probe.isFile(p)) {
        out.push(p);
        break;
      }
    }
  for (const dir of pathEntries(opts.env, opts.platform))
    for (const name of executableNames('java', opts.env, opts.platform)) {
      const p = pathMod.join(dir, name);
      if (!out.includes(p) && (await probe.isFile(p))) {
        out.push(p);
        break;
      }
    }
  return out;
}

export type JavaDetection =
  | { ok: true; path: string; major: number; versionLine: string }
  | { ok: false; reason: string; tried: string[] };

/** The first candidate that runs and is Java 21 or newer. */
export async function detectJava(
  opts: { javaFlag?: string; env: NodeJS.ProcessEnv; platform: Platform },
  exec: Exec = execCommand,
  probe: FileProbe = diskProbe,
): Promise<JavaDetection> {
  const candidates = await javaCandidates(opts, probe);
  if (candidates.length === 0)
    return {
      ok: false,
      tried: [],
      reason:
        'no Java found (looked at --java, JAVA_HOME and PATH). Install a Java 21+ runtime yourself; this tool does not download one',
    };
  const problems: string[] = [];
  for (const candidate of candidates) {
    const r = await exec(candidate, ['-version'], { timeoutMs: 30_000, env: scrubbedEnv(opts.env) });
    if (r.error) {
      problems.push(`${candidate}: ${r.error}`);
      continue;
    }
    const text = `${r.stderr}\n${r.stdout}`;
    const major = parseJavaMajor(text);
    if (major === undefined) {
      problems.push(`${candidate}: could not read a version from "java -version"`);
      continue;
    }
    if (major < MIN_JAVA_MAJOR) {
      problems.push(`${candidate}: Java ${major}, but Planetiler needs ${MIN_JAVA_MAJOR} or newer`);
      continue;
    }
    const versionLine =
      text
        .split(/\r?\n/)
        .find((l) => /version\s+"/.test(l))
        ?.trim() ?? `Java ${major}`;
    return { ok: true, path: candidate, major, versionLine };
  }
  return { ok: false, tried: candidates, reason: problems.join('; ') };
}

/** Where the jar is looked for, in order: the flag, the environment variable, PATH entries. */
export async function jarCandidates(
  opts: { jarFlag?: string; env: NodeJS.ProcessEnv; platform: Platform },
  probe: FileProbe = diskProbe,
): Promise<string[]> {
  if (opts.jarFlag) return [opts.jarFlag];
  const fromEnv = opts.env[JAR_ENV]?.trim();
  if (fromEnv) return [fromEnv];
  const out: string[] = [];
  const pathMod = opts.platform === 'win32' ? path.win32 : path.posix;
  for (const dir of pathEntries(opts.env, opts.platform)) {
    const names = (await probe.listDir(dir)).filter((n) => PROTOMAPS_JAR_PATTERN.test(n)).sort();
    for (const n of names) {
      const p = pathMod.join(dir, n);
      if (await probe.isFile(p)) out.push(p);
    }
  }
  return out;
}

/**
 * Whether a jar carries `name`, read from its central directory (zip64 included) without
 * running anything in it.
 */
export async function jarContains(file: string, name: string): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) return false;
    const tailLen = Math.min(size, 65_557 + 20);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) return false;
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // zip64: the locator sits just before the classic record and points at the zip64 one.
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) return false;
      const recOffset = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      await handle.read(rec, 0, 56, recOffset);
      if (rec.readUInt32LE(0) !== 0x06064b50) return false;
      entries = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size || cdSize > 256 * 1024 * 1024) return false;
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    const wanted = Buffer.from(name, 'utf8');
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return false;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (nameLen === wanted.length && cd.subarray(p + 46, p + 46 + nameLen).equals(wanted)) return true;
      p += 46 + nameLen + extraLen + commentLen;
    }
    return false;
  } finally {
    await handle.close();
  }
}

export type JarDetection = { ok: true; path: string; sha256: string } | { ok: false; reason: string; tried: string[] };

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * The first candidate that is a Protomaps basemap jar, told from its central directory.
 * It is not run here; its SHA-256 identifies the build in the report.
 */
export async function detectProtomapsJar(
  opts: { jarFlag?: string; env: NodeJS.ProcessEnv; platform: Platform },
  probe: FileProbe = diskProbe,
): Promise<JarDetection> {
  const candidates = await jarCandidates(opts, probe);
  if (candidates.length === 0)
    return {
      ok: false,
      tried: [],
      reason: `no Protomaps basemap jar found (looked at --jar, ${JAR_ENV} and PATH for protomaps-basemap-*-with-deps.jar). Build it yourself from github.com/protomaps/basemaps (tiles/, "mvn clean package"); this tool does not download it`,
    };
  const problems: string[] = [];
  for (const candidate of candidates) {
    if (!(await probe.isFile(candidate))) {
      problems.push(`${candidate}: not a readable file`);
      continue;
    }
    let isProfile: boolean;
    try {
      isProfile = await jarContains(candidate, PROTOMAPS_PROFILE_CLASS);
    } catch (err) {
      problems.push(`${candidate}: ${errText(err)}`);
      continue;
    }
    if (!isProfile) {
      problems.push(
        `${candidate}: not the Protomaps basemap profile (no ${PROTOMAPS_PROFILE_CLASS}; a stock planetiler.jar writes OpenMapTiles layers, which the app's styles do not draw)`,
      );
      continue;
    }
    return { ok: true, path: candidate, sha256: await sha256OfFile(candidate) };
  }
  return { ok: false, tried: candidates, reason: problems.join('; ') };
}

/** `<work>/data/sources`: where the profile reads its inputs from. */
export function sourcesDir(workDir: string): string {
  return path.join(workDir, 'data', 'sources');
}

/** The profile inputs missing from `<work>/data/sources`. Empty means Java may start. */
export async function missingSources(workDir: string, probe: FileProbe = diskProbe): Promise<ProfileSource[]> {
  const dir = sourcesDir(workDir);
  const missing: ProfileSource[] = [];
  for (const s of PROFILE_SOURCES) if (!(await probe.isFile(path.join(dir, s.file)))) missing.push(s);
  return missing;
}

/** The profile's source names, each with its own `refresh_<name>` switch in Planetiler. */
export const REFRESH_SOURCE_NAMES: readonly string[] = Object.freeze([
  'osm',
  'ne',
  'osm_water',
  'osm_land',
  'landcover',
]);

export interface PlanetilerRun {
  jar: string;
  osmPath: string;
  workDir: string;
  /** The PMTiles file Planetiler writes (overwritten). */
  output: string;
  /** Planetiler's scratch directory: one this tool created for the run, and removes. */
  tmpDir: string;
  bounds: GeoBounds;
  maxZoom: number;
  /** Java heap, e.g. `4g`; Java's default when absent. */
  memory?: string;
  threads?: number;
}

/**
 * The Java command line. Every input path is explicit, every download and refresh switch
 * is off, and nothing on it is a URL.
 */
export function planetilerArgs(run: PlanetilerRun): string[] {
  const dir = sourcesDir(run.workDir);
  const b = run.bounds;
  const args: string[] = [];
  if (run.memory) args.push(`-Xmx${run.memory}`);
  args.push(
    '-jar',
    run.jar,
    `--osm_path=${run.osmPath}`,
    ...PROFILE_SOURCES.filter((s) => s.arg).map((s) => `--${s.arg}=${path.join(dir, s.file)}`),
    `--output=${run.output}`,
    '--force',
    '--download=false',
    '--only_download=false',
    '--refresh_sources=false',
    ...REFRESH_SOURCE_NAMES.map((n) => `--refresh_${n}=false`),
    '--fetch_wikidata=false',
    `--bounds=${b.west},${b.south},${b.east},${b.north}`,
    `--maxzoom=${run.maxZoom}`,
    `--tmpdir=${run.tmpDir}`,
  );
  if (run.threads !== undefined) args.push(`--threads=${run.threads}`);
  return args;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  pid?: number;
}

export type Spawn = (
  file: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onOutput: (chunk: string) => void;
    signal?: AbortSignal;
    /** After an abort, how long the child has to exit before it is killed outright (default 10 s). */
    graceMs?: number;
  },
) => Promise<SpawnResult>;

/**
 * Runs a child and resolves only once it has exited, including after an abort: the child
 * is asked to stop, and killed outright if it has not stopped within `graceMs`. Anything
 * that cleans up after it can then rely on it being gone.
 */
export const spawnStreaming: Spawn = (file, args, opts) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, signal: null, error: errText(err) });
      return;
    }
    let spawnError: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), opts.graceMs ?? 10_000);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (b: Buffer) => opts.onOutput(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => opts.onOutput(b.toString('utf8')));
    child.on('error', (err) => {
      spawnError = errText(err);
    });
    // 'close' follows 'exit', or 'error' when the child could not be started at all.
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        ...(spawnError ? { error: spawnError } : {}),
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
      });
    });
  });

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
