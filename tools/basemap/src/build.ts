import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { isValidBounds, systemClock, type Clock, type GeoBounds } from '@worldview/world-model';
import {
  WorldPackBuildError,
  WorldPackBuilder,
  regionPreset,
  type WorldPackBuildReport,
  type WorldPackBuildRequest,
} from '@worldview/offline';
import {
  PROFILE_SOURCES,
  detectJava,
  detectProtomapsJar,
  diskProbe,
  errText,
  execCommand,
  jvmOptionsProblem,
  missingSources,
  planetilerArgs,
  scrubbedEnv,
  sha256OfFile,
  sourcesDir,
  spawnStreaming,
  type Exec,
  type FileProbe,
  type Platform,
  type Spawn,
} from './planetiler.js';
import { readOsmHeader } from './osm-pbf.js';
import { protomapsSchemaProblem, readPmtilesSummary, type PmtilesSummary } from './pmtiles.js';

/**
 * `pnpm basemap:build`: an OSM extract the operator already has → Planetiler with the
 * Protomaps basemap profile → a PMTiles file → a `.worldpack` holding it, with the
 * attribution and licence taken from the legal registry.
 *
 * Nothing is downloaded: not Planetiler, not Java, not the extract, not the profile's other
 * inputs, and never anything from OpenStreetMap's tile servers. The extract's source URL
 * (a Geofabrik page, say) is recorded as the operator gives it, not fetched.
 */

/**
 * The registry record the pack's map entry is filed under: OSM data built into the
 * Protomaps schema on the operator's machine. Its attribution and licence are what the pack
 * shows; until `config/licenses/providers.json` has it, packing is refused (fail closed).
 */
export const BASEMAP_PROVIDER_ID = 'osm-protomaps-planetiler';
export const DEFAULT_MAX_ZOOM = 15;

export type BuildStage = 'arguments' | 'prerequisites' | 'planetiler' | 'pmtiles' | 'pack' | 'interrupted';

export interface BasemapBuildOptions {
  /** A preset id (`hawaii`, …) or `west,south,east,north`. */
  region: string;
  outDir: string;
  /** The `.osm.pbf` extract on disk. */
  osmPath?: string;
  /** Where the extract came from (recorded, never fetched). https only. */
  osmSourceUrl?: string;
  /** Holds `data/sources/` (the profile's other inputs) and Planetiler's temp files. Default `<out>/work`. */
  workDir?: string;
  java?: string;
  jar?: string;
  maxZoom?: number;
  memory?: string;
  threads?: number;
  id?: string;
  name?: string;
  providerId?: string;
  /** Build the PMTiles file and stop: no pack, so no registry record needed. */
  pmtilesOnly?: boolean;
  /** Check everything (running only `java -version`) and return the command without running it. */
  dryRun?: boolean;
  /** `config/licenses/providers.json`. */
  registryPath: string;
  env: NodeJS.ProcessEnv;
  platform: Platform;
  log: (line: string) => void;
  /** Planetiler's own output, streamed as it comes. */
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  deps?: { exec?: Exec; spawn?: Spawn; probe?: FileProbe; clock?: Clock };
}

export interface BasemapBuildReport {
  tool: 'basemap:build';
  createdAt: string;
  id: string;
  name: string;
  region: { input: string; bounds: GeoBounds };
  osm: { path: string; sizeBytes: number; sha256: string; sourceUrl?: string; headerBounds?: GeoBounds };
  java: { path: string; version: string };
  /** The profile jar, identified by its SHA-256 (it is not run to ask for a version). */
  profile: { jar: string; sha256: string };
  command: { cwd: string; args: string[] };
  planetiler: { durationMs: number; exitCode: number; logPath: string };
  pmtiles: PmtilesSummary & { path: string; sizeBytes: number };
  pack?: {
    path: string;
    reportPath: string;
    sizeBytes: number;
    providerId: string;
    attribution: string;
    license: string;
  };
  warnings: string[];
}

export type BasemapBuildResult =
  | { ok: true; dryRun: false; report: BasemapBuildReport; reportPath: string }
  | { ok: true; dryRun: true; command: { cwd: string; java: string; args: string[] } }
  | { ok: false; stage: BuildStage; problems: string[] };

type RegistryPolicy = NonNullable<ReturnType<WorldPackBuildRequest['policies']>>;

export function parseRegion(input: string): { bounds: GeoBounds; label: string; name: string } | { error: string } {
  const preset = regionPreset(input);
  if (preset) return { bounds: preset.bounds, label: preset.id, name: preset.name };
  const parts = input.split(',').map((p) => p.trim());
  if (parts.length !== 4 || parts.some((p) => p === '' || !Number.isFinite(Number(p))))
    return { error: `--region "${input}" is neither a preset nor west,south,east,north` };
  const [west, south, east, north] = parts.map(Number) as [number, number, number, number];
  const bounds = { west, south, east, north };
  if (!isValidBounds(bounds) || !(west < east) || !(south < north))
    return {
      error: `--region ${input}: expected west < east and south < north within ±180/±90 (an area across the antimeridian is two builds)`,
    };
  return { bounds, label: 'bbox', name: `Bounds ${parts.join(',')}` };
}

/** A recorded source URL: https, a host, no credentials. */
export function checkSourceUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `--osm-url "${raw}" is not a URL`;
  }
  if (u.protocol !== 'https:') return '--osm-url must be https';
  if (u.username || u.password) return '--osm-url must not carry credentials';
  return undefined;
}

interface RegistryEntry {
  policy: RegistryPolicy;
  license?: string;
}

/**
 * The provider's record from the legal registry, or why there is none usable. The policy
 * is taken as recorded; the pack builder then refuses it unless it allows offline packs and
 * redistribution and carries its attribution text.
 */
export async function loadRegistryEntry(file: string, providerId: string): Promise<RegistryEntry | { error: string }> {
  let parsed: { records?: Array<{ providerId?: unknown; license?: unknown; dataPolicy?: unknown }> };
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as typeof parsed;
  } catch (err) {
    return { error: `cannot read the legal registry ${file}: ${errText(err)}` };
  }
  const rec = (parsed.records ?? []).find((r) => r.providerId === providerId);
  if (!rec)
    return {
      error: `the legal registry (${path.basename(file)}) has no record "${providerId}", so the pack's attribution and licence are not recorded and packing is refused. Add the record (docs/OFFLINE-BASEMAPS.md) or use --pmtiles-only`,
    };
  const p = rec.dataPolicy as Partial<Record<keyof RegistryPolicy, unknown>> | undefined;
  const flags = [
    'cacheAllowed',
    'rawPayloadRetentionAllowed',
    'normalizedRetentionAllowed',
    'redistributionAllowed',
    'offlinePackAllowed',
    'exportAllowed',
    'attributionRequired',
  ] as const;
  if (!p || typeof p !== 'object' || flags.some((f) => typeof p[f] !== 'boolean'))
    return { error: `registry record "${providerId}" has no complete dataPolicy` };
  return {
    policy: p as RegistryPolicy,
    ...(typeof rec.license === 'string' ? { license: rec.license } : {}),
  };
}

/** Rename, or across volumes copy beside the target and rename, so the target is never half-written. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const partial = `${to}.partial`;
    try {
      await fs.copyFile(from, partial);
      await fs.rename(partial, to);
    } catch (copyErr) {
      await fs.rm(partial, { force: true });
      throw copyErr;
    }
    await fs.rm(from, { force: true });
  }
}

export function overlaps(a: GeoBounds, b: GeoBounds): boolean {
  return a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;
}

export function contains(outer: GeoBounds, inner: GeoBounds): boolean {
  return (
    outer.west <= inner.west && outer.east >= inner.east && outer.south <= inner.south && outer.north >= inner.north
  );
}

const INTERRUPTED: BasemapBuildResult = {
  ok: false,
  stage: 'interrupted',
  problems: ['interrupted; nothing further was done'],
};

export async function buildBasemap(opts: BasemapBuildOptions): Promise<BasemapBuildResult> {
  const exec = opts.deps?.exec ?? execCommand;
  const spawnFn = opts.deps?.spawn ?? spawnStreaming;
  const probe = opts.deps?.probe ?? diskProbe;
  const clock = opts.deps?.clock ?? systemClock;
  const log = opts.log;

  // ---- arguments --------------------------------------------------------------
  const argProblems: string[] = [];
  const region = parseRegion(opts.region);
  if ('error' in region) argProblems.push(region.error);
  const id = opts.id ?? `basemap-${'label' in region ? region.label : 'region'}`;
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) argProblems.push(`--id "${id}" must be kebab-case, 2–64 characters`);
  const maxZoom = opts.maxZoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 15)
    argProblems.push('--maxzoom must be an integer 0–15 (the profile builds up to 15)');
  if (opts.memory !== undefined && !/^\d+[mMgG]$/.test(opts.memory))
    argProblems.push('--memory must look like 4g or 2048m');
  if (opts.threads !== undefined && (!Number.isInteger(opts.threads) || opts.threads < 1 || opts.threads > 256))
    argProblems.push('--threads must be an integer 1–256');
  if (opts.osmSourceUrl !== undefined) {
    const bad = checkSourceUrl(opts.osmSourceUrl);
    if (bad) argProblems.push(bad);
  }
  if (!opts.osmPath)
    argProblems.push(
      '--osm <file.osm.pbf> is required: download the extract yourself (for example from download.geofabrik.de) and name the file; this tool downloads nothing',
    );
  if (argProblems.length || 'error' in region) return { ok: false, stage: 'arguments', problems: argProblems };

  const outDir = path.resolve(opts.outDir);
  const workDir = path.resolve(opts.workDir ?? path.join(outDir, 'work'));
  const osmPath = path.resolve(opts.osmPath!);
  const name = opts.name ?? `${region.name} basemap (OpenStreetMap)`;
  const providerId = opts.providerId ?? BASEMAP_PROVIDER_ID;

  // ---- prerequisites: all of them, reported together ---------------------------
  const problems: string[] = [];
  const warnings: string[] = [];
  const jvm = jvmOptionsProblem(opts.env);
  if (jvm) problems.push(`Java: ${jvm}`);
  const java = await detectJava(
    { env: opts.env, platform: opts.platform, ...(opts.java ? { javaFlag: opts.java } : {}) },
    exec,
    probe,
  );
  if (!java.ok) problems.push(`Java: ${java.reason}`);
  const jar = await detectProtomapsJar(
    { env: opts.env, platform: opts.platform, ...(opts.jar ? { jarFlag: opts.jar } : {}) },
    probe,
  );
  if (!jar.ok) problems.push(`Planetiler: ${jar.reason}`);
  const missing = await missingSources(workDir, probe);
  if (missing.length)
    problems.push(
      `profile inputs missing from ${sourcesDir(workDir)} (get each yourself; this tool downloads nothing): ${missing
        .map((s) => `${s.file} — ${s.what}, ${s.licence}: ${s.url}`)
        .join('; ')}`,
    );
  let osmBounds: GeoBounds | undefined;
  if (!(await probe.isFile(osmPath))) problems.push(`OSM extract: ${osmPath} is not a readable file`);
  else if (!/\.osm\.pbf$/i.test(osmPath)) problems.push(`OSM extract: ${osmPath} does not end in .osm.pbf`);
  else {
    const header = await readOsmHeader(osmPath);
    if (!header.ok) problems.push(`OSM extract: ${osmPath}: ${header.reason}`);
    else if (!header.bbox)
      warnings.push('the extract does not state its bounding box, so whether it covers the region was not checked');
    else {
      osmBounds = header.bbox;
      const b = header.bbox;
      const box = `${b.west},${b.south},${b.east},${b.north}`;
      if (!overlaps(b, region.bounds))
        problems.push(
          `OSM extract: it covers ${box}, which does not meet the region; is it the extract for this region?`,
        );
      else if (!contains(b, region.bounds))
        warnings.push(`the extract covers ${box}, only part of the region; the rest of the map will be empty`);
    }
  }
  let registry: RegistryEntry | undefined;
  if (!opts.pmtilesOnly) {
    const r = await loadRegistryEntry(opts.registryPath, providerId);
    if ('error' in r) problems.push(`Licence: ${r.error}`);
    else registry = r;
  }
  if (problems.length || !java.ok || !jar.ok) return { ok: false, stage: 'prerequisites', problems };

  const tmpOutput = path.join(workDir, 'out', `${id}.pmtiles`);
  const args = planetilerArgs({
    jar: jar.path,
    osmPath,
    workDir,
    output: tmpOutput,
    bounds: region.bounds,
    maxZoom,
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.threads !== undefined ? { threads: opts.threads } : {}),
  });
  log(`java      ${java.path} (${java.versionLine})`);
  log(`profile   ${jar.path} (Protomaps basemap, sha256 ${jar.sha256.slice(0, 16)}…)`);
  log(`extract   ${osmPath}${opts.osmSourceUrl ? ` (from ${opts.osmSourceUrl})` : ''}`);
  log(
    `region    ${region.label}: ${region.bounds.west},${region.bounds.south},${region.bounds.east},${region.bounds.north}`,
  );
  for (const w of warnings) log(`warning   ${w}`);
  if (opts.dryRun) return { ok: true, dryRun: true, command: { cwd: workDir, java: java.path, args } };
  if (opts.signal?.aborted) return INTERRUPTED;

  // ---- Planetiler ----------------------------------------------------------------
  const createdAt = new Date(clock.now()).toISOString();
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.dirname(tmpOutput), { recursive: true });
  await fs.mkdir(path.join(workDir, 'tmp'), { recursive: true });
  await fs.rm(tmpOutput, { force: true });
  const osmStat = await fs.stat(osmPath);
  log(`hashing   ${osmPath} (${osmStat.size} bytes)`);
  const osmSha = await sha256OfFile(osmPath);
  if (opts.signal?.aborted) return INTERRUPTED;

  const logPath = path.join(outDir, `${id}.planetiler.log`);
  const logStream = createWriteStream(logPath);
  logStream.write(`# ${createdAt} ${java.path} ${args.join(' ')}\n# cwd ${workDir}\n`);
  log(`planetiler started; output also in ${logPath}`);
  const started = clock.now();
  const run = await spawnFn(java.path, args, {
    cwd: workDir,
    env: scrubbedEnv(opts.env),
    onOutput: (chunk) => {
      logStream.write(chunk);
      opts.onOutput?.(chunk);
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  await new Promise<void>((resolve) => logStream.end(resolve));
  const durationMs = clock.now() - started;
  // Planetiler's scratch files (gigabytes for a large region) are left behind when it is
  // killed; the directory is this tool's, so it goes either way.
  await fs.rm(path.join(workDir, 'tmp'), { recursive: true, force: true }).catch(() => undefined);
  if (opts.signal?.aborted) {
    await fs.rm(tmpOutput, { force: true });
    return {
      ok: false,
      stage: 'interrupted',
      problems: [`interrupted; Planetiler was stopped (its output is in ${logPath})`],
    };
  }
  if (run.error || run.code !== 0)
    return {
      ok: false,
      stage: 'planetiler',
      problems: [
        `Planetiler ${run.error ? `could not run: ${run.error}` : run.signal ? `stopped by ${run.signal}` : `exited ${run.code}`} after ${Math.round(durationMs / 1000)} s; its output is in ${logPath}`,
      ],
    };

  // ---- the file it wrote -----------------------------------------------------------
  let summary: PmtilesSummary;
  try {
    summary = await readPmtilesSummary(tmpOutput);
  } catch (err) {
    return {
      ok: false,
      stage: 'pmtiles',
      problems: [`Planetiler exited 0 but ${tmpOutput} is not usable: ${errText(err)}`],
    };
  }
  const schema = protomapsSchemaProblem(summary);
  if (schema) return { ok: false, stage: 'pmtiles', problems: [`${tmpOutput}: ${schema}`] };
  const pmtilesPath = path.join(outDir, `${id}.pmtiles`);
  await moveFile(tmpOutput, pmtilesPath);
  const pmStat = await fs.stat(pmtilesPath);
  log(
    `pmtiles   ${pmtilesPath} (${pmStat.size} bytes, z${summary.minZoom}–${summary.maxZoom}, ${summary.addressedTiles} tiles)`,
  );

  const report: BasemapBuildReport = {
    tool: 'basemap:build',
    createdAt,
    id,
    name,
    region: { input: opts.region, bounds: region.bounds },
    osm: {
      path: osmPath,
      sizeBytes: osmStat.size,
      sha256: osmSha,
      ...(opts.osmSourceUrl ? { sourceUrl: opts.osmSourceUrl } : {}),
      ...(osmBounds ? { headerBounds: osmBounds } : {}),
    },
    java: { path: java.path, version: java.versionLine },
    profile: { jar: jar.path, sha256: jar.sha256 },
    command: { cwd: workDir, args },
    planetiler: { durationMs, exitCode: 0, logPath },
    pmtiles: { ...summary, path: pmtilesPath, sizeBytes: pmStat.size },
    warnings,
  };
  if (!opts.osmSourceUrl) warnings.push('no --osm-url: where the extract came from is not recorded');

  // ---- the pack ------------------------------------------------------------------
  if (opts.signal?.aborted) {
    await fs.writeFile(path.join(outDir, `${id}.basemap-report.json`), JSON.stringify(report, null, 2) + '\n');
    return {
      ok: false,
      stage: 'interrupted',
      problems: [`interrupted before packing; the PMTiles file is at ${pmtilesPath}`],
    };
  }
  const reportPath = path.join(outDir, `${id}.basemap-report.json`);
  if (!opts.pmtilesOnly && registry) {
    const packPath = path.join(outDir, `${id}.worldpack`);
    let built: WorldPackBuildReport;
    try {
      built = await new WorldPackBuilder().build({
        id,
        name,
        region: { bounds: region.bounds },
        include: ['map'],
        sources: { pmtilesPath, pmtilesProviderId: providerId },
        policies: (p) => (p === providerId ? registry!.policy : undefined),
        licenses: (p) => (p === providerId ? registry!.license : undefined),
        outputPath: packPath,
        clock,
      });
    } catch (err) {
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      const why = err instanceof WorldPackBuildError ? `${err.code}: ${err.message}` : errText(err);
      return {
        ok: false,
        stage: 'pack',
        problems: [`the PMTiles file is at ${pmtilesPath}, but the pack was refused — ${why}`],
      };
    }
    const policy = built.sources.find((s) => s.providerId === providerId);
    report.pack = {
      path: packPath,
      reportPath: built.reportPath,
      sizeBytes: built.sizeBytes,
      providerId,
      attribution: policy?.attribution ?? '',
      license: policy?.license ?? '',
    };
    warnings.push(...built.warnings);
    log(`pack      ${packPath} (${built.sizeBytes} bytes)`);
  }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  log(`report    ${reportPath}`);
  return { ok: true, dryRun: false, report, reportPath };
}

/** For the CLI's help text. */
export function profileSourceLines(): string[] {
  return PROFILE_SOURCES.map((s) => `  ${s.file.padEnd(32)} ${s.what} (${s.licence})\n  ${''.padEnd(32)} ${s.url}`);
}
