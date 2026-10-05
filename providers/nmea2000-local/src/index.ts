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
import { FLUSH_INTERVAL_MS, NMEA2000_LOCAL_MANIFEST, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from './manifest.js';
import { decodePgn, READ_PGNS } from './pgns.js';
import { aisDraft, mmsiString, OwnVessel, StaticStore, staticInfo } from './vessels.js';
import { DEFAULT_YD_RAW_PORT, FAST_PACKET_PGNS, FastPacketAssembler, parseYdRawLine } from './wire.js';

export { NMEA2000_LOCAL_MANIFEST } from './manifest.js';
export { decodePgn, READ_PGNS } from './pgns.js';
export type { N2kMessage } from './pgns.js';
export { aisDraft, OwnVessel, StaticStore, staticInfo } from './vessels.js';
export {
  canIdParts,
  DEFAULT_YD_RAW_PORT,
  FAST_PACKET_PGNS,
  FastPacketAssembler,
  FieldReader,
  parseYdRawLine,
} from './wire.js';

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

export interface Nmea2000LocalSettings {
  host: string;
  port: number;
  mmsi?: string;
  name: string;
}

export function parseNmea2000LocalSettings(raw: Record<string, unknown>): Nmea2000LocalSettings {
  const mmsiText = stringSetting(raw, 'mmsi');
  const mmsi = mmsiText && /^\d{9}$/.test(mmsiText) ? mmsiString(Number(mmsiText)) : undefined;
  return {
    host: stringSetting(raw, 'host', { host: true }) ?? '127.0.0.1',
    port: numberSetting(raw, 'port', 1, 65535) ?? DEFAULT_YD_RAW_PORT,
    ...(mmsi ? { mmsi } : {}),
    name: (stringSetting(raw, 'name') ?? 'Own vessel').slice(0, 64),
  };
}

export interface Nmea2000LocalOptions {
  /** Coalesce for this long before emitting (0 = emit per message). Default 1 s. */
  flushIntervalMs?: number;
  timers?: Timers;
}

export interface Nmea2000LocalStats {
  lines: number;
  frames: number;
  messages: number;
  invalid: number;
  ignored: number;
  reconnects: number;
}

interface Session {
  emit: ObservationEmitter;
  stream: LineStreamHandle | undefined;
  pending: Map<string, Observation>;
  ownChanged: boolean;
  flushTimer: unknown;
  retryTimer: unknown;
  retryMs: number;
  closed: boolean;
}

/** The boat's own object id when no MMSI is set. */
export const OWN_VESSEL_ID = 'own-vessel';

/**
 * Subscribes to the gateway's RAW stream: one TCP connection, read line by line — frames
 * decoded, fast packets put back together — the boat and the ships it hears coalesced for a
 * second and emitted in batches. When the gateway goes away the provider says so (OFFLINE "no
 * NMEA 2000 gateway at host:port") and reconnects — 5 s, doubling to a minute — on its own.
 * Nothing but the one host and port is contacted, and nothing is written to it.
 */
export class Nmea2000LocalProvider implements WorldProvider {
  readonly manifest: ProviderManifest = NMEA2000_LOCAL_MANIFEST;
  private context!: ProviderContext;
  private settings: Nmea2000LocalSettings = { host: '127.0.0.1', port: DEFAULT_YD_RAW_PORT, name: 'Own vessel' };
  private readonly flushIntervalMs: number;
  private readonly timers: Timers;
  private readonly fast = new FastPacketAssembler();
  private readonly statics = new StaticStore();
  private readonly own = new OwnVessel();
  private session: Session | undefined;
  private running = false;
  private connected = false;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private readonly ships = new Set<string>();
  readonly stats: Nmea2000LocalStats = { lines: 0, frames: 0, messages: 0, invalid: 0, ignored: 0, reconnects: 0 };

  constructor(options: Nmea2000LocalOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.timers = options.timers ?? realTimers;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
    this.settings = parseNmea2000LocalSettings(await context.settings.get());
    context.settings.onChange((raw) => {
      const next = parseNmea2000LocalSettings(raw);
      const moved = next.host !== this.settings.host || next.port !== this.settings.port;
      this.settings = next;
      if (!moved) return;
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
      ownChanged: false,
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
                new ProviderError('OFFLINE', `the NMEA 2000 gateway at ${host}:${port} closed the connection`),
              );
          },
          onError: (error) => {
            if (current()) this.onDrop(session, error);
          },
        },
        { maxLineBytes: 256, connectTimeoutMs: this.manifest.refreshPolicy.timeoutMs },
      );
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err.code === 'OFFLINE'
            ? new ProviderError('OFFLINE', `no NMEA 2000 gateway at ${host}:${port}`, {
                retryAfterMs: RECONNECT_MIN_MS,
              })
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
    this.context.logger.info('NMEA 2000 gateway connected', { host, port });
    session.emit([], { snapshot: false });
  }

  private onLine(session: Session, line: string): void {
    if (session.closed) return;
    this.stats.lines++;
    const frame = parseYdRawLine(line);
    if (!frame) {
      this.stats.invalid++;
      return;
    }
    this.stats.frames++;
    if (!READ_PGNS.has(frame.pgn)) {
      this.stats.ignored++;
      return;
    }
    const now = this.context.clock.now();
    const bytes = FAST_PACKET_PGNS.has(frame.pgn) ? this.fast.push(frame, now) : frame.data;
    if (!bytes) return;
    const message = decodePgn(frame.pgn, bytes);
    if (!message) {
      this.stats.ignored++;
      return;
    }
    this.stats.messages++;
    const sourceRef = `tcp://${this.target.host}:${this.target.port}`;
    if (message.kind === 'ais-static') {
      const mmsi = mmsiString(message.mmsi);
      if (mmsi) this.statics.merge(mmsi, staticInfo(message));
      return;
    }
    if (message.kind === 'ais-position') {
      const draft = aisDraft(message, this.statics, { receivedMs: now, sourceRef });
      // The boat's own transponder: it is the boat, already drawn from its own instruments.
      if (!draft || (this.settings.mmsi !== undefined && draft.externalId === this.settings.mmsi)) return;
      this.ships.add(draft.externalId);
      if (this.ships.size > 50_000) this.ships.delete(this.ships.values().next().value!);
      session.pending.set(draft.externalId, buildObservation(this.manifest, new Date(now).toISOString(), draft));
    } else if (this.own.update(message, frame.source, now)) {
      session.ownChanged = true;
    } else {
      return;
    }
    this.scheduleFlush(session);
  }

  private scheduleFlush(session: Session): void {
    if (this.flushIntervalMs <= 0) this.flush(session);
    else if (session.flushTimer === undefined)
      session.flushTimer = this.timers.setTimeout(() => {
        session.flushTimer = undefined;
        this.flush(session);
      }, this.flushIntervalMs);
  }

  private flush(session: Session): void {
    if (session.closed) return;
    const now = this.context.clock.now();
    if (session.ownChanged) {
      session.ownChanged = false;
      const draft = this.own.draft(now, {
        externalId: this.settings.mmsi ?? OWN_VESSEL_ID,
        name: this.settings.name,
        ...(this.settings.mmsi ? { mmsi: this.settings.mmsi } : {}),
        sourceRef: `tcp://${this.target.host}:${this.target.port}`,
      });
      if (draft)
        session.pending.set(draft.externalId, buildObservation(this.manifest, new Date(now).toISOString(), draft));
    }
    if (session.pending.size === 0) return;
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
    this.context.logger.warn('NMEA 2000 gateway connection lost', { message: error.message });
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
    else if (this.connected || (!this.session && !this.lastError && this.lastSuccess)) {
      status = 'LIVE';
      if (this.connected)
        message = `${this.ships.size} ship${this.ships.size === 1 ? '' : 's'} heard by the boat's AIS`;
    } else if (this.lastError) {
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

export function createProvider(options?: Nmea2000LocalOptions): Nmea2000LocalProvider {
  return new Nmea2000LocalProvider(options);
}
