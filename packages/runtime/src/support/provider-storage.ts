import { promises as fs } from 'node:fs';
import path from 'node:path';
import { silentLogger, type Logger } from '@worldview/core';
import { readJsonFile, writeFileAtomic } from '@worldview/core/node';
import type { Clock, JsonValue } from '@worldview/world-model';
import type { ProviderCache, ProviderSettings, ProviderLocalAccess, Unsubscribe } from '@worldview/provider-sdk';
import { ProviderError } from '@worldview/provider-sdk';
import { isInsideDir } from '@worldview/config';

/**
 * Per-provider storage the ProviderHost injects: a small JSON cache, provider-scoped
 * settings and the granted-file / loopback-probe surface. All three fail closed:
 * a provider whose data policy forbids caching gets a no-op cache, a provider without
 * a granted directory cannot read files, and probes are limited to loopback hosts that
 * the manifest already allowlists.
 */

interface CacheEntry {
  value: JsonValue;
  storedAt: string;
  expiresAt?: number;
}
interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const MAX_CACHE_ENTRIES = 256;

/** File-backed JSON cache under `<dataDir>/cache/<providerId>.json`. */
export class FileProviderCache implements ProviderCache {
  private entries: Record<string, CacheEntry> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly clock: Clock,
    private readonly enabled: boolean,
    private readonly log: Logger = silentLogger,
  ) {}

  async get<T extends JsonValue>(key: string): Promise<{ value: T; storedAt: string } | undefined> {
    if (!this.enabled) return undefined;
    const entries = await this.read();
    const entry = entries[key];
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt < this.clock.now()) {
      delete entries[key];
      void this.flush();
      return undefined;
    }
    return { value: entry.value as T, storedAt: entry.storedAt };
  }

  async set(key: string, value: JsonValue, ttlMs?: number): Promise<void> {
    if (!this.enabled) return; // dataPolicy.cacheAllowed === false
    const entries = await this.read();
    entries[key] = {
      value,
      storedAt: new Date(this.clock.now()).toISOString(),
      ...(ttlMs !== undefined ? { expiresAt: this.clock.now() + ttlMs } : {}),
    };
    const keys = Object.keys(entries);
    if (keys.length > MAX_CACHE_ENTRIES) {
      const sorted = keys.sort((a, b) => Date.parse(entries[a]!.storedAt) - Date.parse(entries[b]!.storedAt));
      for (const k of sorted.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete entries[k];
    }
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    if (!this.enabled) return;
    const entries = await this.read();
    if (entries[key] === undefined) return;
    delete entries[key];
    await this.flush();
  }

  private async read(): Promise<Record<string, CacheEntry>> {
    if (this.entries) return this.entries;
    const doc = await readJsonFile<CacheFile>(this.file).catch(() => undefined);
    this.entries =
      doc && typeof doc === 'object' && doc.entries && typeof doc.entries === 'object' ? { ...doc.entries } : {};
    return this.entries;
  }

  private async flush(): Promise<void> {
    const snapshot: CacheFile = { version: 1, entries: this.entries ?? {} };
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, JSON.stringify(snapshot));
      })
      .catch((err: unknown) => {
        this.log.debug('provider cache write failed', {
          file: path.basename(this.file),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    await this.writing;
  }
}

/** No-op cache for providers whose data policy forbids caching. */
export const deniedProviderCache: ProviderCache = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
};

/**
 * Provider-scoped settings backed by an injected key-value document, so the desktop can
 * persist them and tests can hold them in memory. `onChange` fires when the runtime
 * writes new settings for this provider (`sources.settings.set`).
 */
export class ProviderSettingsView implements ProviderSettings {
  private readonly listeners = new Set<(settings: Record<string, JsonValue>) => void>();

  constructor(private readonly read: () => Record<string, JsonValue>) {}

  async get(): Promise<Record<string, JsonValue>> {
    return { ...this.read() };
  }

  onChange(listener: (settings: Record<string, JsonValue>) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called by the runtime after a settings write. */
  notify(settings: Record<string, JsonValue>): void {
    for (const l of [...this.listeners]) {
      try {
        l({ ...settings });
      } catch {
        /* a provider listener must not break the write */
      }
    }
  }
}

/** Persistent per-provider settings document: `<dataDir>/provider-settings.json`. */
export class ProviderSettingsStore {
  private data: Record<string, Record<string, JsonValue>> = {};
  private readonly views = new Map<string, ProviderSettingsView>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: Logger = silentLogger,
  ) {}

  async load(): Promise<void> {
    const doc = await readJsonFile<{ version: 1; providers: Record<string, Record<string, JsonValue>> }>(
      this.file,
    ).catch(() => undefined);
    this.data =
      doc && typeof doc === 'object' && doc.providers && typeof doc.providers === 'object' ? { ...doc.providers } : {};
  }

  get(providerId: string): Record<string, JsonValue> {
    return { ...(this.data[providerId] ?? {}) };
  }

  view(providerId: string): ProviderSettingsView {
    let v = this.views.get(providerId);
    if (!v) {
      v = new ProviderSettingsView(() => this.data[providerId] ?? {});
      this.views.set(providerId, v);
    }
    return v;
  }

  async set(providerId: string, settings: Record<string, JsonValue>): Promise<void> {
    this.data[providerId] = { ...settings };
    await this.persist();
    this.views.get(providerId)?.notify(this.data[providerId]!);
  }

  private async persist(): Promise<void> {
    const snapshot = { version: 1 as const, providers: this.data };
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, `${JSON.stringify(snapshot, null, 2)}\n`);
      })
      .catch((err: unknown) => {
        this.log.error('provider settings write failed', { error: err instanceof Error ? err.message : String(err) });
      });
    await this.writing;
  }
}

export interface LocalAccessOptions {
  /** Absolute directory this provider may read from. Omitted → reads are refused. */
  grantDir?: string;
  /** Hosts from the provider manifest; only loopback entries are probeable. */
  allowedHosts: string[];
  /** The host the user named in the provider's `trustedHostSetting` (probeable too). */
  trustedHosts?: () => readonly string[];
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
}

/**
 * Granted-directory reads and loopback probing. Paths are resolved inside the grant and
 * checked with `isInsideDir`, so `../` and absolute paths can never escape it.
 */
export function createLocalAccess(opts: LocalAccessOptions): ProviderLocalAccess {
  const grantDir = opts.grantDir;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  return {
    async readGrantedFile(file, readOpts) {
      if (!grantDir)
        throw new ProviderError('UNSUPPORTED', 'no local directory is granted to this provider', { retryable: false });
      const target = path.resolve(grantDir, file);
      if (!isInsideDir(grantDir, target))
        throw new ProviderError('HOST_NOT_ALLOWED', 'path escapes the granted directory', { retryable: false });
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(target);
      } catch {
        throw new ProviderError('UNSUPPORTED', `granted file ${path.basename(target)} does not exist`, {
          retryable: false,
        });
      }
      const limit = Math.min(readOpts?.maxBytes ?? maxBytes, maxBytes);
      if (stat.size > limit)
        throw new ProviderError('TOO_LARGE', `granted file exceeds ${limit} bytes`, { retryable: false });
      return new Uint8Array(await fs.readFile(target));
    },
    async probeLocal(url, probeOpts) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { reachable: false };
      }
      const host = parsed.hostname.toLowerCase();
      const named = (opts.trustedHosts?.() ?? []).some((t) => t.toLowerCase() === host);
      if (!named && (!isLoopbackHost(host) || !allowed.has(host))) return { reachable: false };
      const impl = opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), probeOpts?.timeoutMs ?? 2000);
      try {
        const res = await impl(parsed.toString(), { method: 'GET', signal: controller.signal, redirect: 'manual' });
        return { reachable: res.status < 500, status: res.status };
      } catch {
        return { reachable: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
