import type { EventChannel, WorldEvents } from '@worldview/ipc-contract';
import type { RequestHandlers, WorldRuntime } from './contract.js';
import { RuntimeCore } from './core.js';
import { createHandlers } from './handlers.js';
import type { WorldRuntimeDeps } from './deps.js';
import { LocalApiServer, defaultSocketPath, type LocalApiDeps } from './support/local-api.js';

/**
 * The composed runtime. `createWorldRuntime(deps)` builds the object graph, wires it and
 * returns the frozen `WorldRuntime` interface the desktop main process and the in-process
 * client both consume.
 *
 * `createWorldRuntime({ demo: true })` builds the same graph with fixture-backed
 * providers; everything it serves is marked `provenance.origin: 'recorded'` and
 * `app.info.demoMode` is true, so the shell labels it RECORDED DATA.
 */
class ComposedRuntime implements WorldRuntime {
  readonly handlers: RequestHandlers;
  /** The local read-only API (ADR-014), while the operator has it on. */
  localApi: LocalApiServer | undefined;
  private localApiOff: (() => void) | undefined;
  private localApiSync: Promise<void> = Promise.resolve();

  constructor(
    readonly core: RuntimeCore,
    private readonly socketPath: string | undefined,
  ) {
    this.handlers = createHandlers(core);
  }

  /** What the API reads, all of it read-only views of the running app. */
  private localApiDeps(): LocalApiDeps {
    const core = this.core;
    return {
      now: () => core.clock.now(),
      app: { version: core.version, channel: core.channel, commit: core.commit },
      recorded: () => core.demoMode(),
      ownPositionAllowed: () => core.settings.get().localApi?.ownPosition === true,
      workOffline: () => core.settings.get().network?.workOffline === true,
      connection: () => core.connectionSnapshot(),
      sources: () => core.providerHost.health.list(),
      policy: (id) => core.providerHost.manifest(id)?.dataPolicy,
      objects: () => core.state.all(),
      objectsNear: (center, radiusM) => core.state.withinRegion({ kind: 'circle', center, radiusM }),
      object: (id) => core.state.get(id),
      contributors: (id) => core.state.contributors(id),
      trackProviders: (id, start, end) => core.history.trackProviders(id, { start, end }),
      track: (objectId, start, end) =>
        this.handlers['world.track'](
          { objectId, time: { start, end } },
          {
            clientId: 'local-api',
            signal: new AbortController().signal,
          },
        ) as Promise<never>,
      offline: () => core.offlineStatus(),
    };
  }

  /** Start or stop the local API to match the settings (Linux only; off by default). */
  private syncLocalApi(): Promise<void> {
    this.localApiSync = this.localApiSync.then(async () => {
      const want = this.core.platform === 'linux' && this.core.settings.get().localApi?.enabled === true;
      if (want && !this.localApi) {
        if (!this.socketPath) {
          this.core.log.warn('local API not started: no XDG_RUNTIME_DIR for its socket', {});
          return;
        }
        const server = new LocalApiServer({
          socketPath: this.socketPath,
          deps: this.localApiDeps(),
          log: this.core.log,
        });
        try {
          await server.start();
          this.localApi = server;
        } catch (err) {
          this.core.log.warn('local API not started', { message: err instanceof Error ? err.message : String(err) });
        }
      } else if (!want && this.localApi) {
        const server = this.localApi;
        this.localApi = undefined;
        await server.stop();
      }
    });
    return this.localApiSync;
  }

  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E], clientId?: string) => void): () => void {
    return this.core.emitter.on(event, listener);
  }

  async start(): Promise<void> {
    await this.core.start();
    this.localApiOff ??= this.core.emitter.on('settings.changed', () => void this.syncLocalApi());
    await this.syncLocalApi();
  }
  async stop(): Promise<void> {
    this.localApiOff?.();
    this.localApiOff = undefined;
    await this.localApiSync;
    const server = this.localApi;
    this.localApi = undefined;
    await server?.stop();
    await this.core.stop();
  }

  setNetworkOnline(online: boolean): void {
    this.core.setNetworkOnline(online);
  }

  setPowerSource(onBattery: boolean): void {
    this.core.setPowerSource(onBattery);
  }

  notifyResume(): Promise<void> {
    return this.core.notifyResume();
  }
}

/**
 * The returned runtime also exposes its `core`, so the desktop can read composed parts
 * (provider manifests for the external-link allowlist, the log sink for diagnostics) and
 * tests can assert on history/state without going through IPC. The `WorldRuntime`
 * contract is unchanged; `core` is an addition, never a substitute.
 */
export interface ComposedWorldRuntime extends WorldRuntime {
  readonly core: RuntimeCore;
  /** The local read-only API while it is on (ADR-014). */
  readonly localApi: LocalApiServer | undefined;
}

export async function createWorldRuntime(deps: WorldRuntimeDeps = {}): Promise<ComposedWorldRuntime> {
  const core = new RuntimeCore(deps);
  await core.build();
  return new ComposedRuntime(core, deps.localApiSocket ?? defaultSocketPath());
}

export type { ComposedRuntime };
