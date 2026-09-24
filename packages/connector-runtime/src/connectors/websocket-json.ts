import type { IsoTimestamp, JsonValue, Observation } from '@worldview/world-model';
import {
  ProviderError,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderSocketHandle,
  type CredentialState,
  type ProviderStatus,
  type ProviderSubscription,
  type Unsubscribe,
  type WorldProvider,
} from '@worldview/provider-sdk';
import {
  compileMapping,
  definitionToManifest,
  extractRecords,
  mapRecords,
  readPath,
  type CompiledMapping,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';

/**
 * WebSocket JSON: a live feed of JSON messages over `ProviderContext.sockets` (the host
 * enforces the allowlist, message size and the credential). On open the definition's
 * `subscribe` frame is sent — with `{secret}` in any string replaced by the credential the
 * host hands to `onOpen`, which the provider never keeps — then each message's records
 * (`websocket.itemsPath`, filtered by `websocket.filter`) go through the mapping and are
 * emitted in batches every `flushIntervalMs`. A heartbeat frame is sent on its interval;
 * a dropped socket is reopened with a backoff from 2 s to a minute.
 */
export const WEBSOCKET_JSON_CONNECTOR_ID = 'websocket-json';
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

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

export interface WebSocketJsonOptions {
  flushIntervalMs?: number;
  timers?: Timers;
}

interface Session {
  emit: ObservationEmitter;
  handle: ProviderSocketHandle | undefined;
  pending: Map<string, Observation>;
  flushTimer: unknown;
  retryTimer: unknown;
  heartbeatTimer: unknown;
  retryMs: number;
  closed: boolean;
  generation: number;
}

export function withSecret(frame: JsonValue, secret: string | undefined): JsonValue {
  if (typeof frame === 'string') return secret !== undefined ? frame.split('{secret}').join(secret) : frame;
  if (Array.isArray(frame)) return frame.map((f) => withSecret(f, secret));
  if (frame && typeof frame === 'object')
    return Object.fromEntries(Object.entries(frame).map(([k, v]) => [k, withSecret(v, secret)]));
  return frame;
}

export class WebSocketJsonProvider implements WorldProvider {
  readonly manifest: ProviderManifest;
  private context!: ProviderContext;
  private readonly mapping: CompiledMapping;
  private readonly flushIntervalMs: number;
  private readonly timers: Timers;
  private session: Session | undefined;
  private running = false;
  private connected = false;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private readonly ids = new Set<string>();
  readonly stats = { messages: 0, records: 0, observations: 0, rejected: 0, filtered: 0, malformed: 0, reconnects: 0 };

  constructor(
    readonly definition: ConnectorProviderDefinition,
    options: WebSocketJsonOptions = {},
  ) {
    if (!definition.websocket) throw new Error(`${definition.id}: the WebSocket JSON connector needs a websocket`);
    this.manifest = definitionToManifest(definition, 'WebSocket JSON');
    this.mapping = compileMapping(definition.mapping);
    this.flushIntervalMs = options.flushIntervalMs ?? definition.websocket.flushMs ?? 500;
    this.timers = options.timers ?? realTimers;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
  }
  async start(): Promise<void> {
    this.running = true;
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.session) this.closeSession(this.session);
  }

  async subscribe(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe> {
    if (this.session) this.closeSession(this.session);
    const session: Session = {
      emit,
      handle: undefined,
      pending: new Map(),
      flushTimer: undefined,
      retryTimer: undefined,
      heartbeatTimer: undefined,
      retryMs: RECONNECT_MIN_MS,
      closed: false,
      generation: 0,
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
    const ws = this.definition.websocket!;
    const generation = ++session.generation;
    this.lastAttempt = this.nowIso();
    const credentialKey = ws.credential ? this.definition.credentials?.[ws.credential.name]?.secretRef : undefined;
    const current = () => session.generation === generation && !session.closed;
    let handle: ProviderSocketHandle;
    try {
      handle = await this.context.sockets.open(
        ws.url,
        {
          onOpen: (ctx) => {
            if (!current()) return;
            this.connected = true;
            this.lastError = undefined;
            this.lastSuccess = this.nowIso();
            session.retryMs = RECONNECT_MIN_MS;
            if (ws.subscribe !== undefined) session.handle?.send(JSON.stringify(withSecret(ws.subscribe, ctx?.secret)));
            this.startHeartbeat(session);
            session.emit([], { snapshot: false });
          },
          onMessage: (data) => {
            if (current()) this.onMessage(session, data);
          },
          onClose: (code, reason) => {
            if (current())
              this.onDrop(
                session,
                new ProviderError('OFFLINE', `the socket closed (${code}${reason ? ` ${reason}` : ''})`),
              );
          },
          onError: (error) => {
            if (current()) this.onDrop(session, new ProviderError('NETWORK', error.message));
          },
        },
        {
          maxMessageBytes: ws.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
          ...(credentialKey ? { credential: { key: credentialKey } } : {}),
        },
      );
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('NETWORK', err instanceof Error ? err.message : String(err));
      throw this.fail(pe);
    }
    if (session.closed || session.generation !== generation) {
      handle.close();
      return;
    }
    session.handle = handle;
  }

  private onMessage(session: Session, data: string | Uint8Array): void {
    this.stats.messages++;
    const ws = this.definition.websocket!;
    let body: unknown;
    try {
      body = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      this.stats.malformed++;
      return;
    }
    for (const c of ws.filter ?? []) {
      const v = readPath(body, c.path);
      if (c.equals !== undefined && v !== c.equals) return;
      if (c.exists !== undefined && (v !== undefined) !== c.exists) return;
      if (c.in !== undefined && !c.in.some((x) => x === v)) return;
    }
    const found = extractRecords(body, ws.itemsPath ? { itemsPath: ws.itemsPath } : undefined);
    if ('malformed' in found) {
      this.stats.malformed++;
      return;
    }
    const receivedAt = this.nowIso();
    const mapped = mapRecords(found.records, {
      manifest: this.manifest,
      definition: this.definition,
      mapping: this.mapping,
      receivedAt,
      origin: 'live',
      sourceRef: ws.url,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    this.stats.records += mapped.total;
    this.stats.rejected += mapped.rejected.length;
    this.stats.filtered += mapped.filtered;
    for (const o of mapped.observations) {
      const key = o.externalId ?? o.id;
      this.ids.add(key);
      if (this.ids.size > 100_000) this.ids.delete(this.ids.values().next().value!);
      session.pending.set(key, o);
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
    const batch = [...session.pending.values()];
    session.pending.clear();
    this.stats.observations += batch.length;
    this.lastObservation = this.nowIso();
    this.lastSuccess = this.lastObservation;
    session.emit(batch, { snapshot: false });
  }

  private startHeartbeat(session: Session): void {
    const ws = this.definition.websocket!;
    if (ws.heartbeat === undefined || !ws.heartbeatSeconds) return;
    const tick = () => {
      if (session.closed || !session.handle) return;
      session.handle.send(JSON.stringify(ws.heartbeat));
      session.heartbeatTimer = this.timers.setTimeout(tick, ws.heartbeatSeconds! * 1000);
    };
    session.heartbeatTimer = this.timers.setTimeout(tick, ws.heartbeatSeconds * 1000);
  }

  private onDrop(session: Session, error: ProviderError): void {
    if (session.closed) return;
    session.handle = undefined;
    this.connected = false;
    if (session.heartbeatTimer !== undefined) this.timers.clearTimeout(session.heartbeatTimer);
    this.fail(error);
    this.context.logger.warn('connector socket lost', { message: error.message });
    session.emit([], { snapshot: false });
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
    for (const t of [session.flushTimer, session.retryTimer, session.heartbeatTimer])
      if (t !== undefined) this.timers.clearTimeout(t);
    session.handle?.close();
    session.handle = undefined;
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
    const ws = this.definition.websocket;
    const credentialKey = ws?.credential ? this.definition.credentials?.[ws.credential.name]?.secretRef : undefined;
    const credentialState: CredentialState = !credentialKey
      ? 'not-required'
      : this.context && (await this.context.credentials.has(credentialKey))
        ? 'present'
        : 'missing';
    if (!this.running) status = 'DISABLED';
    else if (credentialState === 'missing') {
      status = 'AUTH_REQUIRED';
      message = `credential ${credentialKey} not configured`;
    } else if (this.connected || (!this.session && !this.lastError && this.lastSuccess)) status = 'LIVE';
    else if (this.lastError) {
      status =
        this.lastError.code === 'AUTH'
          ? 'AUTH_REQUIRED'
          : this.lastError.code === 'OFFLINE' || this.lastError.code === 'TIMEOUT'
            ? 'OFFLINE'
            : 'ERROR';
      message = this.lastError.message;
    } else status = 'STARTING';
    const h: ProviderHealth = {
      providerId: this.manifest.id,
      status,
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState,
      objectCount: this.ids.size,
    };
    if (message) h.message = message;
    else if (this.stats.rejected) h.message = `${this.stats.rejected} record(s) rejected by the mapping so far`;
    if (this.lastAttempt) h.lastAttempt = this.lastAttempt;
    if (this.lastSuccess) h.lastSuccess = this.lastSuccess;
    if (this.lastObservation) h.lastObservation = this.lastObservation;
    if (this.lastError && this.lastErrorAt) h.lastError = this.lastError.toInfo(this.lastErrorAt);
    return h;
  }
}

export function validateWebSocketJson(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!d.websocket) errors.push('websocket is required');
  if (d.endpoint) warnings.push('endpoint is ignored by this connector');
  if (d.pagination) warnings.push('pagination is ignored by this connector');
  if (d.websocket?.heartbeat !== undefined && !d.websocket.heartbeatSeconds)
    errors.push('websocket.heartbeat needs heartbeatSeconds');
  if (d.websocket && JSON.stringify(d.websocket.subscribe ?? null).includes('{secret}') && !d.websocket.credential)
    errors.push('websocket.subscribe uses {secret} but websocket.credential names no credential');
  if (!d.mapping.observedAt) warnings.push('mapping.observedAt is unset: every observation carries the arrival time');
  return { ok: errors.length === 0, errors, warnings };
}

export const webSocketJsonConnector: Connector = {
  metadata: {
    id: WEBSOCKET_JSON_CONNECTOR_ID,
    name: 'WebSocket JSON',
    description: 'Subscribe to a wss:// feed of JSON messages; map each message’s records as they arrive.',
    uses: ['websocket', 'mapping'],
    dataset: 'EVENT_STREAM',
  },
  validate: validateWebSocketJson,
  createProvider: (d) => new WebSocketJsonProvider(d),
};
