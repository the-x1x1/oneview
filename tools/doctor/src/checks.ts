import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * `pnpm doctor` (directive §84): does this machine have what WORLDVIEW needs, and is
 * the installed tree consistent with what the app expects at runtime?
 *
 * Every check reports pass / warn / fail / skip with a reason. A check that cannot run
 * here (no installed dependencies, no configured sidecar) is SKIPPED with the reason
 * stated — it never reports a pass it did not earn.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface DoctorCheck { name: string; status: CheckStatus; detail: string }
export interface DoctorReport { ranAt: string; root: string; platform: string; checks: DoctorCheck[]; passed: boolean }

export interface DoctorOptions {
  root: string;
  /** Where user data would live (defaults to a platform-appropriate guess for a dev run). */
  userDataDir?: string;
  /** Provider settings that enable optional local services. */
  go2rtcPath?: string;
  readsbEndpoint?: string;
  probe?: (url: string) => Promise<{ reachable: boolean; status?: number }>;
  now?: () => number;
}

/**
 * Where a package actually sits in a pnpm workspace.
 *
 * pnpm does not hoist: a dependency of `apps/desktop` is linked into
 * `apps/desktop/node_modules`, not the repository root. Looking only at the root made
 * this tool report Electron, Vite and Cesium as "not installed" on a machine where they
 * were installed and working — a check that lies is worse than no check, and this one
 * exists to tell the truth about the environment.
 */
function packageDirs(root: string): string[] {
  const dirs = [root];
  for (const group of ['apps', 'packages', 'providers', 'tools']) {
    const groupDir = path.join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(groupDir, entry.name));
    }
  }
  return dirs;
}

function pkgVersion(root: string, name: string): string | undefined {
  for (const dir of packageDirs(root)) {
    const file = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(file)) continue;
    try { return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version; } catch { /* try the next */ }
  }
  return undefined;
}

/** Resolve a package directory the same way, for checks that need files inside it. */
function pkgDir(root: string, name: string): string | undefined {
  for (const dir of packageDirs(root)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

function satisfiesMajor(version: string, majors: number[]): boolean {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return majors.includes(major);
}

/** Read `cameras.go2rtcPath` out of an installation's settings.json, if there is one. */
function settingsGo2rtcPath(userDataDir: string): string | undefined {
  const file = path.join(userDataDir, 'settings.json');
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { settings?: { cameras?: { go2rtcPath?: unknown } }; cameras?: { go2rtcPath?: unknown } };
    const value = doc.settings?.cameras?.go2rtcPath ?? doc.cameras?.go2rtcPath;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch { return undefined; }
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const root = opts.root;
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => { checks.push({ name, status, detail }); };

  // --- toolchain -----------------------------------------------------------
  const node = process.version;
  add('Node runtime', satisfiesMajor(node, [22, 23, 24]) ? 'pass' : 'fail', `${node} (supported: 22.x–24.x, see .nvmrc)`);

  const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { packageManager?: string; engines?: { pnpm?: string } };
  add('Package manager pin', rootPkg.packageManager ? 'pass' : 'fail', rootPkg.packageManager ?? 'package.json has no packageManager field');

  const hasModules = existsSync(path.join(root, 'node_modules'));
  const hasLock = existsSync(path.join(root, 'pnpm-lock.yaml'));
  add('Dependencies installed', hasModules && hasLock ? 'pass' : 'skip', hasModules && hasLock ? 'node_modules and pnpm-lock.yaml present' : `run "pnpm install" first (node_modules: ${hasModules ? 'present' : 'missing'}, lockfile: ${hasLock ? 'present' : 'missing'})`);

  // --- build prerequisites -------------------------------------------------
  for (const [label, mod] of [['Electron', 'electron'], ['Vite', 'vite'], ['TypeScript', 'typescript']] as const) {
    const v = pkgVersion(root, mod);
    add(`${label} available`, v ? 'pass' : 'skip', v ? `${mod}@${v}` : `${mod} is not installed (expected after pnpm install)`);
  }

  // --- Cesium assets -------------------------------------------------------
  const cesiumRoot = pkgDir(root, 'cesium');
  const cesiumBuild = cesiumRoot ? path.join(cesiumRoot, 'Build', 'Cesium') : '';
  if (!cesiumRoot) add('Cesium assets', 'skip', 'cesium is not installed');
  else if (existsSync(path.join(cesiumBuild, 'Assets', 'Textures', 'NaturalEarthII'))) add('Cesium assets', 'pass', 'Natural Earth II imagery present (the zero-credential default basemap)');
  else add('Cesium assets', 'fail', `missing ${path.relative(root, path.join(cesiumBuild, 'Assets', 'Textures', 'NaturalEarthII'))}: the offline default basemap would not render`);

  // The assets have to survive into the built renderer, not merely exist in node_modules.
  // `vite build` empties dist/renderer, so a step that wrote them there before Vite ran
  // left a build that logged "copied Cesium assets" and shipped none: the check that
  // matters is the one against dist.
  const builtRenderer = path.join(root, 'apps', 'desktop', 'dist', 'renderer');
  if (!existsSync(path.join(builtRenderer, 'index.html'))) {
    add('Built renderer assets', 'skip', 'apps/desktop/dist/renderer is not built (run "pnpm build")');
  } else {
    const missing = ['Workers', 'Assets', 'ThirdParty', 'Widgets'].filter((sub) => !existsSync(path.join(builtRenderer, 'cesium', sub)));
    if (missing.length === 0) add('Built renderer assets', 'pass', 'dist/renderer/cesium carries Workers, Assets, ThirdParty and Widgets');
    else add('Built renderer assets', 'fail', `dist/renderer/cesium is missing ${missing.join(', ')}: the 3D globe would fail to load at run time`);
  }

  // --- DuckDB --------------------------------------------------------------
  // Imported from the package that declares it, not from this tool: pnpm only links a
  // dependency into its dependent, so importing it here reported "not loadable" for a
  // module the history store loads perfectly well.
  const duckDir = pkgDir(root, '@duckdb/node-api');
  if (!duckDir) {
    add('DuckDB history backend', 'skip', '@duckdb/node-api is not installed; history uses the NDJSON backend');
  } else {
    try {
      await import(pathToFileURL(path.join(duckDir, 'lib', 'duckdb.js')).href).catch(async () => {
        const main = (JSON.parse(readFileSync(path.join(duckDir, 'package.json'), 'utf8')) as { main?: string }).main ?? 'index.js';
        return import(pathToFileURL(path.join(duckDir, main)).href);
      });
      add('DuckDB history backend', 'pass', `@duckdb/node-api@${pkgVersion(root, '@duckdb/node-api') ?? '?'} loads; Parquet history is available`);
    } catch (err) {
      add('DuckDB history backend', 'warn', `@duckdb/node-api is installed but did not load (${(err as Error).message.split('\n')[0]}); history falls back to the NDJSON backend`);
    }
  }

  // --- bundled data --------------------------------------------------------
  const airports = path.join(root, 'apps', 'desktop', 'resources', 'data', 'airports.geojson');
  if (existsSync(airports)) {
    try {
      const fc = JSON.parse(readFileSync(airports, 'utf8')) as { features?: unknown[] };
      add('Bundled airports dataset', Array.isArray(fc.features) && fc.features.length > 0 ? 'pass' : 'fail', `${fc.features?.length ?? 0} features in apps/desktop/resources/data/airports.geojson`);
    } catch { add('Bundled airports dataset', 'fail', 'apps/desktop/resources/data/airports.geojson is not valid JSON'); }
  } else add('Bundled airports dataset', 'fail', 'apps/desktop/resources/data/airports.geojson is missing (run "pnpm stage:resources")');

  // --- provider configuration ---------------------------------------------
  const registryFile = path.join(root, 'config', 'licenses', 'providers.json');
  const manifests = existsSync(path.join(root, 'providers'))
    ? readdirSync(path.join(root, 'providers'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'registry' && existsSync(path.join(root, 'providers', d.name, 'src', 'manifest.ts'))).length
    : 0;
  if (!existsSync(registryFile)) add('Provider configuration', 'fail', 'config/licenses/providers.json is missing');
  else {
    const records = (JSON.parse(readFileSync(registryFile, 'utf8')) as { records: unknown[] }).records.length;
    add('Provider configuration', manifests > 0 ? 'pass' : 'fail', `${manifests} provider manifests, ${records} legal records (run "pnpm license-audit" for consistency)`);
  }

  // --- filesystem ----------------------------------------------------------
  const userData = opts.userDataDir ?? path.join(os.homedir(), '.worldview-doctor');
  try {
    mkdirSync(userData, { recursive: true });
    const probeFile = path.join(userData, `.write-probe-${process.pid}`);
    writeFileSync(probeFile, 'ok');
    unlinkSync(probeFile);
    add('User data directory writable', 'pass', userData);
  } catch (err) {
    add('User data directory writable', 'fail', `${userData}: ${(err as Error).message}`);
  }

  const packsDir = path.join(userData, 'worldpacks');
  try {
    mkdirSync(packsDir, { recursive: true });
    const installed = existsSync(packsDir) ? readdirSync(packsDir).length : 0;
    add('Worldpack directory', 'pass', `${packsDir} (${installed} installed)`);
  } catch (err) {
    add('Worldpack directory', 'fail', `${packsDir}: ${(err as Error).message}`);
  }

  // --- optional local services --------------------------------------------
  // The path comes from the flag, or from a real installation's settings.json when the
  // caller pointed at one with --user-data. The scratch directory this run creates by
  // default says nothing about any installation, so it is not consulted.
  const configuredGo2rtc = opts.go2rtcPath ?? (opts.userDataDir ? settingsGo2rtcPath(opts.userDataDir) : undefined);
  if (!configuredGo2rtc) add('go2rtc sidecar', 'skip', `not configured${opts.userDataDir ? ` in ${path.join(opts.userDataDir, 'settings.json')}` : ' here (pass --go2rtc or --user-data to check an installation)'} — only RTSP cameras need it; see docs/operator/cameras.md`);
  else if (!path.isAbsolute(configuredGo2rtc)) add('go2rtc sidecar', 'fail', `configured path is not absolute: ${configuredGo2rtc} (the runtime refuses it)`);
  else if (existsSync(configuredGo2rtc) && statSync(configuredGo2rtc).isFile()) add('go2rtc sidecar', 'pass', `${configuredGo2rtc} present`);
  else add('go2rtc sidecar', 'fail', `configured binary not found at ${configuredGo2rtc}`);

  if (!opts.readsbEndpoint) add('Local readsb receiver', 'skip', 'not configured (aircraft still come from remote sources)');
  else if (!opts.probe) add('Local readsb receiver', 'skip', `configured (${opts.readsbEndpoint}) but this run cannot probe it`);
  else {
    const r = await opts.probe(opts.readsbEndpoint);
    add('Local readsb receiver', r.reachable ? 'pass' : 'warn', r.reachable ? `${opts.readsbEndpoint} answered ${r.status ?? 200}` : `${opts.readsbEndpoint} did not answer; the local ADS-B provider will report OFFLINE`);
  }

  return {
    ranAt: new Date((opts.now ?? Date.now)()).toISOString(),
    root,
    platform: `${process.platform}-${process.arch}`,
    checks,
    passed: checks.every((c) => c.status !== 'fail'),
  };
}

export function formatDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length)) + 2;
  const icon: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  return [
    `WorldView doctor — ${report.platform} — ${report.ranAt}`,
    ...report.checks.map((c) => `  ${c.name.padEnd(width)}${icon[c.status].padEnd(6)}${c.detail}`),
    `  ${'—'.repeat(width + 40)}`,
    `  ${report.checks.filter((c) => c.status === 'pass').length} pass, ${report.checks.filter((c) => c.status === 'warn').length} warn, ${report.checks.filter((c) => c.status === 'fail').length} fail, ${report.checks.filter((c) => c.status === 'skip').length} skip → ${report.passed ? 'OK' : 'PROBLEMS FOUND'}`,
  ].join('\n');
}
