import type { WorldClient, WorldRequests, WorldEvents, RequestChannel, EventChannel } from '@worldview/ipc-contract';

/**
 * WorldRuntime — the in-process composition of providers, world state, history,
 * events, search, offline and cameras. The desktop main process wraps it with the
 * IPC router; browser/demo mode calls it directly through `InProcessClient`.
 *
 * Handlers are keyed by IPC channel so the runtime *is* the implementation of the
 * request catalogue — one place, no duplication between transports.
 */
export type RequestHandlers = {
  [C in RequestChannel]: (request: WorldRequests[C]['request'], ctx: RequestContext) => Promise<WorldRequests[C]['response']>;
};

export interface RequestContext {
  /** Identifies the calling window/client for subscriptions. */
  clientId: string;
  signal: AbortSignal;
}

export interface WorldRuntime {
  readonly handlers: RequestHandlers;
  /** Subscribe to runtime events (fan-out to all clients). */
  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E], clientId?: string) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Application-level connectivity input (from the shell's network monitor). */
  setNetworkOnline(online: boolean): void;
}

/** In-process client: same WorldClient interface the preload bridge exposes. */
export function createInProcessClient(runtime: WorldRuntime, clientId = 'in-process'): WorldClient {
  return {
    contractVersion: 1,
    request: (channel, request) => {
      const handler = runtime.handlers[channel] as (req: unknown, ctx: RequestContext) => Promise<unknown>;
      return handler(request, { clientId, signal: new AbortController().signal }) as Promise<never>;
    },
    on: (event, listener) => runtime.on(event, (payload, target) => { if (!target || target === clientId) listener(payload); }),
  };
}
