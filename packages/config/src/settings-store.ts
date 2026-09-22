import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '@worldview/ipc-contract';
import { formatIssues, s, type SchemaIssue } from '@worldview/world-model';
import { TypedEmitter, silentLogger, type Logger } from '@worldview/core';
import { writeFileAtomic } from '@worldview/core/node';
import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  appSettingsPatchSchema,
  applySettingsPatch,
  cloneSettings,
} from './settings-schema.js';

/** On-disk envelope. `schemaVersion` is owned by the MigrationRunner. */
export interface SettingsDocument {
  schemaVersion: number;
  settings: AppSettings;
}

export const settingsDocumentSchema = s.object({
  schemaVersion: s.number({ min: 0, integer: true }),
  settings: appSettingsSchema,
});

export type SettingsLoadStatus = 'loaded' | 'defaults-fresh' | 'defaults-after-corrupt';

export interface SettingsLoadReport {
  status: SettingsLoadStatus;
  file: string;
  /** Where the unreadable file was preserved (never deleted). */
  corruptFile?: string;
  issues?: SchemaIssue[];
  error?: string;
}

export interface SettingsStoreOptions {
  file: string;
  schemaVersion: number;
  logger?: Logger;
  now?: () => number;
}

export class SettingsValidationError extends Error {
  constructor(readonly issues: SchemaIssue[]) {
    super(`invalid settings: ${formatIssues(issues)}`);
    this.name = 'SettingsValidationError';
  }
}

/**
 * SettingsStore — the only writer of settings.json.
 *
 *  - validated on load and on every patch (schema from settings-schema.ts)
 *  - atomic persistence (temp file + fsync + rename) so a crash never truncates it
 *  - a corrupt file is preserved as settings.corrupt-<timestamp>.json and defaults are used
 *  - `change` events for the runtime (→ `settings.changed` IPC event)
 */
export class SettingsStore {
  private current: AppSettings = cloneSettings(DEFAULT_SETTINGS);
  private readonly emitter = new TypedEmitter<{ change: AppSettings }>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SettingsStoreOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  get file(): string {
    return this.opts.file;
  }

  static async open(opts: SettingsStoreOptions): Promise<{ store: SettingsStore; report: SettingsLoadReport }> {
    const store = new SettingsStore(opts);
    const report = await store.load();
    return { store, report };
  }

  async load(): Promise<SettingsLoadReport> {
    const file = this.opts.file;
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.current = cloneSettings(DEFAULT_SETTINGS);
        return { status: 'defaults-fresh', file };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this.quarantine(file, { error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
    }
    const result = settingsDocumentSchema.parse(parsed);
    if (!result.ok) return this.quarantine(file, { issues: result.issues });
    this.current = cloneSettings(result.value.settings as AppSettings);
    return { status: 'loaded', file };
  }

  private async quarantine(
    file: string,
    detail: { issues?: SchemaIssue[]; error?: string },
  ): Promise<SettingsLoadReport> {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const corruptFile = path.join(path.dirname(file), `settings.corrupt-${stamp}.json`);
    await fs.rename(file, corruptFile);
    this.current = cloneSettings(DEFAULT_SETTINGS);
    this.logger.warn('settings file unreadable; preserved and defaults applied', {
      corruptFile: path.basename(corruptFile),
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.issues ? { issues: formatIssues(detail.issues) } : {}),
    });
    await this.persist();
    return {
      status: 'defaults-after-corrupt',
      file,
      corruptFile,
      ...(detail.issues ? { issues: detail.issues } : {}),
      ...(detail.error ? { error: detail.error } : {}),
    };
  }

  /** A defensive copy; mutations never reach the store. */
  get(): AppSettings {
    return cloneSettings(this.current);
  }

  /** Validate, merge, persist atomically, emit. Rejects (without writing) on invalid input. */
  async patch(patch: Partial<AppSettings>): Promise<AppSettings> {
    const p = appSettingsPatchSchema.parse(patch);
    if (!p.ok) throw new SettingsValidationError(p.issues);
    const merged = applySettingsPatch(this.current, p.value);
    const full = appSettingsSchema.parse(merged);
    if (!full.ok) throw new SettingsValidationError(full.issues);
    this.current = full.value;
    await this.persist();
    this.emitter.emit('change', cloneSettings(this.current));
    return cloneSettings(this.current);
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    return this.emitter.on('change', listener);
  }

  /** Serialised atomic write; concurrent patches never interleave partial documents. */
  private persist(): Promise<void> {
    const doc: SettingsDocument = { schemaVersion: this.opts.schemaVersion, settings: cloneSettings(this.current) };
    const run = async () => {
      await writeFileAtomic(this.opts.file, JSON.stringify(doc, null, 2) + '\n');
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }
}
