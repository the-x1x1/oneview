import type { WorldRuntime } from '@worldview/runtime';
import type { Logger, CredentialResolver } from '@worldview/core';
import type { DataDirs, SettingsStore } from '@worldview/config';
import { StubRuntime } from './testing/stub-runtime.js';

/**
 * What main hands to the runtime. `createWorldRuntime(deps)` is the integration
 * point owned by packages/runtime; until it exists the main process runs the
 * StubRuntime (settings only) and says so in the log and in app.info.
 */
export interface RuntimeDeps {
  dirs: DataDirs;
  settings: SettingsStore;
  credentials: CredentialResolver;
  logger: Logger;
  version: string;
  commit: string;
  channel: 'stable' | 'prerelease' | 'dev';
  platform: string;
}

export type RuntimeFactory = (deps: RuntimeDeps) => Promise<WorldRuntime> | WorldRuntime;

export interface RuntimeSelection { runtime: WorldRuntime; kind: 'runtime' | 'stub' }

export async function createRuntime(deps: RuntimeDeps): Promise<RuntimeSelection> {
  const mod = (await import('@worldview/runtime')) as Record<string, unknown>;
  const factory = mod['createWorldRuntime'];
  if (typeof factory === 'function') {
    return { runtime: await (factory as RuntimeFactory)(deps), kind: 'runtime' };
  }
  deps.logger.warn('runtime not integrated: @worldview/runtime exports no createWorldRuntime; running the settings-only StubRuntime');
  return { runtime: new StubRuntime({ version: deps.version, commit: deps.commit, platform: deps.platform, settings: deps.settings.get() }), kind: 'stub' };
}
