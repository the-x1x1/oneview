import type { DiagnosticsSnapshot, OfflineStatus, UpdaterState } from '@worldview/ipc-contract';
import type { SourceHealthEntry } from '@worldview/source-health';
import { silentLogger, type Logger } from '@worldview/core';

type MaybePromise<T> = T | Promise<T>;

/**
 * Each part of the snapshot comes from an injected source so this package depends
 * on nothing but the contract: the main process wires providers/database/offline/…
 * A failing source never fails the snapshot; it degrades to a safe value and the
 * failure is listed in `problems`.
 */
export interface DiagnosticsSources {
  app: () => MaybePromise<DiagnosticsSnapshot['app']>;
  runtime: () => MaybePromise<DiagnosticsSnapshot['runtime']>;
  providers: () => MaybePromise<SourceHealthEntry[]>;
  database: () => MaybePromise<DiagnosticsSnapshot['database']>;
  offline: () => MaybePromise<OfflineStatus>;
  renderer: () => MaybePromise<DiagnosticsSnapshot['renderer']>;
  sidecars: () => MaybePromise<DiagnosticsSnapshot['sidecars']>;
  updater: () => MaybePromise<UpdaterState>;
  disk: () => MaybePromise<DiagnosticsSnapshot['disk']>;
  logs: () => MaybePromise<DiagnosticsSnapshot['logs']>;
}

export interface DiagnosticsCollection {
  snapshot: DiagnosticsSnapshot;
  /** Sources that threw, with sanitized reasons. */
  problems: Array<{ source: keyof DiagnosticsSources; error: string }>;
}

const FALLBACK_CONNECTION: OfflineStatus['connection'] = { state: 'OFFLINE', networkOnline: false, remoteLive: 0, remoteTotal: 0, localLive: 0, at: new Date(0).toISOString() };

export function fallbackSnapshot(now: () => number = Date.now): DiagnosticsSnapshot {
  const at = new Date(now()).toISOString();
  return {
    app: { version: 'unknown', channel: 'dev', commit: 'unknown', demoMode: false, startedAt: at },
    runtime: { electron: 'unknown', chrome: 'unknown', node: process.version, platform: process.platform, arch: process.arch },
    providers: [],
    database: { status: 'error', backend: 'unknown', sizeBytes: 0, partitions: 0, message: 'database source unavailable' },
    offline: { connection: { ...FALLBACK_CONNECTION, at }, packs: [], capabilities: { localMap: false, localSearch: false, history: false, collections: false, localAircraft: false } },
    renderer: { active: '2D', webgl2: false },
    sidecars: [],
    updater: { channel: 'stable', automatic: false, status: 'disabled', currentVersion: 'unknown', signed: false },
    disk: { dataDir: 'unknown', usedBytes: 0 },
    logs: { path: 'unknown', sizeBytes: 0 },
  };
}

export class DiagnosticsCollector {
  private readonly logger: Logger;

  constructor(private readonly sources: DiagnosticsSources, opts: { logger?: Logger; now?: () => number } = {}) {
    this.logger = opts.logger ?? silentLogger;
    this.fallback = fallbackSnapshot(opts.now ?? Date.now);
  }

  private readonly fallback: DiagnosticsSnapshot;

  async collect(): Promise<DiagnosticsCollection> {
    const problems: DiagnosticsCollection['problems'] = [];
    const take = async <K extends keyof DiagnosticsSources>(key: K): Promise<DiagnosticsSnapshot[K]> => {
      try {
        return (await this.sources[key]()) as DiagnosticsSnapshot[K];
      } catch (err) {
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        problems.push({ source: key, error });
        this.logger.warn('diagnostics source failed', { source: key, error });
        return this.fallback[key];
      }
    };
    const [app, runtime, providers, database, offline, renderer, sidecars, updater, disk, logs] = await Promise.all([
      take('app'), take('runtime'), take('providers'), take('database'), take('offline'), take('renderer'), take('sidecars'), take('updater'), take('disk'), take('logs'),
    ]);
    return { snapshot: { app, runtime, providers, database, offline, renderer, sidecars, updater, disk, logs }, problems };
  }

  /** The IPC `diagnostics.get` response: just the snapshot. */
  async snapshot(): Promise<DiagnosticsSnapshot> {
    return (await this.collect()).snapshot;
  }
}
