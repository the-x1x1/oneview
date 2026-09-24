import type { Clock, GeoPosition } from '@worldview/world-model';
import type { Logger, LoggerHub, CredentialResolver } from '@worldview/core';
import type { DataDirs, SettingsStore } from '@worldview/config';
import type { WorldProvider } from '@worldview/provider-sdk';
import type { DiagnosticsSnapshot } from '@worldview/ipc-contract';
import type { NetworkSignal } from '@worldview/offline';
import type { SpawnFn } from '@worldview/camera-gateway';
import type { AutoUpdaterLike } from '@worldview/updater';
import type { ProviderRegistryOptions } from '@worldview/providers';

/**
 * Everything the runtime needs from its shell. The desktop main process supplies the
 * real implementations; browser/demo/test callers can leave almost all of it out.
 */

/** Credential storage. Reads are for the network layer only — `credentials.get` is never an IPC channel. */
export interface RuntimeCredentialStore extends CredentialResolver {
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  onChange?(listener: (key: string) => void): () => void;
}

export type FileChoice = { path: string } | { cancelled: true };

/**
 * HostBridge — capabilities that genuinely need the desktop shell: native dialogs, the
 * OS browser, OS notifications and app paths. The runtime calls it; the in-process
 * implementation answers `{ cancelled: true }` so every handler still returns a valid
 * contract response in the browser and in tests.
 */
export interface HostBridge {
  pickOpenFile(opts: { title: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<FileChoice>;
  pickSaveFile(opts: {
    title: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<FileChoice>;
  openExternal(url: string): Promise<boolean>;
  showNotification(notification: { title: string; body: string }): void;
  appPaths(): { downloads?: string };
}

/** The browser / in-process HostBridge: no dialogs, no shell, nothing silently written anywhere. */
export const inProcessHostBridge: HostBridge = {
  pickOpenFile: async () => ({ cancelled: true }),
  pickSaveFile: async () => ({ cancelled: true }),
  openExternal: async () => false,
  showNotification: () => {},
  appPaths: () => ({}),
};

export interface WorldRuntimeDeps {
  /** userData layout. Defaults to `dataDirs(<os tmp>/worldview-runtime)` only when `dataDir` is also absent. */
  dirs?: DataDirs;
  /** Convenience alternative to `dirs`. */
  dataDir?: string;
  settings?: SettingsStore;
  credentials?: RuntimeCredentialStore;
  logger?: Logger;
  loggerHub?: LoggerHub;

  version?: string;
  commit?: string;
  channel?: 'stable' | 'prerelease' | 'dev';
  platform?: string;

  /** Fixture-backed providers, `provenance.origin: 'recorded'`, `app.info.demoMode === true`. */
  demo?: boolean;

  clock?: Clock;
  host?: HostBridge;
  /** OS connectivity signal. Defaults to "always online"; the desktop passes Electron's `net`. */
  network?: NetworkSignal;
  /**
   * Map tile sources with tiles in the desktop's disk cache (apps/desktop/src/main/
   * tile-cache.ts), so that offline `map.providers.list` keeps them selectable. Absent: none.
   */
  cachedTileSources?: () => Promise<readonly string[]>;
  fetchImpl?: typeof fetch;
  /** Child-process spawner for the optional go2rtc sidecar (tests pass a fake; nothing else spawns). */
  spawnImpl?: SpawnFn;
  webSocketImpl?: typeof WebSocket;
  /** MQTT socket factory (tests pass a fake broker; the runtime uses node:net / node:tls). */
  mqttConnect?: (opts: { host: string; port: number; tls: boolean }) => import('node:net').Socket;

  /**
   * Directory of bundled read-only data granted to filesystem-transport providers
   * (e.g. the seed airports GeoJSON). Without it those providers report an error
   * instead of silently serving nothing.
   */
  resourcesDir?: string;
  /**
   * The Natural Earth label file the map draws place names from (`reference/labels.json`).
   * When given, its countries and ~4,500 states and provinces are searchable by name.
   */
  referenceLabelsPath?: string;
  /** Per-provider overrides of the granted directory. */
  localGrants?: Record<string, string>;

  /** Registry options, or an explicit provider list (tests, demo). */
  providers?: ProviderRegistryOptions;
  providerInstances?: WorldProvider[];
  /** Provider ids to register but leave disabled regardless of `enabledByDefault`. */
  disabledProviders?: string[];

  /** World-state sweep interval (default 15 s). */
  sweepIntervalMs?: number;
  /** World-state flush batching delay (default 250 ms). */
  flushDelayMs?: number;
  /** History retention sweep interval (default 15 min). */
  retentionIntervalMs?: number;
  /** Longest a source's health update waits before `sources.changed` carries it (default 5 s). */
  sourcesUpdateThrottleMs?: number;
  /** Delay before the first retention sweep after start (default 2 min). */
  firstRetentionDelayMs?: number;
  historyBackend?: 'ndjson' | 'duckdb-parquet';
  /** Disable the provider polling scheduler; tests drive `sources.refresh`. */
  manualScheduling?: boolean;
  /** Skip the reachability probe (offline tests, demo). */
  disableReachabilityProbe?: boolean;

  /** electron-updater stand-in. Defaults to the inert updater (status `disabled`). */
  updater?: AutoUpdaterLike;
  /** Build trust inputs for the update policy. */
  build?: { signed: boolean; packaged: boolean };

  /** Renderer / runtime facts for diagnostics; the desktop fills these from Electron. */
  rendererInfo?: () => DiagnosticsSnapshot['renderer'];
  runtimeInfo?: () => DiagnosticsSnapshot['runtime'];
  /** Process memory and its trend (the desktop samples Electron's app metrics). */
  memoryInfo?: () => DiagnosticsSnapshot['memory'];

  /** Search bias when the caller gives none (last viewport centre). */
  defaultSearchBias?: GeoPosition;
}
