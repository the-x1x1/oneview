import type { IsoTimestamp, Observation } from '@worldview/world-model';
import {
  ProviderError,
  buildObservation,
  numberSetting,
  stringSetting,
  type ByteStreamHandle,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderStatus,
  type ProviderSubscription,
  type Unsubscribe,
  type WorldProvider,
} from '@worldview/provider-sdk';
import { HEARTBEAT_MS, MESHTASTIC_LOCAL_MANIFEST, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from './manifest.js';
import { NodeStore } from './nodes.js';
import {
  DEFAULT_MESHTASTIC_PORT,
  FrameReader,
  ProtoError,
  heartbeatFrame,
  readFromRadio,
  wantConfigFrame,
} from './wire.js';

export { MESHTASTIC_LOCAL_MANIFEST } from './manifest.js';
export { NodeStore, precisionMetres, MAX_NODES } from './nodes.js';
export {
  DEFAULT_MESHTASTIC_PORT,
  FrameReader,
  ProtoReader,
  ProtoError,
  frame,
  heartbeatFrame,
  nodeId,
  readFromRadio,
  readMeshPacket,
  readNodeInfo,
  readPosition,
  readTelemetry,
  readUser,
  wantConfigFrame,
  START1,
  START2,
  PORT_NODEINFO,
  PORT_POSITION,
  PORT_TELEMETRY,
  PORT_TEXT_MESSAGE,
} from './wire.js';
export type { FromRadio, MeshNodeInfo, MeshPacket, MeshPosition, MeshTelemetry, MeshUser } from './wire.js';

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

export interface MeshtasticLocalOptions {
  /** Coalesce node updates for this long before emitting (0 = emit per frame). Default 1 s. */
  flushIntervalMs?: number;
  timers?: Timers;
}

export interface MeshtasticLocalSettings {
  host: string;
  port: number;
}

export function parseMeshtasticLocalSettings(raw: Record<string, unknown>): MeshtasticLocalSettings {
  return {
    host: stringSetting(raw, 'host', { host: true }) ?? '127.0.0.1',
    port: numberSetting(raw, 'port', 1, 65535) ?? DEFAULT_MESHTASTIC_PORT,
  };
}

export interface MeshtasticLocalStats {
  frames: number;
  invalid: number;
  packets: number;
  /** Packets whose application this provider does not read (text, routing, admin …) or could not decrypt. */
  ignored: number;
  reconnects: number;
}

interface Session {
  emit: ObservationEmitter;
  stream: ByteStreamHandle | undefined;
  reader: FrameReader;
  pending: Set<number>;
  flushTimer: unknown;
  retryTimer: unknown;
  heartbeatTimer: unknown;
  retryMs: number;
  closed: boolean;
}

/**
 * Subscribes to the node's client stream: one TCP connection; on connecting it asks for the
 * node list (`want_config_id`), then reads every frame — the list first, then what the node
 * hears — merging what each says about a node and emitting the nodes that changed, at most
 * once per `flushIntervalMs`. A heartbeat every five minutes keeps the connection open. When
 * the node goes away the provider says so (OFFLINE "no Meshtastic node at host:port") and
 * reconnects — 5 s, doubling to a minute — on its own. Nothing but the one host and port is
 * contacted, and nothing is sent but the two requests.
 */
export class MeshtasticLocalProvider implements WorldProvider {
  readonly manifest: ProviderManifest = MESHTASTIC_LOCAL_MANIFEST;
  private context!: ProviderContext;
  private settings: MeshtasticLocalSettings = { host: '127.0.0.1', port: DEFAULT_MESHTASTIC_PORT };
  private readonly flushIntervalMs: number;
  private readonly timers: Timers;
  readonly nodes = new NodeStore();
  private session: Session | undefined;
  private running = false;
  private connected = false;
  private configured = false;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private configNonce = 0;
  readonly stats: MeshtasticLocalStats = { frames: 0, invalid: 0, packets: 0, ignored: 0, reconnects: 0 };

  constructor(options: MeshtasticLocalOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.timers = options.timers ?? realTimers;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
    this.settings = parseMeshtasticLocalSettings(await context.settings.get());
    context.settings.onChange((raw) => {
      const next = parseMeshtasticLocalSettings(raw);
      if (next.host === this.settings.host && next.port === this.settings.port) return;
      this.settings = next;
      // A new address: drop the old connection and dial the new one now.
      const s = this.session;
      if (s && !s.closed) {
        s.stream?.close();
        s.stream = undefined;
        this.connected = false;
        this.stopHeartbeat(s);
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
      reader: new FrameReader(),
      pending: new Set(),
      flushTimer: undefined,
      retryTimer: undefined,
      heartbeatTimer: undefined,
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
    const open = this.context.local.openByteStream?.bind(this.context.local);
    if (!open)
      throw this.fail(new ProviderError('UNSUPPORTED', 'this host cannot open TCP byte streams', { retryable: false }));
    // Loopback, or the one host named — the runtime refuses anything else (ADR-003).
    const { host, port } = this.target;
    this.lastAttempt = this.nowIso();
    let stream: ByteStreamHandle | undefined;
    // Only the session's current stream may report a drop: one closed on purpose (the address
    // changed) must not schedule a reconnect over the one already dialling.
    const current = () => stream !== undefined && session.stream === stream;
    try {
      stream = await open(
        { host, port },
        {
          onData: (bytes) => {
            if (current()) this.onData(session, bytes);
          },
          onClose: () => {
            if (current())
              this.onDrop(
                session,
                new ProviderError('OFFLINE', `the Meshtastic node at ${host}:${port} closed the connection`),
              );
          },
          onError: (error) => {
            if (current()) this.onDrop(session, error);
          },
        },
        { connectTimeoutMs: this.manifest.refreshPolicy.timeoutMs },
      );
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err.code === 'OFFLINE'
            ? new ProviderError('OFFLINE', `no Meshtastic node at ${host}:${port}`, { retryAfterMs: RECONNECT_MIN_MS })
            : err
          : new ProviderError('NETWORK', err instanceof Error ? err.message : String(err));
      throw this.fail(pe);
    }
    if (session.closed) {
      stream.close();
      return;
    }
    session.stream = stream;
    session.reader = new FrameReader();
    session.retryMs = RECONNECT_MIN_MS;
    this.connected = true;
    this.configured = false;
    this.lastError = undefined;
    this.lastSuccess = this.nowIso();
    this.context.logger.info('Meshtastic node connected', { host, port });
    this.requestConfig(stream);
    this.scheduleHeartbeat(session);
    session.emit([], { snapshot: false });
  }

  /** Ask the node for its own number and node list; it streams what it hears afterwards. */
  private requestConfig(stream: ByteStreamHandle): void {
    this.configNonce = (this.context.clock.now() / 1000) >>> 0 || 1;
    if (!stream.write(wantConfigFrame(this.configNonce)))
      this.context.logger.warn('Meshtastic node: the request for its node list was not sent');
  }

  private scheduleHeartbeat(session: Session): void {
    this.stopHeartbeat(session);
    session.heartbeatTimer = this.timers.setTimeout(() => {
      session.heartbeatTimer = undefined;
      if (session.closed || !session.stream) return;
      session.stream.write(heartbeatFrame());
      this.scheduleHeartbeat(session);
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(session: Session): void {
    if (session.heartbeatTimer !== undefined) this.timers.clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = undefined;
  }

  private onData(session: Session, bytes: Uint8Array): void {
    if (session.closed) return;
    const nowSec = Math.floor(this.context.clock.now() / 1000);
    for (const payload of session.reader.push(bytes)) {
      this.stats.frames++;
      let message;
      try {
        message = readFromRadio(payload);
      } catch (err) {
        if (!(err instanceof ProtoError)) throw err;
        this.stats.invalid++;
        continue;
      }
      switch (message.kind) {
        case 'my-info':
          this.nodes.myNodeNum = message.myNodeNum || undefined;
          break;
        case 'node-info': {
          const num = this.nodes.nodeInfo(message.node);
          if (num !== undefined) session.pending.add(num);
          break;
        }
        case 'packet': {
          this.stats.packets++;
          const num = this.nodes.packet(message.packet, nowSec);
          if (num === undefined) this.stats.ignored++;
          else session.pending.add(num);
          break;
        }
        case 'config-complete':
          if (!this.configured)
            this.context.logger.info('Meshtastic node list received', {
              nodes: this.nodes.size,
              withPosition: this.nodes.placed,
            });
          this.configured = true;
          break;
        case 'rebooted':
          // A node that restarted has forgotten the request: ask again.
          if (session.stream) this.requestConfig(session.stream);
          break;
        default:
          break;
      }
    }
    if (session.pending.size === 0) return;
    if (this.flushIntervalMs <= 0) this.flush(session);
    else if (session.flushTimer === undefined)
      session.flushTimer = this.timers.setTimeout(() => {
        session.flushTimer = undefined;
        this.flush(session);
      }, this.flushIntervalMs);
  }

  private flush(session: Session): void {
    if (session.closed || session.pending.size === 0) return;
    const now = this.context.clock.now();
    const receivedAt = new Date(now).toISOString();
    const sourceRef = `tcp://${this.target.host}:${this.target.port}`;
    const batch: Observation[] = [];
    for (const num of session.pending) {
      const draft = this.nodes.draft(num, Math.floor(now / 1000), sourceRef);
      if (draft) batch.push(buildObservation(this.manifest, receivedAt, draft));
    }
    session.pending.clear();
    if (!batch.length) return;
    this.lastObservation = receivedAt as IsoTimestamp;
    this.lastSuccess = this.lastObservation;
    session.emit(batch, { snapshot: false });
  }

  private onDrop(session: Session, error: ProviderError): void {
    if (session.closed) return;
    session.stream = undefined;
    this.connected = false;
    this.stopHeartbeat(session);
    this.fail(error);
    this.context.logger.warn('Meshtastic node connection lost', { message: error.message });
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
    this.stopHeartbeat(session);
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
    return new Date(this.context.clock.now()).toISOString() as IsoTimestamp;
  }

  async health(): Promise<ProviderHealth> {
    let status: ProviderStatus;
    let message: string | undefined;
    if (!this.running) status = 'DISABLED';
    else if (this.connected || (!this.session && !this.lastError && this.lastSuccess)) {
      status = 'LIVE';
      const nodes = this.nodes.size;
      if (this.connected)
        message = this.configured
          ? `${nodes} node${nodes === 1 ? '' : 's'} on the mesh, ${this.nodes.placed} with a position`
          : 'waiting for the node list';
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
      objectCount: this.nodes.placed,
    };
    if (message) h.message = message;
    if (this.lastAttempt) h.lastAttempt = this.lastAttempt;
    if (this.lastSuccess) h.lastSuccess = this.lastSuccess;
    if (this.lastObservation) h.lastObservation = this.lastObservation;
    if (this.lastError && this.lastErrorAt) h.lastError = this.lastError.toInfo(this.lastErrorAt);
    return h;
  }
}

export function createProvider(options?: MeshtasticLocalOptions): MeshtasticLocalProvider {
  return new MeshtasticLocalProvider(options);
}
