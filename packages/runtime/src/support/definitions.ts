import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Clock, JsonValue } from '@worldview/world-model';
import { HttpClient, type Logger } from '@worldview/core';
import { ProviderError, type WorldProvider } from '@worldview/provider-sdk';
import { DeniedError, InvalidRequestError, NotFoundError, UnavailableError } from '../validate.js';
import type {
  DefinitionDraft,
  DefinitionFileEntry,
  DefinitionsListing,
  DefinitionsReload,
} from '@worldview/ipc-contract';
import {
  checkDefinitionUrl,
  connectorProviderFactories,
  defaultConnectorRegistry,
  draftDefinition,
  loadConnectorDefinitions,
  type ConnectorProviderDefinition,
  type DefinitionFile,
} from '@worldview/providers';

/**
 * The operator's connector definitions while the app runs (ADR-013 amendment 2026-09-23,
 * for phase `source-health-ui`). It owns the listing the Sources panel shows, and the three
 * things that change it without a restart:
 *
 *  - reload: both folders are read again; a source whose file went away is stopped and
 *    forgotten, a new one is registered (disabled unless the operator's setting or the file
 *    says otherwise), and one whose definition changed is stopped and registered afresh. A
 *    source whose file did not change is not touched, so a reload never interrupts it.
 *  - draft: one GET of a URL the operator typed — https, a public host (the definition URL
 *    policy, directive §76), no redirects, a size cap — handed to the drafter.
 *  - save: a definition written into the operator's folder as `<id>.json`, forced to
 *    `review: user-configured` and `enabled: false`, never over an existing file or an id
 *    another source holds, then a reload so it appears (disabled).
 */
export interface DefinitionsHost {
  register(provider: WorldProvider, opts: { enabled?: boolean; connector?: string; definitionFile?: string }): void;
  unregister(providerId: string): Promise<boolean>;
  setEnabled(providerId: string, enabled: boolean): Promise<void>;
  list(): Array<{ manifest: { id: string }; enabled: boolean }>;
}

export interface DefinitionsDeps {
  host: DefinitionsHost;
  /** Shipped definitions (`connectors/enabled` under resources), when there are any. */
  bundledDir?: string;
  /** The operator's folder; absent → no folder (demo, tests with explicit definitions). */
  userDir?: string;
  /** Ids of the hand-written providers, which a definition cannot take. */
  reservedIds: () => Iterable<string>;
  /** The operator's enabled setting for an id, when there is one. */
  enabledSetting: (id: string) => boolean | undefined;
  /** Persist an enabled switch (settings.providers), as `sources.setEnabled` does. */
  persistEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Called after a source is taken out, so its objects leave the world. */
  removed?: (id: string) => void;
  /** Called after a reload changed anything. */
  changed?: () => void;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export const MAX_DRAFT_SAMPLE_BYTES = 8 * 1024 * 1024;
const DEFINITION_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface Known {
  definition: ConnectorProviderDefinition;
  json: string;
  file: string;
}

export class ConnectorDefinitions {
  private files: DefinitionFile[] = [];
  private readonly known = new Map<string, Known>();
  private draftClient: HttpClient | undefined;
  /** Reloads and saves run one at a time: two at once would stop and start the same ids twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DefinitionsDeps) {}

  /** The operator's folder, or null when there is none. */
  folder(): string | null {
    return this.deps.userDir ?? null;
  }

  /** First load, before the host starts: the definitions the registry composes. */
  load(): ConnectorProviderDefinition[] {
    const loaded = this.read();
    for (const [id, k] of loaded) this.known.set(id, k);
    return [...loaded.values()].map((k) => k.definition);
  }

  /** Where a provider came from, for Source Health (`meta.connector`, `meta.definitionFile`). */
  metaFor(id: string): { connector?: string; definitionFile?: string } {
    const k = this.known.get(id);
    return k ? { connector: k.definition.connector, definitionFile: k.file } : {};
  }

  listing(): DefinitionsListing {
    const enabled = new Map(this.deps.host.list().map((p) => [p.manifest.id, p.enabled]));
    const files: DefinitionFileEntry[] = this.files.map((f) => ({
      file: f.file,
      ...(f.id ? { id: f.id } : {}),
      ...(f.connector ? { connector: f.connector } : {}),
      enabled: f.id ? (enabled.get(f.id) ?? false) : false,
      bundled: f.file.startsWith('bundled/'),
      problems: [...f.problems],
      warnings: [...f.warnings],
    }));
    return { folder: this.folder(), files };
  }

  reload(): Promise<DefinitionsReload> {
    return this.serial(() => this.reloadNow());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reloadNow(): Promise<DefinitionsReload> {
    const next = this.read();
    const added: string[] = [];
    const removed: string[] = [];
    const restarted: string[] = [];
    for (const [id, old] of [...this.known]) {
      const now = next.get(id);
      if (now && now.json === old.json && now.file === old.file) continue;
      await this.deps.host.unregister(id);
      this.known.delete(id);
      this.deps.removed?.(id);
      if (now) restarted.push(id);
      else removed.push(id);
    }
    for (const [id, k] of next) {
      if (this.known.has(id)) continue;
      const provider = connectorProviderFactories([k.definition])[id]!();
      const enabled = this.deps.enabledSetting(id) ?? provider.manifest.enabledByDefault;
      try {
        this.deps.host.register(provider, { enabled, connector: k.definition.connector, definitionFile: k.file });
        this.known.set(id, k);
        if (!restarted.includes(id)) added.push(id);
      } catch (err) {
        this.deps.logger.error('connector definition not registered', {
          file: k.file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (added.length || removed.length || restarted.length) {
      this.deps.logger.info('connector definitions reloaded', { added, removed, restarted });
      this.deps.changed?.();
    }
    return { ...this.listing(), added, removed, restarted };
  }

  /** Serial with reload and save, so a switch never lands on a source a reload is replacing. */
  setEnabled(file: string, enabled: boolean): Promise<DefinitionsListing> {
    return this.serial(() => this.setEnabledNow(file, enabled));
  }

  private async setEnabledNow(file: string, enabled: boolean): Promise<DefinitionsListing> {
    const entry = this.files.find((f) => f.file === file);
    if (!entry) throw new NotFoundError(`no definition file ${file}`);
    if (!entry.id || !this.known.has(entry.id))
      throw new InvalidRequestError(`${file} did not load, so it has no source to enable`);
    await this.deps.host.setEnabled(entry.id, enabled);
    if (!enabled) this.deps.removed?.(entry.id);
    await this.deps.persistEnabled(entry.id, enabled);
    return this.listing();
  }

  /** One sample of `url`, drafted. Nothing but the GET is sent; nothing is written. */
  async draft(url: string, signal?: AbortSignal): Promise<DefinitionDraft> {
    // Drafting is for the operator's folder; a runtime without one (demo) sends nothing.
    if (!this.deps.userDir) throw new UnavailableError('this runtime has no definition folder');
    const bad = checkDefinitionUrl(url, ['https:']);
    if (bad) throw new DeniedError(`the URL ${bad}`);
    const host = new URL(url).hostname.toLowerCase();
    // One client per draft host: the allowlist is exactly that host, no cache, no retries.
    this.draftClient = new HttpClient({
      allowedHosts: [host],
      clock: this.deps.clock,
      logger: this.deps.logger,
      defaultTimeoutMs: 20_000,
      maxRetries: 0,
      requestsPerMinute: 10,
      cacheEnabled: false,
      ...(this.deps.userAgent ? { userAgent: this.deps.userAgent } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    let res;
    try {
      res = await this.draftClient.request({
        url,
        method: 'GET',
        maxBytes: MAX_DRAFT_SAMPLE_BYTES,
        timeoutMs: 20_000,
        allowStale: false,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // The client's own words (timeout, too large, redirect not followed) are safe to show.
      throw new UnavailableError(
        `the sample could not be fetched: ${err instanceof ProviderError ? err.message : 'network error'}`,
      );
    }
    if (res.status < 200 || res.status >= 300) throw new UnavailableError(`the URL answered ${res.status}`);
    const contentType = res.headers['content-type'];
    const drafted = draftDefinition({
      url,
      text: res.text(),
      ...(contentType ? { contentType } : {}),
    });
    const verdict = defaultConnectorRegistry.validate(drafted.definition);
    return {
      definition: drafted.definition as Record<string, JsonValue>,
      connector: drafted.connector,
      notes: drafted.notes,
      todo: drafted.todo,
      validation: { ok: verdict.ok, errors: verdict.errors, warnings: verdict.warnings },
    };
  }

  save(id: string, definition: Record<string, JsonValue>): Promise<{ file: string; listing: DefinitionsReload }> {
    return this.serial(() => this.saveNow(id, definition));
  }

  private async saveNow(
    id: string,
    definition: Record<string, JsonValue>,
  ): Promise<{ file: string; listing: DefinitionsReload }> {
    const dir = this.deps.userDir;
    if (!dir) throw new UnavailableError('this runtime has no definition folder');
    if (!DEFINITION_ID.test(id))
      throw new InvalidRequestError(`id ${JSON.stringify(id)} must be 2–63 of a-z, 0-9 and -`);
    const doc: Record<string, JsonValue> = { ...definition, id, review: 'user-configured', enabled: false };
    const verdict = defaultConnectorRegistry.validate(doc);
    if (!verdict.ok)
      throw new InvalidRequestError(`the definition does not validate: ${verdict.errors.slice(0, 3).join('; ')}`);
    const taken = new Set(this.deps.reservedIds());
    if (taken.has(id) || this.files.some((f) => f.id === id))
      throw new InvalidRequestError(`id ${id} is already used by another source`);
    const file = `${id}.json`;
    await fs.mkdir(dir, { recursive: true });
    try {
      // `wx`: never over an existing file, even one written since the listing was read.
      await fs.writeFile(path.join(dir, file), `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        throw new InvalidRequestError(`${file} already exists in the folder`);
      throw err;
    }
    this.deps.logger.info('connector definition saved', { file });
    // A saved definition starts disabled, even when an earlier source with this id left its
    // switch on in settings.providers (request 2 of phase source-health-ui).
    if (this.deps.enabledSetting(id) === true) await this.deps.persistEnabled(id, false);
    return { file, listing: await this.reloadNow() };
  }

  /** Both folders, read now; records every file for the listing. */
  private read(): Map<string, Known> {
    const loaded = loadConnectorDefinitions(
      {
        ...(this.deps.bundledDir ? { bundledDir: this.deps.bundledDir } : {}),
        ...(this.deps.userDir ? { userDir: this.deps.userDir } : {}),
      },
      this.deps.reservedIds(),
    );
    for (const p of loaded.problems)
      this.deps.logger.warn('connector definition rejected', { file: p.file, errors: p.errors.slice(0, 5) });
    for (const w of loaded.warnings)
      this.deps.logger.info('connector definition notes', { file: w.file, warnings: w.warnings.slice(0, 5) });
    this.files = loaded.files;
    const byId = new Map<string, Known>();
    const fileOf = new Map(loaded.files.filter((f) => f.id).map((f) => [f.id!, f.file]));
    for (const d of loaded.definitions)
      byId.set(d.id, { definition: d, json: JSON.stringify(d), file: fileOf.get(d.id) ?? `${d.id}.json` });
    return byId;
  }
}
