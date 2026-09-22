import { boundsContain, type GeoBounds, type IsoTimestamp, type Observation } from '@worldview/world-model';
import {
  ProviderError,
  buildObservation,
  type CredentialState,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderSocketHandle,
  type ProviderSubscription,
  type ProviderStatus,
  type Unsubscribe,
  type WorldProvider,
} from '@worldview/provider-sdk';
import { AISSTREAM_MANIFEST, AISSTREAM_CREDENTIAL_KEY, AISSTREAM_URL } from './manifest.js';
import { decodeAisFrame, normalizeAisEnvelope } from './normalize.js';
import { buildSubscriptionFrame } from './subscription.js';
import { AisWatchdog, type FailureKind, type WatchdogAction, type WatchdogOptions } from './watchdog.js';

export { AISSTREAM_MANIFEST, AISSTREAM_CREDENTIAL_KEY, AISSTREAM_URL, AISSTREAM_MESSAGE_TYPES } from './manifest.js';
export { normalizeAisEnvelope, decodeAisFrame, normalizeMmsi, shipTypeText, NAV_STATUS_TEXT } from './normalize.js';
export type { AisFrameResult } from './normalize.js';
export { parseAisTimestamp } from './time.js';
export { buildSubscriptionFrame, boundingBoxesFor, WORLD_BOX } from './subscription.js';
export type { BoundingBox, SubscriptionFrame } from './subscription.js';
export { AisWatchdog, WATCHDOG_DEFAULTS } from './watchdog.js';
export type { WatchdogOptions, WatchdogAction, WatchdogSnapshot, WatchdogStatus, FailureKind } from './watchdog.js';

/**
 * Resolves the raw secret for a credential key.
 *
 * In production the runtime supplies the key through `sockets.open({ credential })` →
 * `onOpen(ctx.secret)` (ADR-003), so the provider holds it only for the handshake. This
 * resolver stays as a construction-time **test seam** for suites that drive a fixture
 * socket which does not implement credential resolution.
 */
export type SecretResolver = (key: string) => Promise<string | undefined>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AisStreamProviderOptions {
  secretResolver?: SecretResolver;
  /** Coalesce frames for this long before emitting a batch (0 = emit per frame). Default 500 ms. */
  flushIntervalMs?: number;
  watchdog?: Partial<WatchdogOptions>;
  /** Timer implementation (tests inject a manual one). */
  timers?: Timers;
  /** Cap on the websocket frame size accepted from the runtime. */
  maxMessageBytes?: number;
}

export interface AisStreamStats {
  frames: number;
  observations: number;
  malformed: number;
  outOfBounds: number;
  ignored: number;
  reconnects: number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h !== null && 'unref' in h) (h as { unref(): void }).unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Distinct MMSIs tracked for objectCount; oldest entries are dropped beyond this. */
const MAX_TRACKED_MMSI = 50_000;

interface Session {
  bounds: GeoBounds | undefined;
  emit: ObservationEmitter;
  /** Test-seam key (constructor `secretResolver`); undefined when the runtime supplies it per socket. */
  fallbackKey: string | undefined;
  /** Handshake secrets, one per generation, deleted the moment the subscription frame is sent. */
  secrets: Map<number, string>;
  watchdog: AisWatchdog;
  sockets: Map<number, ProviderSocketHandle>;
  /** Generations whose handshake completed (subscription frame is sent once both open and handle exist). */
  opened: Set<number>;
  subscribed: Set<number>;
  /** Sockets that delivered at least one valid frame (for the error-rate window). */
  delivered: Set<number>;
  pending: Map<string, Observation>;
  flushTimer: unknown;
  silenceTimer: unknown;
  retryTimer: unknown;
  closed: boolean;
}

/**
 * AISStream websocket provider. One socket per subscription, driven by a pure watchdog:
 * liveness by data (90 s silence → recycle), classified failures (transport ladder, sticky
 * auth, rate-limit honours retry-after), batches coalesced for `flushIntervalMs`.
 */
export class AisStreamProvider implements WorldProvider {
  readonly manifest: ProviderManifest = AISSTREAM_MANIFEST;
  private context!: ProviderContext;
  private readonly secretResolver: SecretResolver | undefined;
  private readonly flushIntervalMs: number;
  private readonly watchdogOptions: Partial<WatchdogOptions>;
  private readonly timers: Timers;
  private readonly maxMessageBytes: number;
  private running = false;
  private session: Session | undefined;
  private generationHighWater = 0;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private authRejected = false;
  private readonly window: boolean[] = [];
  private readonly seenMmsi = new Map<string, number>();
  private readonly counters: AisStreamStats = {
    frames: 0,
    observations: 0,
    malformed: 0,
    outOfBounds: 0,
    ignored: 0,
    reconnects: 0,
  };

  constructor(options: AisStreamProviderOptions = {}) {
    this.secretResolver = options.secretResolver;
    this.flushIntervalMs = options.flushIntervalMs ?? 500;
    this.watchdogOptions = options.watchdog ?? {};
    this.timers = options.timers ?? realTimers;
    this.maxMessageBytes = options.maxMessageBytes ?? 256 * 1024;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.teardown();
  }

  /** Frame/observation counters (diagnostics, tests). */
  get stats(): Readonly<AisStreamStats> {
    return this.counters;
  }

  /** Watchdog view of the current subscription (diagnostics, tests). */
  get watchdogStatus(): string | undefined {
    return this.session?.watchdog.currentStatus;
  }

  async subscribe(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe> {
    if (!(await this.context.credentials.has(AISSTREAM_CREDENTIAL_KEY)))
      throw this.fail(new ProviderError('AUTH', 'AISStream API key required (aisstream.apiKey)', { retryable: false }));
    // Production path: the runtime resolves the key per socket and hands it to onOpen.
    // Test seam: an injected resolver supplies it when the socket impl does not.
    let fallbackKey: string | undefined;
    if (this.secretResolver) {
      fallbackKey = await this.secretResolver(AISSTREAM_CREDENTIAL_KEY);
      if (!fallbackKey) throw this.fail(new ProviderError('AUTH', 'AISStream API key is empty', { retryable: false }));
    }
    this.teardown();
    const session: Session = {
      bounds: request.bounds,
      emit,
      fallbackKey,
      secrets: new Map(),
      watchdog: new AisWatchdog(this.watchdogOptions, this.generationHighWater),
      sockets: new Map(),
      opened: new Set(),
      subscribed: new Set(),
      delivered: new Set(),
      pending: new Map(),
      flushTimer: undefined,
      silenceTimer: undefined,
      retryTimer: undefined,
      closed: false,
    };
    this.session = session;
    this.authRejected = false;
    request.signal.addEventListener('abort', () => this.closeSession(session), { once: true });
    // The first connection is awaited so a terminal failure (host not allowed, offline,
    // unsupported) rejects subscribe() and the runtime's own backoff applies. Later
    // reconnects are internal to the watchdog.
    const first = session.watchdog.tick(this.context.clock.now()).find((a) => a.type === 'connect');
    if (!first) throw new ProviderError('INTERNAL', 'watchdog did not issue a connect');
    try {
      await this.openSocket(session, first.generation);
    } catch (err) {
      this.closeSession(session);
      throw this.fail(
        err instanceof ProviderError
          ? err
          : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err }),
      );
    }
    return () => this.closeSession(session);
  }

  /**
   * The runtime may call this when the stored credential changes: a refused key stops being
   * sticky and the watchdog reconnects immediately (ProviderContext has no credential events).
   */
  notifyCredentialChange(): void {
    this.authRejected = false;
    if (this.lastError?.code === 'AUTH') this.lastError = undefined;
    const session = this.session;
    if (!session || session.closed) return;
    this.execute(session, session.watchdog.onCredentialChange(this.context.clock.now()));
    this.execute(session, session.watchdog.tick(this.context.clock.now()));
  }

  // ---- socket lifecycle ----------------------------------------------------

  private async openSocket(session: Session, generation: number): Promise<void> {
    if (session.closed) return;
    this.generationHighWater = Math.max(this.generationHighWater, generation);
    if (this.lastAttempt) this.counters.reconnects++;
    this.lastAttempt = this.nowIso();
    const events = {
      onOpen: (ctx: { secret?: string }) => this.onOpen(session, generation, ctx),
      onMessage: (data: string | Uint8Array) => this.onFrame(session, generation, data),
      onClose: (code: number, reason: string) => this.onClose(session, generation, code, reason),
      onError: (error: Error) => this.onError(session, generation, error),
    };
    const handle = await this.context.sockets.open(AISSTREAM_URL, events, {
      maxMessageBytes: this.maxMessageBytes,
      credential: { key: AISSTREAM_CREDENTIAL_KEY },
    });
    if (session.closed || !session.watchdog.ownsGeneration(generation)) {
      try {
        handle.close(1000, 'orphan');
      } catch {
        /* ignore */
      }
      return;
    }
    session.sockets.set(generation, handle);
    this.sendSubscription(session, generation);
    this.armSilenceTimer(session);
  }

  private onOpen(session: Session, generation: number, ctx?: { secret?: string }): void {
    if (session.closed) return;
    if (ctx?.secret) session.secrets.set(generation, ctx.secret);
    this.execute(session, session.watchdog.onOpen(generation));
    if (!session.watchdog.ownsGeneration(generation)) {
      session.secrets.delete(generation);
      return;
    }
    session.opened.add(generation);
    this.sendSubscription(session, generation);
  }

  /**
   * Send the subscription frame once, when both the handshake and the handle are in place.
   * The key comes from the handshake context (runtime) or the injected test seam, and the
   * handshake copy is dropped immediately afterwards.
   */
  private sendSubscription(session: Session, generation: number): void {
    const handle = session.sockets.get(generation);
    if (!handle || !session.opened.has(generation) || session.subscribed.has(generation)) return;
    const apiKey = session.secrets.get(generation) ?? session.fallbackKey;
    if (!apiKey) {
      session.secrets.delete(generation);
      this.recordFailure(
        session,
        generation,
        new ProviderError('AUTH', 'AISStream API key was not supplied to the socket handshake', { retryable: false }),
      );
      try {
        handle.close(1000, 'no credential');
      } catch {
        /* ignore */
      }
      return;
    }
    session.subscribed.add(generation);
    handle.send(buildSubscriptionFrame(apiKey, session.bounds));
    session.secrets.delete(generation);
    this.context.logger.debug('AISStream subscribed', { generation, bounded: session.bounds !== undefined });
  }

  private onFrame(session: Session, generation: number, data: string | Uint8Array): void {
    if (session.closed || !session.watchdog.ownsGeneration(generation)) return;
    this.counters.frames++;
    const decoded = decodeAisFrame(data);
    if (decoded === undefined) {
      this.counters.malformed++;
      this.context.logger.debug('AISStream frame is not JSON');
      return;
    }
    const now = this.context.clock.now();
    const receivedAt = new Date(now).toISOString();
    const result = normalizeAisEnvelope(decoded, { receivedAt });
    switch (result.kind) {
      case 'malformed':
        this.counters.malformed++;
        this.context.logger.debug('AISStream frame rejected', { reason: result.reason });
        return;
      case 'error': {
        const kind: FailureKind = result.auth
          ? 'auth'
          : /rate|too many/i.test(result.message)
            ? 'rate-limit'
            : 'transport';
        this.context.logger.warn('AISStream error envelope', { kind, message: result.message });
        this.lastError = new ProviderError(
          kind === 'auth' ? 'AUTH' : kind === 'rate-limit' ? 'RATE_LIMITED' : 'NETWORK',
          `AISStream: ${result.message}`,
          { retryable: kind !== 'auth' },
        );
        this.lastErrorAt = receivedAt;
        if (kind === 'auth') this.authRejected = true;
        this.execute(session, session.watchdog.onFailure(generation, now, { kind, message: result.message }));
        this.scheduleRetry(session);
        return;
      }
      case 'ignored':
        this.counters.ignored++;
        break;
      case 'observation': {
        if (result.draft.position && session.bounds && !boundsContain(session.bounds, result.draft.position)) {
          this.counters.outOfBounds++;
          break;
        }
        const obs = buildObservation(this.manifest, receivedAt, result.draft);
        session.pending.set(obs.id, obs);
        this.counters.observations++;
        break;
      }
    }
    // Any decoded AIS envelope proves the feed is alive (even when filtered out).
    session.delivered.add(generation);
    this.lastSuccess = receivedAt;
    this.lastError = undefined;
    this.authRejected = false;
    this.execute(session, session.watchdog.onMessage(generation, now));
    this.armSilenceTimer(session);
    if (session.pending.size) {
      if (this.flushIntervalMs <= 0) this.flush(session);
      else if (session.flushTimer === undefined)
        session.flushTimer = this.timers.setTimeout(() => this.flush(session), this.flushIntervalMs);
    }
  }

  private onClose(session: Session, generation: number, code: number, reason: string): void {
    if (session.closed) return;
    const owned = session.watchdog.ownsGeneration(generation);
    this.forgetSocket(session, generation);
    if (!owned) return;
    this.context.logger.warn('AISStream socket closed', { generation, code, reason });
    if (!this.lastError) {
      this.lastError = new ProviderError('NETWORK', `AISStream socket closed (${code}${reason ? ` ${reason}` : ''})`);
      this.lastErrorAt = this.nowIso();
    }
    this.execute(session, session.watchdog.onClose(generation, this.context.clock.now(), reason));
    this.scheduleRetry(session);
  }

  private onError(session: Session, generation: number, error: Error): void {
    if (session.closed || !session.watchdog.ownsGeneration(generation)) return;
    this.recordFailure(
      session,
      generation,
      error instanceof ProviderError ? error : new ProviderError('NETWORK', error.message, { cause: error }),
    );
  }

  private recordFailure(session: Session, generation: number, pe: ProviderError): void {
    this.lastError = pe;
    this.lastErrorAt = this.nowIso();
    const kind: FailureKind = pe.code === 'AUTH' ? 'auth' : pe.code === 'RATE_LIMITED' ? 'rate-limit' : 'transport';
    if (kind === 'auth') this.authRejected = true;
    this.execute(
      session,
      session.watchdog.onFailure(generation, this.context.clock.now(), {
        kind,
        message: pe.message,
        ...(pe.retryAfterMs !== undefined ? { retryAfterMs: pe.retryAfterMs } : {}),
      }),
    );
    this.scheduleRetry(session);
  }

  /** Run watchdog actions: terminate owned/orphan sockets, open new generations. */
  private execute(session: Session, actions: WatchdogAction[]): void {
    for (const action of actions) {
      if (action.type === 'terminate') {
        const handle = session.sockets.get(action.generation);
        this.forgetSocket(session, action.generation);
        try {
          handle?.close(1000, action.reason);
        } catch {
          /* ignore */
        }
      } else {
        void this.openSocket(session, action.generation).catch((err: unknown) => {
          if (session.closed) return;
          this.recordFailure(
            session,
            action.generation,
            err instanceof ProviderError
              ? err
              : new ProviderError('NETWORK', err instanceof Error ? err.message : String(err), { cause: err }),
          );
        });
      }
    }
  }

  private forgetSocket(session: Session, generation: number): void {
    session.opened.delete(generation);
    session.subscribed.delete(generation);
    session.secrets.delete(generation);
    if (!session.sockets.has(generation)) return;
    session.sockets.delete(generation);
    this.record(session.delivered.has(generation));
    session.delivered.delete(generation);
    if (session.sockets.size === 0 && session.silenceTimer !== undefined) {
      this.timers.clearTimeout(session.silenceTimer);
      session.silenceTimer = undefined;
    }
  }

  private armSilenceTimer(session: Session): void {
    if (session.silenceTimer !== undefined) this.timers.clearTimeout(session.silenceTimer);
    session.silenceTimer = this.timers.setTimeout(() => {
      session.silenceTimer = undefined;
      if (session.closed) return;
      this.execute(session, session.watchdog.tick(this.context.clock.now()));
      this.scheduleRetry(session);
    }, session.watchdog.silenceMs + 1);
  }

  /** Schedule the next connect at the watchdog's `nextAttemptAt`. */
  private scheduleRetry(session: Session): void {
    if (session.closed) return;
    const now = this.context.clock.now();
    const snap = session.watchdog.snapshot(now);
    if (snap.nextAttemptAt === undefined) return;
    if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
    session.retryTimer = this.timers.setTimeout(
      () => {
        session.retryTimer = undefined;
        if (session.closed) return;
        this.execute(session, session.watchdog.tick(this.context.clock.now()));
      },
      Math.max(0, snap.nextAttemptAt - now),
    );
  }

  private flush(session: Session): void {
    if (session.flushTimer !== undefined) {
      this.timers.clearTimeout(session.flushTimer);
      session.flushTimer = undefined;
    }
    if (session.closed || session.pending.size === 0) return;
    const batch = [...session.pending.values()];
    session.pending.clear();
    for (const o of batch) {
      const t = Date.parse(o.observedAt);
      this.seenMmsi.set(o.externalId ?? o.id, t);
      if (!this.lastObservation || t > Date.parse(this.lastObservation)) this.lastObservation = o.observedAt;
    }
    if (this.seenMmsi.size > MAX_TRACKED_MMSI) {
      const surplus = [...this.seenMmsi.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, this.seenMmsi.size - MAX_TRACKED_MMSI);
      for (const [k] of surplus) this.seenMmsi.delete(k);
    }
    session.emit(batch, { snapshot: false, subSource: 'aisstream' });
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    this.flush(session);
    session.closed = true;
    for (const t of [session.flushTimer, session.silenceTimer, session.retryTimer])
      if (t !== undefined) this.timers.clearTimeout(t);
    this.execute(session, session.watchdog.reset());
    for (const [generation, handle] of [...session.sockets]) {
      this.forgetSocket(session, generation);
      try {
        handle.close(1000, 'unsubscribed');
      } catch {
        /* ignore */
      }
    }
    if (this.session === session) this.session = undefined;
  }

  private teardown(): void {
    if (this.session) this.closeSession(this.session);
  }

  // ---- health --------------------------------------------------------------

  async health(): Promise<ProviderHealth> {
    const credentialState = await this.credentialState();
    const errorRate = this.window.length ? this.window.filter((x) => !x).length / this.window.length : 0;
    const now = this.context ? this.context.clock.now() : 0;
    const snap = this.session?.watchdog.snapshot(now);
    const status = this.deriveStatus(credentialState, snap?.status, now);
    const health: ProviderHealth = {
      providerId: this.manifest.id,
      status,
      errorRate,
      rateLimitState: {
        limited: status === 'RATE_LIMITED',
        ...(this.lastError?.code === 'RATE_LIMITED' && this.lastError.retryAfterMs !== undefined && this.lastErrorAt
          ? { resetAt: new Date(Date.parse(this.lastErrorAt) + this.lastError.retryAfterMs).toISOString() }
          : {}),
      },
      credentialState,
      objectCount: this.seenMmsi.size,
    };
    if (this.lastAttempt) health.lastAttempt = this.lastAttempt;
    if (this.lastSuccess) health.lastSuccess = this.lastSuccess;
    if (this.lastObservation) health.lastObservation = this.lastObservation;
    if (this.lastError && this.lastErrorAt) {
      health.lastError = this.lastError.toInfo(this.lastErrorAt);
      health.message = health.lastError.message;
    } else if (credentialState === 'missing') health.message = 'AISStream API key required (aisstream.apiKey)';
    else if (snap?.error) health.message = snap.error;
    else if (status === 'STALE' && this.lastSuccess) health.message = `no AIS data since ${this.lastSuccess}`;
    return health;
  }

  private async credentialState(): Promise<CredentialState> {
    if (!this.context) return 'missing';
    if (!(await this.context.credentials.has(AISSTREAM_CREDENTIAL_KEY))) return 'missing';
    return this.authRejected ? 'invalid' : 'present';
  }

  private deriveStatus(credentialState: CredentialState, watchdog: string | undefined, now: number): ProviderStatus {
    if (!this.running) return 'DISABLED';
    if (credentialState === 'missing' || credentialState === 'invalid' || this.lastError?.code === 'AUTH')
      return 'AUTH_REQUIRED';
    if (this.lastError?.code === 'RATE_LIMITED') return 'RATE_LIMITED';
    const connectivityCode =
      this.lastError?.code === 'OFFLINE' || this.lastError?.code === 'NETWORK' || this.lastError?.code === 'DNS';
    switch (watchdog) {
      case 'live':
        return 'LIVE';
      case 'connecting':
        return this.lastSuccess ? 'DEGRADED' : 'STARTING';
      case 'reconnecting':
      case 'down':
        return this.lastSuccess ? 'DEGRADED' : connectivityCode ? 'OFFLINE' : 'ERROR';
      case 'auth-failed':
        return 'AUTH_REQUIRED';
      default: {
        // No session (before subscribe, or after unsubscribe): judge by the last data seen.
        if (!this.lastAttempt) return 'STARTING';
        if (this.lastError) return this.lastSuccess ? 'DEGRADED' : connectivityCode ? 'OFFLINE' : 'ERROR';
        if (!this.lastSuccess) return 'STARTING';
        const silenceMs = this.session?.watchdog.silenceMs ?? this.watchdogOptions.silenceMs ?? 90_000;
        return now - Date.parse(this.lastSuccess) <= silenceMs ? 'LIVE' : 'STALE';
      }
    }
  }

  private fail(err: ProviderError): ProviderError {
    this.lastError = err;
    this.lastErrorAt = this.nowIso();
    this.record(false);
    return err;
  }

  private record(success: boolean): void {
    this.window.push(success);
    if (this.window.length > 20) this.window.shift();
  }

  private nowIso(): IsoTimestamp {
    return new Date(this.context.clock.now()).toISOString();
  }
}

export function createProvider(options: AisStreamProviderOptions = {}): AisStreamProvider {
  return new AisStreamProvider(options);
}
