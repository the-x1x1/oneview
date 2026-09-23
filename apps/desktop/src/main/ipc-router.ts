import {
  EVENT_CHANNELS,
  REQUEST_CHANNELS,
  IPC_PREFIX,
  wireChannel,
  isIpcError,
  type EventChannel,
  type IpcError,
  type RequestChannel,
  type WorldEvents,
} from '@worldview/ipc-contract';
import type { RequestContext, RequestHandlers, WorldRuntime } from '@worldview/runtime';
import { formatIssues, systemClock, type Clock } from '@worldview/world-model';
import { RateLimiter, redactText, silentLogger, type Logger } from '@worldview/core';
import { ProviderError } from '@worldview/provider-sdk';
import { REQUEST_SCHEMAS, schemaFor } from './ipc-schemas.js';
import { okEnvelope, errorEnvelope, type IpcResultEnvelope } from '../shared/ipc-envelope.js';
import { chunkWorldDelta, responseToWire, toWire } from '../shared/event-wire.js';

/** The slice of Electron's ipcMain / webContents the router needs (tests inject fakes). */
export interface IpcInvokeEventLike {
  sender: { readonly id: number };
  senderFrame?: { readonly url: string } | null;
}
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
}
export interface WindowSinkLike {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

export interface IpcRateLimitRule {
  prefix: string;
  max: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: readonly IpcRateLimitRule[] = Object.freeze([
  { prefix: 'credentials.', max: 10, windowMs: 60_000 },
  { prefix: 'app.openExternal', max: 30, windowMs: 60_000 },
  { prefix: 'camera.register', max: 20, windowMs: 60_000 },
]);

export interface IpcRouterOptions {
  ipcMain: IpcMainLike;
  runtime: WorldRuntime;
  /** Handlers main binds itself (credential store, shell, dialogs, updater) take precedence over the runtime's. */
  overrides?: Partial<RequestHandlers>;
  /** Refuses requests from frames outside the app origin. Default: accept (main sets a real check). */
  isTrustedSender?: (event: IpcInvokeEventLike) => boolean;
  rateLimits?: readonly IpcRateLimitRule[];
  logger?: Logger;
  clock?: Clock;
  /** Per-request timeout; the handler's AbortSignal fires and the renderer gets UNAVAILABLE. */
  requestTimeoutMs?: number;
}

const GENERIC_INTERNAL_MESSAGE = 'internal error (details are in the application log)';

/**
 * IpcRouter — the only bridge between renderer requests and the runtime.
 *
 *  - registers exactly the REQUEST_CHANNELS catalogue on ipcMain (nothing else is handled)
 *  - validates every payload against its channel schema before any handler runs
 *  - refuses untrusted senders and rate-limits sensitive channels per window
 *  - maps failures to IpcError {code, message, channel} with no stack traces or secrets
 *  - fans runtime events out to attached windows on EVENT_CHANNELS
 */
export class IpcRouter {
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly limiters: Array<{ rule: IpcRateLimitRule; limiter: RateLimiter }>;
  private readonly windows = new Map<number, WindowSinkLike>();
  private readonly unsubscribers: Array<() => void> = [];
  private registered = false;

  constructor(private readonly opts: IpcRouterOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.clock = opts.clock ?? systemClock;
    this.limiters = (opts.rateLimits ?? DEFAULT_RATE_LIMITS).map((rule) => ({
      rule,
      limiter: new RateLimiter({ windowMs: rule.windowMs, max: rule.max }, this.clock),
    }));
  }

  /** Registers one ipcMain.handle per catalogue channel and subscribes to runtime events. */
  register(): void {
    if (this.registered) return;
    this.registered = true;
    for (const channel of REQUEST_CHANNELS) {
      this.opts.ipcMain.handle(wireChannel(channel), (event, payload) => this.handle(channel, payload, event));
    }
    for (const event of EVENT_CHANNELS) {
      this.unsubscribers.push(
        this.opts.runtime.on(event, (payload, clientId) => this.fanOut(event, payload, clientId)),
      );
    }
  }

  dispose(): void {
    for (const channel of REQUEST_CHANNELS) this.opts.ipcMain.removeHandler(wireChannel(channel));
    for (const off of this.unsubscribers.splice(0)) off();
    this.windows.clear();
    this.registered = false;
  }

  attachWindow(win: WindowSinkLike): () => void {
    this.windows.set(win.id, win);
    return () => {
      this.windows.delete(win.id);
    };
  }

  static clientIdFor(senderId: number): string {
    return `win:${senderId}`;
  }

  /**
   * The handler body, also used directly by tests. `channel` is the logical name; a
   * wire name (with prefix) is accepted and stripped so unknown wire channels are
   * refused identically.
   */
  async handle(channelName: string, payload: unknown, event: IpcInvokeEventLike): Promise<IpcResultEnvelope> {
    const channel = channelName.startsWith(IPC_PREFIX) ? channelName.slice(IPC_PREFIX.length) : channelName;
    const schema = schemaFor(channel);
    if (!schema || !REQUEST_CHANNELS.includes(channel as RequestChannel)) {
      this.logger.warn('ipc: unknown channel refused', {
        channel: String(channel).slice(0, 80),
        sender: event.sender.id,
      });
      return errorEnvelope({ code: 'DENIED', message: 'unknown channel', channel: String(channel).slice(0, 80) });
    }
    if (this.opts.isTrustedSender && !this.opts.isTrustedSender(event)) {
      this.logger.warn('ipc: untrusted sender refused', {
        channel,
        sender: event.sender.id,
        url: redactText(event.senderFrame?.url ?? '').slice(0, 120),
      });
      return errorEnvelope({ code: 'DENIED', message: 'untrusted sender', channel });
    }
    for (const { rule, limiter } of this.limiters) {
      if (channel.startsWith(rule.prefix)) {
        const wait = limiter.tryAcquire(`${rule.prefix}|${event.sender.id}`);
        if (wait > 0) {
          this.logger.warn('ipc: rate limit hit', { channel, sender: event.sender.id, retryInMs: wait });
          return errorEnvelope({
            code: 'DENIED',
            message: `rate limited; retry in ${Math.ceil(wait / 1000)}s`,
            channel,
          });
        }
      }
    }
    const parsed = schema.parse(payload);
    if (!parsed.ok) {
      this.logger.warn('ipc: invalid request', { channel, issues: formatIssues(parsed.issues) });
      return errorEnvelope({ code: 'INVALID_REQUEST', message: formatIssues(parsed.issues), channel });
    }
    const handler = this.resolveHandler(channel as RequestChannel);
    const controller = new AbortController();
    const timeoutMs = this.opts.requestTimeoutMs ?? 60_000;
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
    const ctx: RequestContext = { clientId: IpcRouter.clientIdFor(event.sender.id), signal: controller.signal };
    try {
      // A handler that ignores its AbortSignal still cannot hold the renderer's promise open past the timeout.
      const aborted = new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }),
      );
      const value = await Promise.race([handler(parsed.value, ctx), aborted]);
      return okEnvelope(responseToWire(channel as RequestChannel, value));
    } catch (err) {
      return errorEnvelope(this.toIpcError(err, channel, controller.signal.aborted));
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveHandler(channel: RequestChannel): (request: unknown, ctx: RequestContext) => Promise<unknown> {
    const override = this.opts.overrides?.[channel] as
      ((request: unknown, ctx: RequestContext) => Promise<unknown>) | undefined;
    const base = this.opts.runtime.handlers[channel] as
      ((request: unknown, ctx: RequestContext) => Promise<unknown>) | undefined;
    const fn = override ?? base;
    if (!fn)
      return async () => {
        throw Object.assign(new Error('not implemented'), { ipcCode: 'UNAVAILABLE' as const });
      };
    return fn;
  }

  /** Never leaks stack traces, file paths or secrets to the renderer. */
  private toIpcError(err: unknown, channel: string, timedOut: boolean): IpcError {
    if (timedOut) return { code: 'UNAVAILABLE', message: 'request timed out', channel };
    if (isIpcError(err)) return { code: err.code, message: redactText(String(err.message)).slice(0, 300), channel };
    if (err instanceof ProviderError)
      return { code: mapProviderCode(err), message: redactText(err.message).slice(0, 300), channel };
    const hinted =
      err && typeof err === 'object' && 'ipcCode' in err
        ? (err as { ipcCode: IpcError['code']; message?: string })
        : undefined;
    if (hinted)
      return {
        code: hinted.ipcCode,
        message: redactText(String(hinted.message ?? hinted.ipcCode)).slice(0, 300),
        channel,
      };
    this.logger.error('ipc: handler failed', {
      channel,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return { code: 'INTERNAL', message: GENERIC_INTERNAL_MESSAGE, channel };
  }

  private fanOut<E extends EventChannel>(event: E, payload: WorldEvents[E], clientId: string | undefined): void {
    if (event === 'world.changed') {
      const parts = chunkWorldDelta(payload as WorldEvents['world.changed']);
      if (parts.length > 1) {
        for (const part of parts) this.send(event, part as WorldEvents[E], clientId);
        return;
      }
    }
    this.send(event, payload, clientId);
  }

  private send<E extends EventChannel>(event: E, payload: WorldEvents[E], clientId: string | undefined): void {
    const wire = wireChannel(event);
    // Encoded once however many windows receive it (shared/event-wire.ts).
    const onWire = toWire(event, payload);
    for (const [id, win] of this.windows) {
      if (clientId && clientId !== IpcRouter.clientIdFor(id)) continue;
      if (win.isDestroyed()) {
        this.windows.delete(id);
        continue;
      }
      try {
        win.send(wire, onWire);
      } catch (err) {
        this.logger.warn('ipc: event send failed', {
          event,
          window: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Exposed for tests / diagnostics: the channels with schemas. */
  static channels(): readonly RequestChannel[] {
    return Object.keys(REQUEST_SCHEMAS) as RequestChannel[];
  }
}

function mapProviderCode(err: ProviderError): IpcError['code'] {
  switch (err.code) {
    case 'CANCELLED':
      return 'CANCELLED';
    case 'HOST_NOT_ALLOWED':
    case 'AUTH':
      return 'DENIED';
    case 'NETWORK':
    case 'TIMEOUT':
    case 'DNS':
    case 'HTTP_5XX':
    case 'RATE_LIMITED':
    case 'OFFLINE':
      return 'UNAVAILABLE';
    case 'UNSUPPORTED':
      return 'NOT_FOUND';
    default:
      return 'INTERNAL';
  }
}
