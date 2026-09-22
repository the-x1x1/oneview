import {
  REQUEST_CHANNELS,
  type AppSettings,
  type EventChannel,
  type RequestChannel,
  type WorldEvents,
} from '@worldview/ipc-contract';
import type { RequestContext, RequestHandlers, WorldRuntime } from '@worldview/runtime';
import { DEFAULT_SETTINGS, applySettingsPatch, cloneSettings } from '@worldview/config';

/**
 * StubRuntime — a WorldRuntime for tests and for the main process until the real
 * runtime (packages/runtime, lead) is wired: answers app.info and settings.*, echoes
 * every other request as `{ echo: channel, request }`, records network state, and
 * lets tests emit events. It is never used in a packaged build without a loud log line.
 */
export interface StubRuntimeOptions {
  version?: string;
  commit?: string;
  platform?: string;
  settings?: Partial<AppSettings>;
  /** Channels whose handler should throw the given error (error-mapping tests). */
  failures?: Partial<Record<RequestChannel, unknown>>;
}

type Listener = (payload: unknown, clientId?: string) => void;

export class StubRuntime implements WorldRuntime {
  readonly handlers: RequestHandlers;
  readonly calls: Array<{ channel: RequestChannel; request: unknown; clientId: string }> = [];
  networkOnline: boolean | undefined;
  started = false;
  private settings: AppSettings;
  private readonly listeners = new Map<EventChannel, Set<Listener>>();

  constructor(private readonly opts: StubRuntimeOptions = {}) {
    this.settings = applySettingsPatch(cloneSettings(DEFAULT_SETTINGS), opts.settings ?? {});
    const table: Record<string, (request: unknown, ctx: RequestContext) => Promise<unknown>> = {};
    for (const channel of REQUEST_CHANNELS) {
      table[channel] = async (request, ctx) => {
        this.calls.push({ channel, request, clientId: ctx.clientId });
        const failure = this.opts.failures?.[channel];
        if (failure !== undefined) throw failure;
        return this.answer(channel, request);
      };
    }
    this.handlers = table as unknown as RequestHandlers;
  }

  private answer(channel: RequestChannel, request: unknown): unknown {
    switch (channel) {
      case 'app.info':
        return {
          version: this.opts.version ?? '0.0.0-stub',
          channel: 'dev',
          commit: this.opts.commit ?? 'stub',
          demoMode: this.settings.demoMode,
          platform: this.opts.platform ?? process.platform,
        };
      case 'settings.get':
        return cloneSettings(this.settings);
      case 'settings.set': {
        this.settings = applySettingsPatch(this.settings, request as Partial<AppSettings>);
        const next = cloneSettings(this.settings);
        this.emit('settings.changed', next);
        return next;
      }
      default:
        return { echo: channel, request: request ?? null };
    }
  }

  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E], clientId?: string) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener);
    return () => {
      set!.delete(listener as Listener);
    };
  }

  emit<E extends EventChannel>(event: E, payload: WorldEvents[E], clientId?: string): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(payload, clientId);
  }

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  setNetworkOnline(online: boolean): void {
    this.networkOnline = online;
  }
}
