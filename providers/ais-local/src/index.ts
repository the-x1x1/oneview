import type { IsoTimestamp, Observation } from '@worldview/world-model';
import {
  ProviderError,
  buildObservation,
  numberSetting,
  stringSetting,
  type LineStreamHandle,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderStatus,
  type ProviderSubscription,
  type Unsubscribe,
  type WorldProvider,
} from '@worldview/provider-sdk';
import { AivdmAssembler } from './aivdm.js';
import { AIS_LOCAL_MANIFEST, DEFAULT_NMEA_PORT, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from './manifest.js';
import { StaticStore, messageToDraft } from './normalize.js';

export { AIS_LOCAL_MANIFEST, DEFAULT_NMEA_PORT } from './manifest.js';
export { AivdmAssembler, decodeMessage, nmeaChecksum, payloadBits } from './aivdm.js';
export type { AisMessage, SentenceResult, Dimensions } from './aivdm.js';
export { StaticStore, messageToDraft, mmsiString, timeFromSecond, shipTypeText, NAV_STATUS_TEXT } from './normalize.js';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h !== null && 'unref' in h) (h as { unref(): void }).unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface AisLocalOptions {
  /** Coalesce positions for this long before emitting (0 = emit per sentence). Default 1 s. */
  flushIntervalMs?: number;
  timers?: Timers;
}

export interface AisLocalSettings {
  host: string;
  port: number;
}

export function parseAisLocalSettings(raw: Record<string, unknown>): AisLocalSettings {
  return {
    host: stringSetting(raw, 'host', { host: true }) ?? '127.0.0.1',
    port: numberSetting(raw, 'port', 1, 65535) ?? DEFAULT_NMEA_PORT,
  };
}

export interface AisLocalStats {
  lines: number;
  messages: number;
  positions: number;
  invalid: number;
  ignored: number;
  reconnects: number;
}

interface Session {
  emit: ObservationEmitter;
  stream: LineStreamHandle | undefined;
  pending: Map<string, Observation>;
  flushTimer: unknown;
  retryTimer: unknown;
  retryMs: number;
  closed: boolean;
}

/**
 * Subscribes to the receiver's NMEA stream: one TCP connection, decoded sentence by sentence,
 * positions coalesced per ship for `flushIntervalMs` and emitted in batches. When the receiver
 * goes away the provider says so (OFFLINE "no AIS receiver at host:port") and reconnects —
 * 5 s, doubling to a minute — on its own; the first connection's failure is the runtime's to
 * retry. Nothing but the one host and port is contacted.
 */
export class AisLocalProvider implements WorldProvider {
  readonly manifest: ProviderManifest = AIS_LOCAL_MANIFEST;
  private context!: ProviderContext;
  private settings: AisLocalSettings = { host: '127.0.0.1', port: DEFAULT_NMEA_PORT };
  private readonly flushIntervalMs: number;
  private readonly timers: Timers;
  private readonly assembler = new AivdmAssembler();
  private readonly statics = new StaticStore();
  private session: Session | undefined;
  private running = false;
  private connected = false;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private readonly ships = new Set<string>();
  readonly stats: AisLocalStats = { lines: 0, messages: 0, positions: 0, invalid: 0, ignored: 0, reconnects: 0 };

  constructor(options: AisLocalOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.timers = options.timers ?? realTimers;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
    this.settings = parseAisLocalSettings(await context.settings.get());
    context.settings.onChange((raw) => {
      const next = parseAisLocalSettings(raw);
      if (next.host === this.settings.host && next.port === this.settings.port) return;
      this.settings = next;
      // A new address: drop the old connection and dial the new one now.
      const s = this.session;
      if (s && !s.closed) {
        s.stream?.close();
        s.stream = undefined;
        this.connected = false;
        this.scheduleReconnect(s, 0);
      }
    });
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.session) this.closeSession(this.session);
  }

  /** Where the provider connects: the named host, or loopback. */
  get target(): { host: string; port: number } {
    return { host: this.settings.host, port: this.settings.port };
  }

  async subscribe(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe> {
    if (this.session) this.closeSession(this.session);
    const session: Session = {
      emit,
      stream: undefined,
      pending: new Map(),
      flushTimer: undefined,
      retryTimer: undefined,
      retryMs: RECONNECT_MIN_MS,
      closed: false,
    };
    this.session = session;
    request.signal.addEventListener('abort', () => this.closeSession(session), { once: true });
    try {
      await this.connect(session);
    } catch (err) {
      this.closeSession(session);
      throw err;
    }
    return () => this.closeSession(session);
  }

  private async connect(session: Session): Promise<void> {
    const open = this.context.local.openLineStream?.bind(this.context.local);
    if (!open)
      throw this.fail(new ProviderError('UNSUPPORTED', 'this host cannot open TCP line streams', { retryable: false }));
    // Loopback, or the one host named — the runtime refuses anything else (ADR-003).
    const { host, port } = this.target;
    this.lastAttempt = this.nowIso();
    let stream: LineStreamHandle | undefined;
    // Only the session's current stream may report a drop: one closed on purpose (the address
    // changed) must not schedule a reconnect over the one already dialling.
    const current = () => stream !== undefined && session.stream === stream;
    try {
      stream = await open(
        { host, port },
        {
          onLine: (line) => this.onLine(session, line),
          onClose: () => {
            if (current())
              this.onDrop(
                session,
                new ProviderError('OFFLINE', `the AIS receiver at ${host}:${port} closed the connection`),
              );
          },
          onError: (error) => {
            if (current()) this.onDrop(session, error);
          },
        },
        { maxLineBytes: 1024, connectTimeoutMs: this.manifest.refreshPolicy.timeoutMs },
      );
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err.code === 'OFFLINE'
            ? new ProviderError('OFFLINE', `no AIS receiver at ${host}:${port}`, { retryAfterMs: RECONNECT_MIN_MS })
            : err
          : new ProviderError('NETWORK', err instanceof Error ? err.message : String(err));
      throw this.fail(pe);
    }
    if (session.closed) {
      stream.close();
      return;
    }
    session.stream = stream;
    session.retryMs = RECONNECT_MIN_MS;
    this.connected = true;
    this.lastError = undefined;
    this.lastSuccess = this.nowIso();
    this.context.logger.info('AIS receiver connected', { host, port });
    session.emit([], { snapshot: false });
  }

  private onLine(session: Session, line: string): void {
    if (session.closed) return;
    this.stats.lines++;
    const now = this.context.clock.now();
    const r = this.assembler.push(line, now);
    if (r.kind === 'invalid') {
      this.stats.invalid++;
      return;
    }
    if (r.kind === 'ignored') {
      this.stats.ignored++;
      return;
    }
    if (r.kind === 'fragment') return;
    this.stats.messages++;
    const out = messageToDraft(r.message, this.statics, {
      receivedMs: now,
      sourceRef: `tcp://${this.target.host}:${this.target.port}`,
    });
    if (out.kind !== 'position') return;
    this.stats.positions++;
    const observation = buildObservation(this.manifest, new Date(now).toISOString(), out.draft);
    this.ships.add(out.draft.externalId);
    if (this.ships.size > 50_000) this.ships.delete(this.ships.values().next().value!);
    session.pending.set(out.draft.externalId, observation);
    if (this.flushIntervalMs <= 0) this.flush(session);
    else if (session.flushTimer === undefined)
      session.flushTimer = this.timers.setTimeout(() => {
        session.flushTimer = undefined;
        this.flush(session);
      }, this.flushIntervalMs);
  }

  private flush(session: Session): void {
    if (session.closed || session.pending.size === 0) return;
    const batch = [...session.pending.values()];
    session.pending.clear();
    this.lastObservation = this.nowIso();
    this.lastSuccess = this.lastObservation;
    session.emit(batch, { snapshot: false });
  }

  private onDrop(session: Session, error: ProviderError): void {
    if (session.closed) return;
    session.stream = undefined;
    this.connected = false;
    this.fail(error);
    this.context.logger.warn('AIS receiver connection lost', { message: error.message });
    session.emit([], { snapshot: false }); // publish the OFFLINE health now
    this.scheduleReconnect(session, session.retryMs);
    session.retryMs = Math.min(RECONNECT_MAX_MS, session.retryMs * 2);
  }

  private scheduleReconnect(session: Session, ms: number): void {
    if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
    session.retryTimer = this.timers.setTimeout(() => {
      session.retryTimer = undefined;
      if (session.closed || !this.running) return;
      this.stats.reconnects++;
      this.connect(session).catch(() => {
        if (session.closed) return;
        session.emit([], { snapshot: false });
        this.scheduleReconnect(session, session.retryMs);
        session.retryMs = Math.min(RECONNECT_MAX_MS, session.retryMs * 2);
      });
    }, ms);
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.flushTimer !== undefined) this.timers.clearTimeout(session.flushTimer);
    if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
    session.stream?.close();
    session.stream = undefined;
    this.connected = false;
    if (this.session === session) this.session = undefined;
  }

  private fail(err: ProviderError): ProviderError {
    this.lastError = err;
    this.lastErrorAt = this.nowIso();
    return err;
  }

  private nowIso(): IsoTimestamp {
    return new Date(this.context.clock.now()).toISOString();
  }

  async health(): Promise<ProviderHealth> {
    let status: ProviderStatus;
    let message: string | undefined;
    if (!this.running) status = 'DISABLED';
    // Connected — or cleanly unsubscribed after a good connection, which the runtime only does
    // on its way to stopping the provider.
    else if (this.connected || (!this.session && !this.lastError && this.lastSuccess)) status = 'LIVE';
    else if (this.lastError) {
      status = this.lastError.code === 'OFFLINE' || this.lastError.code === 'TIMEOUT' ? 'OFFLINE' : 'ERROR';
      message = this.lastError.message;
    } else status = 'STARTING';
    const h: ProviderHealth = {
      providerId: this.manifest.id,
      status,
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
      objectCount: this.ships.size,
    };
    if (message) h.message = message;
    if (this.lastAttempt) h.lastAttempt = this.lastAttempt;
    if (this.lastSuccess) h.lastSuccess = this.lastSuccess;
    if (this.lastObservation) h.lastObservation = this.lastObservation;
    if (this.lastError && this.lastErrorAt) h.lastError = this.lastError.toInfo(this.lastErrorAt);
    return h;
  }
}

export function createProvider(options?: AisLocalOptions): AisLocalProvider {
  return new AisLocalProvider(options);
}
