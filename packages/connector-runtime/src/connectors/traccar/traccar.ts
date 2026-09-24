import type { IsoTimestamp, Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  numberSetting,
  resolveLocalEndpoint,
  stringSetting,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderErrorCode,
  type ProviderHealth,
  type ProviderHttpRequest,
  type ProviderManifest,
  type ProviderQuery,
  type ProviderSettingDefinition,
  type ProviderSocketHandle,
  type ProviderSubscription,
  type Unsubscribe,
} from '@worldview/provider-sdk';
import {
  compileMapping,
  definitionToManifest,
  mapRecords,
  type CompiledMapping,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';
import type { Timers } from '../websocket-json.js';
import { TraccarDirectory, readDevice, readEvent, readSocketMessage } from './session.js';

/**
 * Traccar (phase `traccar`): the devices of a Traccar server — the open-source GPS tracking
 * platform — as objects with live positions. A poll reads `/api/devices` (every few
 * minutes, for names and categories) and `/api/positions` (each device's latest position);
 * with a `websocket`, the server's `/api/socket` then pushes positions, device changes and
 * events as they happen, and the poll keeps refreshing the snapshot underneath it. Each
 * position becomes one record for the definition's own mapping (session.ts says what the
 * record holds: the position, `deviceName`, `device`, `event`), so the definition decides
 * the object type, the labels and the properties; speed arrives in knots (`knotsToMps`).
 *
 * The server is either a public https host (`endpoint.url`, the Traccar web address) or,
 * with no `endpoint`, a server on this computer or on the one host the operator names in
 * the source's `host` setting (ADR-003's local policy: plain http, nothing discovered). The
 * token is a credential reference: `Authorization: Bearer` on the REST calls, `?token=` on
 * the socket URL, put there by the host (ADR-003/ADR-013 amendment for this phase) — the
 * provider never sees it. A local server is read by REST only: the host opens `wss://` to
 * public hosts alone.
 */
export const TRACCAR_CONNECTOR_ID = 'traccar';
/** Traccar's default web port, and where a server on this computer is looked for. */
export const TRACCAR_DEFAULT_PORT = 8082;
export const TRACCAR_LOCAL_HOST = '127.0.0.1';
/** The device list is read again this often (names, categories, status). */
export const TRACCAR_DEVICES_REFRESH_MS = 5 * 60_000;
/** After a device list that could not be read, it is tried again this much later. */
export const TRACCAR_DEVICES_RETRY_MS = 60_000;
/** A local server has no `endpoint` to carry a cadence: its positions are read this often. */
export const TRACCAR_LOCAL_INTERVAL_SECONDS = 30;
/** One poll: the device list and the positions. */
export const TRACCAR_REQUESTS_PER_POLL = 2;
/** The credential a local definition must declare (it has no endpoint to name one). */
export const TRACCAR_LOCAL_CREDENTIAL = 'token';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** Failures of the device list that also stop the positions: the poll fails with them. */
const FATAL_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'AUTH',
  'CANCELLED',
  'HOST_NOT_ALLOWED',
  'TIMEOUT',
  'OFFLINE',
  'NETWORK',
  'DNS',
  'RATE_LIMITED',
]);

/** Headers that would put a secret in the definition itself. */
const SECRET_HEADERS: ReadonlySet<string> = new Set(['authorization', 'cookie', 'proxy-authorization']);
type FieldLike = ConnectorProviderDefinition['mapping']['externalId'];

const fixMs = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN);

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h !== null && 'unref' in h) (h as { unref(): void }).unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const TRACCAR_LOCAL_SETTINGS: readonly ProviderSettingDefinition[] = Object.freeze([
  {
    key: 'host',
    label: 'Traccar server address',
    kind: 'string',
    placeholder: '192.168.1.20',
    defaultLabel: 'This computer (127.0.0.1)',
    description:
      'The host name or IP address of your Traccar server on your network; leave it empty for a server on this computer. Only this address is contacted, over plain HTTP.',
    helpUrl: 'https://www.traccar.org/documentation/',
  },
  {
    key: 'port',
    label: 'Traccar web port',
    kind: 'number',
    min: 1,
    max: 65_535,
    step: 1,
    defaultLabel: String(TRACCAR_DEFAULT_PORT),
    description: 'The port of the Traccar web interface (and its API) on that host.',
  },
]);

/** The server's base address from a definition URL: no trailing slash, no `/api`. */
export function traccarBase(url: string): string {
  const u = new URL(url);
  let path = u.pathname.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith('/api')) path = path.slice(0, -4);
  return `${u.protocol}//${u.host}${path}`;
}

export function isLocalTraccar(d: ConnectorProviderDefinition): boolean {
  return !d.endpoint;
}

/** The provider manifest of a Traccar definition. */
export function traccarManifest(d: ConnectorProviderDefinition): ProviderManifest {
  const base = definitionToManifest(d, 'Traccar');
  const local = isLocalTraccar(d);
  const intervalSeconds = local
    ? TRACCAR_LOCAL_INTERVAL_SECONDS
    : Math.max(5, d.endpoint?.intervalSeconds ?? base.refreshPolicy.intervalMs / 1000);
  const timeoutMs = base.refreshPolicy.timeoutMs;
  const perPoll = TRACCAR_REQUESTS_PER_POLL;
  const manifest: ProviderManifest = {
    ...base,
    refreshPolicy: {
      ...base.refreshPolicy,
      intervalMs: intervalSeconds * 1000,
      // Twice the cadence with the retry, and never below one poll's two requests, twice, plus one.
      maxRequestsPerMinute: Math.max(4, Math.ceil((120 / intervalSeconds) * (perPoll + 1)), 2 * perPoll + 1),
      pollBudgetMs: Math.min(600_000, timeoutMs * perPoll + 5000),
    },
    capabilities: { ...base.capabilities, live: true, offline: false, boundsQuery: false },
  };
  if (!local) return manifest;
  const settings = [...(base.settings ?? [])];
  for (const s of TRACCAR_LOCAL_SETTINGS) if (!settings.some((x) => x.key === s.key)) settings.push({ ...s });
  return {
    ...manifest,
    transport: 'local-process',
    // Loopback; the one host the operator names in `host` is added by the runtime (ADR-003).
    allowedHosts: ['127.0.0.1', 'localhost'],
    trustedHostSetting: 'host',
    settings,
  };
}

interface Session {
  emit: ObservationEmitter;
  handle: ProviderSocketHandle | undefined;
  pending: Map<string, Observation>;
  flushTimer: unknown;
  retryTimer: unknown;
  retryMs: number;
  closed: boolean;
  generation: number;
}

export interface TraccarOptions {
  timers?: Timers;
  flushIntervalMs?: number;
}

export class TraccarProvider extends PollingProvider {
  readonly manifest: ProviderManifest;
  /** Present only when the definition has a `websocket`: the host then subscribes as well as polls. */
  readonly subscribe?: (request: ProviderSubscription, emit: ObservationEmitter) => Promise<Unsubscribe>;
  directory = new TraccarDirectory();
  readonly stats = {
    positions: 0,
    rejected: 0,
    excluded: 0,
    messages: 0,
    malformed: 0,
    keepalives: 0,
    reconnects: 0,
  };
  private readonly mapping: CompiledMapping;
  private readonly timers: Timers;
  private readonly flushIntervalMs: number;
  private settings: Record<string, unknown> = {};
  private nextDevicesReadAt = 0;
  private devicesError: ProviderError | undefined;
  private lastRejected = 0;
  private session: Session | undefined;
  private live = false;
  private socketConnected = false;
  private socketError: ProviderError | undefined;
  private socketErrorAt: IsoTimestamp | undefined;
  private socketLastSuccess: IsoTimestamp | undefined;
  private socketLastObservation: IsoTimestamp | undefined;
  private readonly socketIds = new Set<string>();

  constructor(
    readonly definition: ConnectorProviderDefinition,
    options: TraccarOptions = {},
  ) {
    super();
    this.manifest = traccarManifest(definition);
    this.mapping = compileMapping(definition.mapping);
    this.timers = options.timers ?? realTimers;
    this.flushIntervalMs = options.flushIntervalMs ?? definition.websocket?.flushMs ?? 500;
    if (definition.websocket && definition.endpoint) this.subscribe = (request, emit) => this.openSocket(request, emit);
  }

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    if (!isLocalTraccar(this.definition)) return;
    this.settings = await context.settings.get();
    context.settings.onChange((s) => {
      this.settings = s;
      // Another server, perhaps: nothing known about the last one applies to it.
      this.directory = new TraccarDirectory();
      this.socketIds.clear();
      this.devicesError = undefined;
      this.nextDevicesReadAt = 0;
    });
  }

  override async start(): Promise<void> {
    await super.start();
    this.live = true;
  }

  override async stop(): Promise<void> {
    this.live = false;
    if (this.session) this.closeSession(this.session);
    await super.stop();
  }

  /** The server's base URL for REST calls, or why there is none. */
  restBase(): string {
    if (this.definition.endpoint) return traccarBase(this.definition.endpoint.url);
    const host = stringSetting(this.settings, 'host', { host: true });
    const port = numberSetting(this.settings, 'port', 1, 65_535) ?? TRACCAR_DEFAULT_PORT;
    const target = resolveLocalEndpoint(`http://${host ?? TRACCAR_LOCAL_HOST}:${Math.trunc(port)}`, {
      label: 'Traccar server address',
      trustedHostSetting: 'host',
      ...(host ? { trustedHost: host } : {}),
    });
    if (!target.ok) throw new ProviderError('HOST_NOT_ALLOWED', target.reason, { retryable: false });
    return traccarBase(target.url);
  }

  /** A REST request: the definition's headers, the token by reference (the host attaches it). */
  buildRequest(base: string, path: '/api/devices' | '/api/positions'): ProviderHttpRequest {
    const e = this.definition.endpoint;
    const req: ProviderHttpRequest = {
      url: `${base}${path}`,
      method: 'GET',
      headers: { Accept: 'application/json', ...(e?.headers ?? {}) },
      maxBytes: e?.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: this.manifest.refreshPolicy.timeoutMs,
    };
    const named = e?.credential;
    const ref = this.definition.credentials?.[named?.name ?? TRACCAR_LOCAL_CREDENTIAL];
    if (ref)
      req.credential =
        named?.as === 'header' && named.param
          ? { key: ref.secretRef, as: 'header', name: named.param }
          : { key: ref.secretRef, as: 'bearer' };
    return req;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const base = this.restBase();
    const now = this.context.clock.now();
    if (now >= this.nextDevicesReadAt) await this.readDevices(base, request.signal, now);
    const req = this.buildRequest(base, '/api/positions');
    const res = await this.context.http.request({ ...req, signal: request.signal, cacheKey: req.url });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: /api/positions did not answer JSON`, {
        retryable: false,
      });
    }
    if (!Array.isArray(body)) {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: /api/positions did not answer a list`, {
        retryable: false,
      });
    }
    const read = this.recordsOf(body);
    const mapped = this.map(read.records, res.stale || res.fromCache ? 'cached' : 'live', `${base}/api/positions`);
    this.lastRejected = mapped.rejected.length + read.invalid;
    this.stats.positions += body.length;
    this.stats.rejected += this.lastRejected;
    this.stats.excluded += read.excluded;
    if (this.lastRejected)
      this.context.logger.warn('rejected positions', {
        count: this.lastRejected,
        sample: [...read.reasons, ...mapped.rejected.map((r) => r.reason)].slice(0, 3),
      });
    const usable = body.length - read.excluded - read.held;
    if (usable > 0 && mapped.observations.length === 0 && mapped.filtered === 0) {
      // Every position unusable: the mapping does not fit this server. Say so rather than show nothing.
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: ${usable} position(s), none usable`, {
        retryable: false,
      });
    }
    return { observations: mapped.observations, cacheAgeMs: res.ageMs };
  }

  /**
   * `/api/devices`: names and categories. Until one list has been read, a failure here fails
   * the poll (no category, no way to leave out a `person` device); after that it leaves the
   * positions to be read with the last list, and the list is tried again a minute later.
   */
  private async readDevices(base: string, signal: AbortSignal, now: number): Promise<void> {
    try {
      const req = this.buildRequest(base, '/api/devices');
      const res = await this.context.http.request({ ...req, signal, cacheKey: req.url });
      let body: unknown;
      try {
        body = res.json();
      } catch {
        res.invalidate();
        throw new ProviderError('MALFORMED', '/api/devices did not answer JSON', { retryable: false });
      }
      if (!Array.isArray(body)) {
        res.invalidate();
        throw new ProviderError('MALFORMED', '/api/devices did not answer a list', { retryable: false });
      }
      const devices = body.map(readDevice).filter((d) => d !== undefined);
      if (body.length > 0 && devices.length === 0) {
        res.invalidate();
        throw new ProviderError('MALFORMED', 'no entry of the /api/devices answer has an id and a name', {
          retryable: false,
        });
      }
      this.directory.replaceDevices(devices, now);
      this.devicesError = undefined;
      this.nextDevicesReadAt = now + TRACCAR_DEVICES_REFRESH_MS;
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      if (FATAL_CODES.has(pe.code)) throw pe;
      if (!this.directory.listRead)
        throw new ProviderError(pe.code, `no position is shown until the device list is read: ${pe.message}`, {
          retryable: pe.retryable,
          ...(pe.httpStatus !== undefined ? { httpStatus: pe.httpStatus } : {}),
        });
      this.devicesError = pe;
      this.nextDevicesReadAt = now + TRACCAR_DEVICES_RETRY_MS;
      this.context.logger.warn('traccar device list unavailable', { code: pe.code, message: pe.message });
    }
  }

  private recordsOf(positions: readonly unknown[]): {
    records: unknown[];
    excluded: number;
    held: number;
    invalid: number;
    reasons: string[];
  } {
    const records: unknown[] = [];
    const reasons: string[] = [];
    let excluded = 0;
    let held = 0;
    let invalid = 0;
    for (const raw of positions) {
      const r = this.directory.record(raw);
      if ('excluded' in r) excluded++;
      else if ('held' in r) held++;
      else if ('invalid' in r) {
        invalid++;
        if (reasons.length < 3) reasons.push(r.invalid);
      } else records.push(r.record);
    }
    return { records, excluded, held, invalid, reasons };
  }

  private map(records: unknown[], origin: 'live' | 'cached', sourceRef: string) {
    return mapRecords(records, {
      manifest: this.manifest,
      definition: this.definition,
      mapping: this.mapping,
      receivedAt: new Date(this.context.clock.now()).toISOString(),
      origin,
      sourceRef,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
  }

  // ── the socket ─────────────────────────────────────────────────────────────

  private async openSocket(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe> {
    if (this.session) this.closeSession(this.session);
    const session: Session = {
      emit,
      handle: undefined,
      pending: new Map(),
      flushTimer: undefined,
      retryTimer: undefined,
      retryMs: RECONNECT_MIN_MS,
      closed: false,
      generation: 0,
    };
    this.session = session;
    request.signal.addEventListener('abort', () => this.closeSession(session), { once: true });
    try {
      const ws = this.definition.websocket!;
      const key = ws.credential ? this.definition.credentials?.[ws.credential.name]?.secretRef : undefined;
      // Nothing is opened until the token is there (the socket would only be refused).
      if (key && !(await this.context.credentials.has(key))) {
        const err = new ProviderError('AUTH', `credential ${key} not configured`, { retryable: false });
        this.noteSocketError(err);
        throw err;
      }
      await this.connect(session);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError('NETWORK', String(err));
      // A refused token or host is the operator's to fix; anything else (offline at start, a
      // server that is down) is tried again here, since the host's own retry of a failed
      // subscription shares its timer with the poll and would be lost to the next poll.
      if (pe.code === 'AUTH' || pe.code === 'HOST_NOT_ALLOWED') {
        this.closeSession(session);
        throw pe;
      }
      this.context.logger.warn('traccar socket not opened', { code: pe.code, message: pe.message });
      if (!session.closed) this.scheduleReconnect(session);
    }
    return () => this.closeSession(session);
  }

  private async connect(session: Session): Promise<void> {
    const ws = this.definition.websocket!;
    const generation = ++session.generation;
    const ref = ws.credential ? this.definition.credentials?.[ws.credential.name] : undefined;
    const current = () => session.generation === generation && !session.closed;
    // The host reports one failure as an error and then a close: the socket is dropped once.
    let dropped = false;
    const drop = (error: ProviderError) => {
      if (!current() || dropped) return;
      dropped = true;
      this.onDrop(session, error);
    };
    if (session.closed) return;
    let handle: ProviderSocketHandle;
    try {
      handle = await this.context.sockets.open(
        ws.url,
        {
          onOpen: () => {
            if (!current()) return;
            this.socketConnected = true;
            this.socketError = undefined;
            this.socketLastSuccess = this.nowIso();
            session.retryMs = RECONNECT_MIN_MS;
            session.emit([], { snapshot: false });
          },
          onMessage: (data) => {
            if (current()) this.onMessage(session, data);
          },
          onClose: (code, reason) =>
            drop(new ProviderError('OFFLINE', `the Traccar socket closed (${code}${reason ? ` ${reason}` : ''})`)),
          onError: (error) => drop(new ProviderError('NETWORK', error.message)),
        },
        {
          maxMessageBytes: ws.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
          // The host puts the token in the URL it dials (`?token=`); this provider never sees it.
          ...(ref ? { credential: { key: ref.secretRef, as: 'query', param: ws.credential?.param ?? 'token' } } : {}),
        },
      );
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('NETWORK', err instanceof Error ? err.message : String(err));
      this.noteSocketError(pe);
      throw pe;
    }
    if (!current()) {
      handle.close();
      return;
    }
    session.handle = handle;
  }

  private onMessage(session: Session, data: string | Uint8Array): void {
    this.stats.messages++;
    const msg = readSocketMessage(data);
    if (msg.kind === 'malformed') {
      this.stats.malformed++;
      return;
    }
    if (msg.kind === 'keepalive') {
      this.stats.keepalives++;
      return;
    }
    // Devices and events first, so the positions in the same message are read with them.
    const touched = new Set<number>();
    const devices = msg.devices.map(readDevice).filter((d) => d !== undefined);
    this.directory.updateDevices(devices);
    for (const d of devices) touched.add(d.id);
    for (const raw of msg.events) {
      const event = readEvent(raw);
      if (!event) continue;
      this.directory.noteEvent(event);
      touched.add(event.deviceId);
    }
    const records = new Map<number, unknown>();
    let excluded = 0;
    let invalid = 0;
    for (const raw of msg.positions) {
      const r = this.directory.record(raw);
      if ('excluded' in r) excluded++;
      else if ('invalid' in r) invalid++;
      else if ('record' in r) {
        // Two fixes of one device in one message: the newer one.
        const prior = records.get(r.deviceId) as { fixTime?: unknown } | undefined;
        if (!prior || !(fixMs(prior.fixTime) > fixMs(r.record['fixTime']))) records.set(r.deviceId, r.record);
      }
    }
    // A device that changed, or raised an event, without a new position: its last position again, with it.
    for (const id of touched) {
      if (records.has(id)) continue;
      const last = this.directory.recordOfLast(id);
      if (last) records.set(id, last);
    }
    this.stats.positions += msg.positions.length;
    this.stats.excluded += excluded;
    if (records.size === 0) {
      this.stats.rejected += invalid;
      return;
    }
    const mapped = this.map([...records.values()], 'live', this.definition.websocket!.url);
    this.stats.rejected += invalid + mapped.rejected.length;
    for (const o of mapped.observations) {
      const key = o.externalId ?? o.id;
      this.socketIds.add(key);
      if (this.socketIds.size > 100_000) this.socketIds.delete(this.socketIds.values().next().value!);
      // Within one flush, a fix older than the one waiting does not replace it (a re-send, same time, does).
      const waiting = session.pending.get(key);
      if (waiting && Date.parse(waiting.observedAt) > Date.parse(o.observedAt)) continue;
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
    this.socketLastObservation = this.nowIso();
    this.socketLastSuccess = this.socketLastObservation;
    session.emit(batch, { snapshot: false });
  }

  private onDrop(session: Session, error: ProviderError): void {
    if (session.closed) return;
    session.handle = undefined;
    this.socketConnected = false;
    this.noteSocketError(error);
    this.context.logger.warn('traccar socket lost', { message: error.message });
    session.emit([], { snapshot: false });
    this.scheduleReconnect(session);
  }

  private scheduleReconnect(session: Session): void {
    if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
    const wait = session.retryMs;
    session.retryMs = Math.min(RECONNECT_MAX_MS, session.retryMs * 2);
    session.retryTimer = this.timers.setTimeout(() => {
      session.retryTimer = undefined;
      if (session.closed || !this.live) return;
      this.stats.reconnects++;
      this.connect(session).catch(() => {
        if (session.closed) return;
        session.emit([], { snapshot: false });
        this.scheduleReconnect(session);
      });
    }, wait);
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    for (const t of [session.flushTimer, session.retryTimer]) if (t !== undefined) this.timers.clearTimeout(t);
    session.handle?.close();
    session.handle = undefined;
    this.socketConnected = false;
    if (this.session === session) this.session = undefined;
  }

  private noteSocketError(err: ProviderError): void {
    this.socketError = err;
    this.socketErrorAt = this.nowIso();
  }

  private nowIso(): IsoTimestamp {
    return new Date(this.context.clock.now()).toISOString();
  }

  // ── health: the poll's, with the socket over it ───────────────────────────

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    let lead: string | undefined;
    if (this.subscribe && this.session && h.status !== 'DISABLED' && h.status !== 'AUTH_REQUIRED') {
      if (this.socketConnected) {
        if (h.status !== 'LIVE') lead = 'live socket connected; the last poll failed';
        h.status = 'LIVE';
      } else if (this.socketError) {
        const code = this.socketError.code;
        if (code === 'AUTH') {
          h.status = 'AUTH_REQUIRED';
          lead = `socket not opened: ${this.socketError.message}`;
        } else if (h.status === 'LIVE' || h.status === 'STALE') {
          h.status = 'DEGRADED';
          lead = `live socket unavailable (${this.socketError.message}); positions from the poll every ${this.manifest.refreshPolicy.intervalMs / 1000} s`;
        } else if (h.status === 'STARTING') {
          h.status = code === 'OFFLINE' || code === 'TIMEOUT' ? 'OFFLINE' : 'ERROR';
          lead = this.socketError.message;
          if (this.socketErrorAt) h.lastError = this.socketError.toInfo(this.socketErrorAt);
        }
      }
      if (this.socketLastSuccess && (!h.lastSuccess || h.lastSuccess < this.socketLastSuccess))
        h.lastSuccess = this.socketLastSuccess;
      if (this.socketLastObservation && (!h.lastObservation || h.lastObservation < this.socketLastObservation))
        h.lastObservation = this.socketLastObservation;
      h.objectCount = Math.max(h.objectCount ?? 0, this.socketIds.size);
    }
    const notes = [lead, h.message];
    if (this.devicesError) notes.push(`device names unavailable (${this.devicesError.message})`);
    if (this.stats.excluded) notes.push('positions of devices in the Traccar category "person" are not shown');
    if (this.lastRejected) notes.push(`${this.lastRejected} position(s) rejected on the last poll`);
    const message = notes.filter((n): n is string => Boolean(n)).join('; ');
    if (message) h.message = message;
    return h;
  }
}

export function validateTraccar(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const credentialNames = Object.keys(d.credentials ?? {});
  if (d.file) errors.push('file is not read by this connector');
  if (d.boundsQuery) errors.push('boundsQuery is not supported: a Traccar server answers for all its devices');
  if (d.pagination) warnings.push('pagination is ignored by this connector');
  if (d.response) warnings.push('response is ignored by this connector: Traccar answers are read as Traccar answers');
  if (d.endpoint) {
    const e = d.endpoint;
    let url: URL | undefined;
    try {
      url = new URL(e.url);
    } catch {
      errors.push('endpoint.url is not a URL');
    }
    if (url && (url.search || url.hash)) errors.push('endpoint.url is the server address: no query or fragment');
    if (url && /\/api\/(positions|devices|socket|session)/i.test(url.pathname))
      errors.push('endpoint.url is the server address (https://host[/prefix]), not an API path');
    if (e.method === 'POST') errors.push('endpoint.method: Traccar is read with GET');
    if (e.body !== undefined) errors.push('endpoint.body is not sent by this connector');
    if (e.query && Object.keys(e.query).length) warnings.push('endpoint.query is ignored by this connector');
    const secretHeaders = Object.keys(e.headers ?? {}).filter((h) => SECRET_HEADERS.has(h.toLowerCase()));
    if (secretHeaders.length)
      errors.push(
        `endpoint.headers must not carry ${secretHeaders.join(', ')}: a token or session is a credential reference, never text in a definition`,
      );
    if (!e.credential) errors.push('endpoint.credential is required: Traccar answers nothing without a token');
    else if (e.credential.as !== 'bearer' && e.credential.as !== 'header')
      errors.push('endpoint.credential.as must be "bearer" (a Traccar token) or "header"');
    else if (e.credential.as === 'header' && !e.credential.param)
      errors.push('endpoint.credential "header" needs param, the header name');
  } else {
    if (!credentialNames.includes(TRACCAR_LOCAL_CREDENTIAL))
      errors.push(
        `a local Traccar server (no endpoint) needs credentials.${TRACCAR_LOCAL_CREDENTIAL}: the token, sent as a bearer token`,
      );
  }
  if (d.websocket) {
    const ws = d.websocket;
    if (!d.endpoint)
      errors.push('websocket needs an endpoint: a server on this computer or your network is read by REST only');
    let url: URL | undefined;
    try {
      url = new URL(ws.url);
    } catch {
      errors.push('websocket.url is not a URL');
    }
    if (url && d.endpoint) {
      let expected: string | undefined;
      try {
        expected = `${traccarBase(d.endpoint.url).replace(/^https:/, 'wss:')}/api/socket`;
      } catch {
        /* reported above */
      }
      if (expected && `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}` !== expected)
        errors.push(`websocket.url must be the same server's socket, ${expected}`);
      if (url.search) errors.push('websocket.url carries no query: the token is added by the host');
      if (url.hash) errors.push('websocket.url has no fragment');
    }
    if (!ws.credential) errors.push('websocket.credential is required: the socket takes the token as ?token=');
    else if ((ws.credential.as ?? 'open') !== 'query')
      errors.push('websocket.credential.as must be "query": Traccar has no subscribe frame to carry a token');
    else if (ws.credential.param !== undefined && ws.credential.param !== 'token')
      errors.push('websocket.credential.param must be "token" (or left out): Traccar reads ?token=');
    if (ws.subscribe !== undefined) errors.push('websocket.subscribe is not sent: Traccar needs no subscribe frame');
    if (ws.heartbeat !== undefined)
      warnings.push('websocket.heartbeat is ignored: the Traccar server sends keep-alives');
    if (ws.itemsPath || ws.filter?.length)
      warnings.push('websocket.itemsPath and websocket.filter are ignored: messages are read as Traccar messages');
  }
  const pathOf = (f: FieldLike | undefined) => (f === undefined ? undefined : typeof f === 'string' ? f : f.path);
  const transformsOf = (f: FieldLike | undefined) =>
    f === undefined || typeof f === 'string' ? [] : ([] as string[]).concat(f.transform ?? []);
  if (!d.mapping.observedAt) warnings.push('mapping.observedAt is unset: map fixTime (the time of the fix)');
  else if (pathOf(d.mapping.observedAt) !== 'fixTime')
    warnings.push('mapping.observedAt is not fixTime: serverTime and deviceTime are not the time of the fix');
  const speed = d.mapping.motion?.speedMps;
  if (pathOf(speed) === 'speed' && !transformsOf(speed).includes('knotsToMps'))
    warnings.push('mapping.motion.speedMps reads speed without knotsToMps: Traccar reports knots');
  const id = typeof d.mapping.externalId === 'string' ? d.mapping.externalId : d.mapping.externalId.path;
  if (id !== 'deviceId') warnings.push('mapping.externalId is not deviceId: one object per device needs the device id');
  return { ok: errors.length === 0, errors, warnings };
}

export const traccarConnector: Connector = {
  metadata: {
    id: TRACCAR_CONNECTOR_ID,
    name: 'Traccar',
    description:
      'Devices of a Traccar GPS tracking server: the latest positions by REST, then live positions and events over its socket.',
    uses: ['endpoint', 'websocket', 'mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateTraccar,
  createProvider: (d) => new TraccarProvider(d),
};
