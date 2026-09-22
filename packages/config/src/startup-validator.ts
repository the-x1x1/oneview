import { promises as fs } from 'node:fs';
import path from 'node:path';
import { silentLogger, type Logger } from '@worldview/core';
import { ensureDataDirs, probeWritable, type DataDirs } from './data-dirs.js';
import { MIGRATIONS, MigrationRunner, type Migration, type MigrationReport } from './migrations/index.js';
import { SettingsStore, type SettingsLoadReport } from './settings-store.js';

export type StartupArea =
  'data-dir' | 'migrations' | 'settings' | 'user-documents' | 'worldpacks' | 'database' | 'credentials' | 'custom';

export interface StartupFinding {
  area: StartupArea;
  severity: 'info' | 'warn' | 'error';
  message: string;
  /** Basename only — never an absolute user path (diagnostics bundles are shareable). */
  file?: string;
}

export interface StartupCheckContext {
  dirs: DataDirs;
  logger: Logger;
  now: () => number;
}

/** Injected checks (database backend, credential file) keep this package free of those dependencies. */
export interface StartupCheck {
  name: string;
  area: StartupArea;
  run(ctx: StartupCheckContext): Promise<StartupFinding[]>;
}

export interface StartupValidatorOptions {
  dirs: DataDirs;
  migrations?: readonly Migration[];
  checks?: StartupCheck[];
  logger?: Logger;
  now?: () => number;
}

export interface StartupResult {
  findings: StartupFinding[];
  settings: SettingsStore;
  settingsReport: SettingsLoadReport;
  migration: MigrationReport;
  /** False when the data directory is unusable; the app must stop with a clear dialog. */
  usable: boolean;
}

/**
 * StartupValidator — runs before any window opens.
 *
 *  1. create/verify the userData layout and that it is writable
 *  2. run pending migrations (backup / restore on failure)
 *  3. open the settings store (corrupt → preserved, defaults used)
 *  4. validate the user documents and worldpack manifests are well-formed JSON
 *  5. run injected checks (database, credentials)
 *
 * Every problem is a finding for the diagnostics panel; only an unusable data
 * directory is fatal.
 */
export class StartupValidator {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly migrations: readonly Migration[];

  constructor(private readonly opts: StartupValidatorOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.migrations = opts.migrations ?? MIGRATIONS;
  }

  async run(): Promise<StartupResult> {
    const findings: StartupFinding[] = [];
    const { dirs } = this.opts;
    const ctx: StartupCheckContext = { dirs, logger: this.logger, now: this.now };

    let usable = true;
    try {
      await ensureDataDirs(dirs);
      const probe = await probeWritable(dirs.root);
      if (!probe.writable) {
        usable = false;
        findings.push({
          area: 'data-dir',
          severity: 'error',
          message: `data directory is not writable: ${probe.error ?? 'unknown error'}`,
        });
      }
    } catch (err) {
      usable = false;
      findings.push({
        area: 'data-dir',
        severity: 'error',
        message: `cannot create data directory: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const runner = new MigrationRunner({ migrations: this.migrations, dirs, logger: this.logger });
    const migration: MigrationReport = usable ? await runner.run() : { ok: false, from: 0, to: 0, applied: [] };
    if (migration.failed)
      findings.push({
        area: 'migrations',
        severity: 'error',
        message: `migration ${migration.failed.version} (${migration.failed.name}) failed: ${migration.failed.error}; ${migration.restored ? 'previous settings restored' : 'restore failed'}`,
        ...(migration.backupFile ? { file: path.basename(migration.backupFile) } : {}),
      });
    if (migration.unreadable)
      findings.push({
        area: 'migrations',
        severity: 'warn',
        message: 'settings file unreadable; migrations skipped',
        file: 'settings.json',
      });
    if (migration.newerThanBuild)
      findings.push({
        area: 'migrations',
        severity: 'warn',
        message: `settings were written by a newer build (schema ${migration.from} > ${runner.latest})`,
        file: 'settings.json',
      });
    if (migration.applied.length)
      findings.push({
        area: 'migrations',
        severity: 'info',
        message: `applied migrations ${migration.applied.map((m) => `${m.version}:${m.name}`).join(', ')}`,
      });

    const { store, report: settingsReport } = await SettingsStore.open({
      file: dirs.settingsFile,
      schemaVersion: runner.latest,
      logger: this.logger,
      now: this.now,
    });
    if (settingsReport.status === 'defaults-after-corrupt')
      findings.push({
        area: 'settings',
        severity: 'warn',
        message: `settings were unreadable and have been reset to defaults (${settingsReport.error ?? 'schema mismatch'})`,
        ...(settingsReport.corruptFile ? { file: path.basename(settingsReport.corruptFile) } : {}),
      });

    if (usable) {
      findings.push(...(await this.checkUserDocuments(dirs)));
      findings.push(...(await this.checkWorldpacks(dirs)));
    }
    for (const check of this.opts.checks ?? []) {
      try {
        findings.push(...(await check.run(ctx)));
      } catch (err) {
        findings.push({
          area: check.area,
          severity: 'error',
          message: `${check.name} check crashed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    for (const f of findings)
      this.logger[f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warn' : 'info'](`startup: ${f.message}`, {
        area: f.area,
        ...(f.file ? { file: f.file } : {}),
      });
    return { findings, settings: store, settingsReport, migration, usable };
  }

  private async checkUserDocuments(dirs: DataDirs): Promise<StartupFinding[]> {
    const out: StartupFinding[] = [];
    for (const file of [dirs.collectionsFile, dirs.watchzonesFile, dirs.lensesFile]) {
      const status = await readJsonEnvelope(file);
      if (status === 'missing')
        out.push({
          area: 'user-documents',
          severity: 'warn',
          message: 'user document missing (will be recreated empty)',
          file: path.basename(file),
        });
      else if (status === 'invalid') {
        const preserved = await preserveCorrupt(file, this.now());
        out.push({
          area: 'user-documents',
          severity: 'warn',
          message: `user document unreadable; preserved as ${path.basename(preserved)} and replaced with an empty list`,
          file: path.basename(file),
        });
      }
    }
    return out;
  }

  private async checkWorldpacks(dirs: DataDirs): Promise<StartupFinding[]> {
    const out: StartupFinding[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dirs.worldpacksDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifest = path.join(dirs.worldpacksDir, e.name, 'manifest.json');
      const status = await readJsonEnvelope(manifest);
      if (status !== 'ok')
        out.push({
          area: 'worldpacks',
          severity: 'warn',
          message: `worldpack "${e.name}" has ${status === 'missing' ? 'no' : 'an unreadable'} manifest.json; it will be listed as invalid`,
          file: e.name,
        });
    }
    return out;
  }
}

async function readJsonEnvelope(file: string): Promise<'ok' | 'missing' | 'invalid'> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? 'ok' : 'invalid';
  } catch {
    return 'invalid';
  }
}

async function preserveCorrupt(file: string, now: number): Promise<string> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const ext = path.extname(file);
  const target = path.join(path.dirname(file), `${path.basename(file, ext)}.corrupt-${stamp}${ext}`);
  await fs.rename(file, target);
  await fs.writeFile(file, JSON.stringify({ version: 1, items: [] }, null, 2) + '\n');
  return target;
}
