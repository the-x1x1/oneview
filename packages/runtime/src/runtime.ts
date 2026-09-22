import type { EventChannel, WorldEvents } from '@worldview/ipc-contract';
import type { RequestHandlers, WorldRuntime } from './contract.js';
import { RuntimeCore } from './core.js';
import { createHandlers } from './handlers.js';
import type { WorldRuntimeDeps } from './deps.js';

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

  constructor(readonly core: RuntimeCore) {
    this.handlers = createHandlers(core);
  }

  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E], clientId?: string) => void): () => void {
    return this.core.emitter.on(event, listener);
  }

  start(): Promise<void> {
    return this.core.start();
  }
  stop(): Promise<void> {
    return this.core.stop();
  }

  setNetworkOnline(online: boolean): void {
    this.core.setNetworkOnline(online);
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
}

export async function createWorldRuntime(deps: WorldRuntimeDeps = {}): Promise<ComposedWorldRuntime> {
  const core = new RuntimeCore(deps);
  await core.build();
  return new ComposedRuntime(core);
}

export type { ComposedRuntime };
