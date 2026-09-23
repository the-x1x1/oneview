import {
  createWorldRuntime,
  type HostBridge,
  type RuntimeCredentialStore,
  type WorldRuntime,
  type WorldRuntimeDeps,
} from '@worldview/runtime';
import type { Logger, LoggerHub } from '@worldview/core';
import type { DataDirs, SettingsStore } from '@worldview/config';
import type { DiagnosticsSnapshot } from '@worldview/ipc-contract';
import type { AutoUpdaterLike } from '@worldview/updater';
import type { NetworkSignal } from '@worldview/offline';

/**
 * What main hands to the runtime. `createWorldRuntime` (packages/runtime) composes the
 * providers, world state, history, events, search, offline and camera graph; everything
 * that genuinely needs Electron — native dialogs, `shell.openExternal`, OS notifications,
 * the `net` connectivity signal, the packaged resources directory — is injected here.
 */
export interface RuntimeDeps {
  dirs: DataDirs;
  settings: SettingsStore;
  /** safeStorage-backed credential store (read by the network layer, never by the renderer). */
  credentials: RuntimeCredentialStore;
  logger: Logger;
  loggerHub?: LoggerHub;
  version: string;
  commit: string;
  channel: 'stable' | 'prerelease' | 'dev';
  platform: string;
  /** Native dialogs / shell / notifications. Omitted in tests → the in-process bridge. */
  host?: HostBridge;
  /** Electron's `net.isOnline()`; the runtime folds it into the connection monitor. */
  network?: NetworkSignal;
  /** Sources with tiles in the disk tile cache (tile-cache.ts), for the offline basemap list. */
  cachedTileSources?: () => Promise<readonly string[]>;
  /** Read-only bundled data granted to filesystem providers (packaged `resources/data`). */
  resourcesDir?: string;
  /** The map's Natural Earth label file; its places become searchable (runtime deps). */
  referenceLabelsPath?: string;
  /** Fixture-backed providers; everything is labelled RECORDED DATA. */
  demo?: boolean;
  updater?: AutoUpdaterLike;
  build?: { signed: boolean; packaged: boolean };
  rendererInfo?: () => DiagnosticsSnapshot['renderer'];
  runtimeInfo?: () => DiagnosticsSnapshot['runtime'];
  memoryInfo?: () => DiagnosticsSnapshot['memory'];
}

export interface RuntimeSelection {
  runtime: WorldRuntime;
  kind: 'runtime';
}

export function runtimeDepsFor(deps: RuntimeDeps): WorldRuntimeDeps {
  return {
    dirs: deps.dirs,
    settings: deps.settings,
    credentials: deps.credentials,
    logger: deps.logger,
    version: deps.version,
    commit: deps.commit,
    channel: deps.channel,
    platform: deps.platform,
    ...(deps.loggerHub ? { loggerHub: deps.loggerHub } : {}),
    ...(deps.host ? { host: deps.host } : {}),
    ...(deps.network ? { network: deps.network } : {}),
    ...(deps.cachedTileSources ? { cachedTileSources: deps.cachedTileSources } : {}),
    ...(deps.resourcesDir ? { resourcesDir: deps.resourcesDir } : {}),
    ...(deps.referenceLabelsPath ? { referenceLabelsPath: deps.referenceLabelsPath } : {}),
    ...(deps.demo ? { demo: true } : {}),
    ...(deps.updater ? { updater: deps.updater } : {}),
    ...(deps.build ? { build: deps.build } : {}),
    ...(deps.rendererInfo ? { rendererInfo: deps.rendererInfo } : {}),
    ...(deps.memoryInfo ? { memoryInfo: deps.memoryInfo } : {}),
    ...(deps.runtimeInfo ? { runtimeInfo: deps.runtimeInfo } : {}),
  };
}

export async function createRuntime(deps: RuntimeDeps): Promise<RuntimeSelection> {
  const runtime = await createWorldRuntime(runtimeDepsFor(deps));
  return { runtime, kind: 'runtime' };
}
