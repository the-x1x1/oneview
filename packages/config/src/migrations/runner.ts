import { promises as fs } from 'node:fs';
import type { JsonValue } from '@worldview/world-model';
import { silentLogger, type Logger } from '@worldview/core';
import { writeFileAtomic } from '@worldview/core/node';
import type { DataDirs } from '../data-dirs.js';

/**
 * Versioned migrations for settings.json and the userData directory layout.
 *
 * Rules: migrations are the only place version-specific logic lives (no
 * `if (version < n)` anywhere else); they run in order; the settings file is backed
 * up before the first pending migration; `schemaVersion` is recorded after each
 * successful step; on failure the backup is restored and the failure is reported so
 * StartupValidator can surface it in diagnostics.
 */
export interface MigrationContext {
  readonly dirs: DataDirs;
  /** The raw settings document; migrations reshape it in place. */
  readonly document: Record<string, JsonValue>;
  readonly logger: Logger;
}

export interface Migration {
  /** Strictly increasing positive integer. */
  readonly version: number;
  readonly name: string;
  up(ctx: MigrationContext): Promise<void>;
}

export interface MigrationReport {
  ok: boolean;
  from: number;
  to: number;
  applied: Array<{ version: number; name: string }>;
  backupFile?: string;
  /** The settings document is newer than this build understands; left untouched. */
  newerThanBuild?: boolean;
  /** Settings file was unreadable; nothing was migrated (SettingsStore quarantines it). */
  unreadable?: boolean;
  failed?: { version: number; name: string; error: string };
  restored?: boolean;
}

export interface MigrationRunnerOptions {
  migrations: readonly Migration[];
  dirs: DataDirs;
  logger?: Logger;
}

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

export function assertMigrationSequence(migrations: readonly Migration[]): void {
  const versions = migrations.map((m) => m.version);
  const sorted = [...versions].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i]!;
    if (!Number.isInteger(v) || v <= 0) throw new Error(`migration version must be a positive integer: ${v}`);
    if (i > 0 && v === sorted[i - 1]) throw new Error(`duplicate migration version ${v}`);
  }
}

export class MigrationRunner {
  private readonly logger: Logger;
  private readonly migrations: Migration[];

  constructor(private readonly opts: MigrationRunnerOptions) {
    assertMigrationSequence(opts.migrations);
    this.migrations = [...opts.migrations].sort((a, b) => a.version - b.version);
    this.logger = opts.logger ?? silentLogger;
  }

  get latest(): number { return latestVersion(this.migrations); }

  async run(): Promise<MigrationReport> {
    const file = this.opts.dirs.settingsFile;
    const existing = await readDocument(file);
    if (existing.status === 'unreadable') {
      this.logger.warn('settings unreadable; migrations skipped', { file: 'settings.json' });
      return { ok: false, from: 0, to: 0, applied: [], unreadable: true };
    }
    const document = existing.document;
    const from = typeof document.schemaVersion === 'number' && Number.isInteger(document.schemaVersion) ? document.schemaVersion : 0;
    const to = this.latest;
    if (from > to) {
      this.logger.warn('settings written by a newer build; left untouched', { fileVersion: from, buildVersion: to });
      return { ok: true, from, to: from, applied: [], newerThanBuild: true };
    }
    const pending = this.migrations.filter((m) => m.version > from);
    if (pending.length === 0) return { ok: true, from, to, applied: [] };

    let backupFile: string | undefined;
    if (existing.status === 'present') {
      backupFile = `${file}.bak-${from}`;
      await fs.copyFile(file, backupFile);
    }
    const ctx: MigrationContext = { dirs: this.opts.dirs, document, logger: this.logger };
    const applied: MigrationReport['applied'] = [];
    for (const m of pending) {
      try {
        await m.up(ctx);
        document.schemaVersion = m.version;
        await writeFileAtomic(file, JSON.stringify(document, null, 2) + '\n');
        applied.push({ version: m.version, name: m.name });
        this.logger.info('migration applied', { version: m.version, name: m.name });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.error('migration failed; restoring backup', { version: m.version, name: m.name, error });
        const restored = await restore(file, backupFile);
        return { ok: false, from, to, applied, ...(backupFile ? { backupFile } : {}), failed: { version: m.version, name: m.name, error }, restored };
      }
    }
    return { ok: true, from, to, applied, ...(backupFile ? { backupFile } : {}) };
  }
}

async function readDocument(file: string): Promise<{ status: 'missing' | 'present'; document: Record<string, JsonValue> } | { status: 'unreadable' }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', document: {} };
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 'unreadable' };
    return { status: 'present', document: parsed as Record<string, JsonValue> };
  } catch {
    return { status: 'unreadable' };
  }
}

async function restore(file: string, backupFile: string | undefined): Promise<boolean> {
  try {
    if (backupFile) await fs.copyFile(backupFile, file);
    else await fs.rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
