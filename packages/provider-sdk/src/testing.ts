import { createHash } from 'node:crypto';
import type { JsonValue, Clock } from '@worldview/world-model';
import type {
  ProviderContext,
  ProviderHttp,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderLogger,
  ProviderSockets,
  ProviderSocketEvents,
  ProviderSocketHandle,
  ProviderSocketOptions,
  ProviderCredentials,
  ProviderCache,
  ProviderSettings,
  ProviderLocalAccess,
  LineStreamEvents,
  LineStreamHandle,
  ProviderMqtt,
  ProviderMqttOptions,
  ProviderMqttEvents,
  ProviderMqttHandle,
} from './provider.js';
import { ProviderError } from './health.js';
import {
  OGR_INPUT_EXTENSIONS,
  OGR_LAYER_NAME,
  checkRelativePath,
  extensionOf,
  type GrantedFileStat,
  type Ogr2ogrAccess,
  type Ogr2ogrDetection,
  type Ogr2ogrRequest,
} from './local-files.js';

/**
 * Test doubles for provider contract tests and the provider-validator CLI.
 * Fixture-driven: no network. Used by every provider's test/contract suite.
 */
export class VirtualClock implements Clock {
  private t: number;
  constructor(start = Date.parse('2026-09-21T00:00:00.000Z')) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

export type FixtureResponder = (req: ProviderHttpRequest) => FixtureResponse | Promise<FixtureResponse>;

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Simulate transport failure instead of an HTTP response. */
  error?: 'timeout' | 'network' | 'dns' | 'too-large' | 'abort';
  /** Delay before responding (virtual). */
  delayMs?: number;
  /** Answer as the runtime's HTTP layer does when it serves a cached body ('cache') or a stale one after a failure ('stale'). */
  served?: 'cache' | 'stale';
}

export class FixtureHttp implements ProviderHttp {
  readonly requests: ProviderHttpRequest[] = [];
  constructor(
    private readonly responder: FixtureResponder,
    private readonly clock: Clock,
  ) {}

  async request(req: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(req);
    if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const started = this.clock.now();
    const res = await this.responder(req);
    if (res.delayMs && this.clock instanceof VirtualClock) this.clock.advance(res.delayMs);
    if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'cancelled during request');
    switch (res.error) {
      case 'timeout':
        throw new ProviderError('TIMEOUT', `timeout after ${req.timeoutMs ?? 0}ms`);
      case 'network':
        throw new ProviderError('NETWORK', 'fetch failed: ECONNRESET');
      case 'dns':
        throw new ProviderError('DNS', 'getaddrinfo ENOTFOUND');
      case 'too-large':
        throw new ProviderError('TOO_LARGE', `response exceeded ${req.maxBytes ?? 0} bytes`);
      case 'abort':
        throw new ProviderError('CANCELLED', 'cancelled');
      default:
        break;
    }
    const status = res.status ?? 200;
    const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (status === 429) {
      const ra = Number(headers['retry-after'] ?? '45');
      throw new ProviderError('RATE_LIMITED', 'HTTP 429', {
        httpStatus: 429,
        retryAfterMs: (Number.isFinite(ra) ? ra : 45) * 1000,
      });
    }
    if (status === 401 || status === 403)
      throw new ProviderError('AUTH', `HTTP ${status}`, { httpStatus: status, retryable: false });
    if (status >= 500) throw new ProviderError('HTTP_5XX', `HTTP ${status}`, { httpStatus: status });
    if (status >= 400) throw new ProviderError('HTTP_4XX', `HTTP ${status}`, { httpStatus: status, retryable: false });
    const bodyBytes =
      typeof res.body === 'string' ? new TextEncoder().encode(res.body) : (res.body ?? new Uint8Array());
    if (req.maxBytes !== undefined && bodyBytes.byteLength > req.maxBytes)
      throw new ProviderError('TOO_LARGE', `response exceeded ${req.maxBytes} bytes`);
    const text = typeof res.body === 'string' ? res.body : new TextDecoder().decode(bodyBytes);
    return {
      status,
      headers,
      text: () => text,
      json: () => JSON.parse(text) as unknown,
      bytes: () => bodyBytes,
      fromCache: res.served === 'cache',
      stale: res.served === 'stale',
      ageMs: 0,
      latencyMs: this.clock.now() - started,
      invalidate: () => {},
    };
  }
}

export class MemoryLogger implements ProviderLogger {
  readonly entries: Array<{ level: string; message: string; fields?: Record<string, JsonValue> }> = [];
  private log(level: string, message: string, fields?: Record<string, JsonValue>): void {
    this.entries.push(fields ? { level, message, fields } : { level, message });
  }
  debug(m: string, f?: Record<string, JsonValue>): void {
    this.log('debug', m, f);
  }
  info(m: string, f?: Record<string, JsonValue>): void {
    this.log('info', m, f);
  }
  warn(m: string, f?: Record<string, JsonValue>): void {
    this.log('warn', m, f);
  }
  error(m: string, f?: Record<string, JsonValue>): void {
    this.log('error', m, f);
  }
}

export class MemoryCredentials implements ProviderCredentials {
  constructor(private readonly present: Set<string> = new Set()) {}
  async has(key: string): Promise<boolean> {
    return this.present.has(key);
  }
  grant(key: string): void {
    this.present.add(key);
  }
  revoke(key: string): void {
    this.present.delete(key);
  }
}

export class MemoryCache implements ProviderCache {
  readonly store = new Map<string, { value: JsonValue; storedAt: string; expiresAt?: number }>();
  constructor(
    private readonly clock: Clock,
    private readonly enabled = true,
  ) {}
  async get<T extends JsonValue>(key: string): Promise<{ value: T; storedAt: string } | undefined> {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt < this.clock.now()) {
      this.store.delete(key);
      return undefined;
    }
    return { value: e.value as T, storedAt: e.storedAt };
  }
  async set(key: string, value: JsonValue, ttlMs?: number): Promise<void> {
    if (!this.enabled) return;
    this.store.set(key, {
      value,
      storedAt: new Date(this.clock.now()).toISOString(),
      ...(ttlMs !== undefined ? { expiresAt: this.clock.now() + ttlMs } : {}),
    });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class MemorySettings implements ProviderSettings {
  private listeners = new Set<(s: Record<string, JsonValue>) => void>();
  constructor(private value: Record<string, JsonValue> = {}) {}
  async get(): Promise<Record<string, JsonValue>> {
    return this.value;
  }
  onChange(listener: (s: Record<string, JsonValue>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(next: Record<string, JsonValue>): void {
    this.value = next;
    for (const l of this.listeners) l(next);
  }
}

export class FixtureSockets implements ProviderSockets {
  readonly opened: Array<{
    url: string;
    events: ProviderSocketEvents;
    handle: FixtureSocketHandle;
    credential?: { key: string };
  }> = [];
  /** Secrets this fake resolves for `opts.credential` (mirrors the runtime's socket credential path). */
  secrets: Record<string, string> = {};
  constructor(
    private readonly onOpen?: (url: string, events: ProviderSocketEvents, handle: FixtureSocketHandle) => void,
  ) {}
  async open(url: string, events: ProviderSocketEvents, opts?: ProviderSocketOptions): Promise<ProviderSocketHandle> {
    const secret = opts?.credential ? this.secrets[opts.credential.key] : undefined;
    const handle = new FixtureSocketHandle(events, secret);
    this.opened.push({ url, events, handle, ...(opts?.credential ? { credential: opts.credential } : {}) });
    this.onOpen?.(url, events, handle);
    return handle;
  }
}

export class FixtureSocketHandle implements ProviderSocketHandle {
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  constructor(
    private readonly events: ProviderSocketEvents,
    private readonly secret?: string,
  ) {}
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void {
    if (!this.closed) {
      this.closed = true;
      this.events.onClose(code, reason);
    }
  }
  /** Test hooks */
  simulateOpen(ctx?: { secret?: string }): void {
    const resolved = ctx?.secret ?? this.secret;
    this.events.onOpen?.(resolved !== undefined ? { secret: resolved } : {});
  }
  simulateMessage(data: string | Uint8Array): void {
    this.events.onMessage(data);
  }
  simulateError(err: Error): void {
    this.events.onError(err);
  }
  simulateClose(code = 1006, reason = 'abnormal'): void {
    this.closed = true;
    this.events.onClose(code, reason);
  }
}

/**
 * An MQTT broker a test drives (ADR-003 amendment 2026-09-23): records every `connect`,
 * refuses when told to, and lets the test deliver messages, open, close and fail the
 * connection. `secrets` mirrors the runtime's credential path: the resolved password is
 * recorded on the connection (never handed to the provider).
 */
export class FixtureMqtt implements ProviderMqtt {
  readonly connections: FixtureMqttConnection[] = [];
  /** Set to make the next `connect` calls fail (broker down, host refused). */
  refuse: ProviderError | undefined;
  secrets: Record<string, string> = {};
  async connect(opts: ProviderMqttOptions, events: ProviderMqttEvents): Promise<ProviderMqttHandle> {
    if (this.refuse) throw this.refuse;
    const password = opts.credential ? this.secrets[opts.credential.key] : undefined;
    const c = new FixtureMqttConnection(opts, events, password);
    this.connections.push(c);
    return c;
  }
}

export class FixtureMqttConnection implements ProviderMqttHandle {
  closed = false;
  dropped = 0;
  constructor(
    readonly options: ProviderMqttOptions,
    private readonly events: ProviderMqttEvents,
    /** What the runtime would have sent as the MQTT password. */
    readonly password?: string,
  ) {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.onClose?.('closed');
  }
  /** Test hooks */
  simulateOpen(): void {
    this.events.onOpen?.();
  }
  simulateMessage(topic: string, payload: string | Uint8Array, meta: { retained?: boolean; qos?: number } = {}): void {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    this.events.onMessage(topic, bytes, { retained: meta.retained ?? false, qos: meta.qos ?? 0 });
  }
  simulateClose(reason = 'broker closed the connection'): void {
    this.closed = true;
    this.events.onClose?.(reason);
  }
  simulateError(err: ProviderError): void {
    this.events.onError?.(err);
  }
}

/** A line stream a test drives: `simulateLine`, `simulateClose`, `simulateError`. */
export class FixtureLineStream implements LineStreamHandle {
  closed = false;
  dropped = 0;
  constructor(
    readonly target: { host: string; port: number },
    private readonly events: LineStreamEvents,
  ) {}
  simulateLine(line: string): void {
    if (!this.closed) this.events.onLine(line);
  }
  simulateClose(reason = 'the device closed the connection'): void {
    if (this.closed) return;
    this.closed = true;
    this.events.onClose?.(reason);
  }
  simulateError(error: ProviderError): void {
    if (!this.closed) this.events.onError?.(error);
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * A granted folder in memory, answering as the host does: the path rule
 * (`checkRelativePath`) refuses with HOST_NOT_ALLOWED, a file that is not there is
 * UNSUPPORTED, a file over `maxBytes` (or the fixture's own `hostMaxBytes`) is TOO_LARGE
 * before it is read. Keys are `/`-separated relative paths, as a provider names them.
 */
export class FixtureLocalAccess implements ProviderLocalAccess {
  /** Every line stream opened, in order. */
  readonly streams: FixtureLineStream[] = [];
  /** Set to make the next `openLineStream` calls fail (nothing listening, say). */
  refuseStreams: ProviderError | undefined;
  /** Set to make every granted-file read and stat fail with this error (a host that refuses). */
  refuseFiles: ProviderError | undefined;
  /** Modification times a test sets per path (default: the epoch). */
  readonly mtimes: Record<string, number> = {};
  /** How many reads and stats the provider made, per path. */
  readonly reads: Record<string, number> = {};
  readonly stats: Record<string, number> = {};
  /** The host's own read cap (32 MiB in the app). */
  hostMaxBytes = 32 * 1024 * 1024;
  /** A stand-in for GDAL's ogr2ogr (`FixtureOgr2ogr`); absent → a host without the converter. */
  ogr2ogr?: Ogr2ogrAccess;
  constructor(
    readonly files: Record<string, Uint8Array> = {},
    private readonly reachable: Record<string, number> = {},
  ) {}
  async openLineStream(target: { host: string; port: number }, events: LineStreamEvents): Promise<LineStreamHandle> {
    if (this.refuseStreams) throw this.refuseStreams;
    const stream = new FixtureLineStream(target, events);
    this.streams.push(stream);
    return stream;
  }
  /** The file a path names, or the typed refusal. */
  private locate(path: string): { path: string; bytes: Uint8Array } {
    if (this.refuseFiles) throw this.refuseFiles;
    const verdict = checkRelativePath(path);
    if (!verdict.ok) throw new ProviderError('HOST_NOT_ALLOWED', verdict.reason, { retryable: false });
    const bytes = this.files[verdict.path];
    if (!bytes)
      throw new ProviderError('UNSUPPORTED', `${verdict.path} does not exist in the granted folder`, {
        retryable: false,
      });
    return { path: verdict.path, bytes };
  }
  async readGrantedFile(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array> {
    const { path: key, bytes } = this.locate(path);
    this.reads[key] = (this.reads[key] ?? 0) + 1;
    const limit = Math.min(opts?.maxBytes ?? this.hostMaxBytes, this.hostMaxBytes);
    if (bytes.byteLength > limit)
      throw new ProviderError('TOO_LARGE', `the file exceeds ${limit} bytes`, { retryable: false });
    return bytes;
  }
  async statGrantedFile(path: string): Promise<GrantedFileStat> {
    const { path: key, bytes } = this.locate(path);
    this.stats[key] = (this.stats[key] ?? 0) + 1;
    return { size: bytes.byteLength, mtimeMs: this.mtimes[key] ?? 0 };
  }
  async probeLocal(url: string): Promise<{ reachable: boolean; status?: number }> {
    const status = this.reachable[url];
    return status === undefined ? { reachable: false } : { reachable: true, status };
  }
}

export interface FixtureOgr2ogrOptions {
  /** What `detect()` answers (default: found, a fixture version). */
  detection?: Ogr2ogrDetection;
  /**
   * The GeoJSON the stand-in "converts" each input to, keyed by the input path — or by
   * `<input>#<layer>` when a layer is named — as a provider names it (`/`-separated, relative).
   */
  outputs?: Record<string, Uint8Array | string>;
  /** Modification times per input (default: the epoch); sizes are the outputs' sizes. */
  mtimes?: Record<string, number>;
  /** Thrown by every `toGeoJson` (a failing conversion). */
  fail?: ProviderError;
}

/** A stand-in for the host's ogr2ogr: no process, the answers a test wrote down. */
export class FixtureOgr2ogr implements Ogr2ogrAccess {
  readonly calls: Ogr2ogrRequest[] = [];
  /** The outputs by input (or `<input>#<layer>`); a test may change them between polls. */
  readonly outputs: Record<string, Uint8Array>;
  /** Modification times per input; a test bumps one to say a part of the dataset changed. */
  readonly mtimes: Record<string, number>;
  /** How many times each input was stat'ed. */
  readonly stats: Record<string, number> = {};
  /** Set to make every stat and conversion fail with this error (a host that refuses the path). */
  refuse: ProviderError | undefined;
  constructor(private readonly opts: FixtureOgr2ogrOptions = {}) {
    this.outputs = Object.fromEntries(
      Object.entries(opts.outputs ?? {}).map(([k, v]) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v]),
    );
    this.mtimes = { ...(opts.mtimes ?? {}) };
  }
  private check(input: string): string {
    if (this.refuse) throw this.refuse;
    const verdict = checkRelativePath(input);
    if (!verdict.ok) throw new ProviderError('HOST_NOT_ALLOWED', verdict.reason, { retryable: false });
    const ext = extensionOf(verdict.path);
    if (!OGR_INPUT_EXTENSIONS.includes(ext))
      throw new ProviderError('UNSUPPORTED', `.${ext || '(none)'} is not a format the host converts`, {
        retryable: false,
      });
    if (!Object.keys(this.outputs).some((k) => k === verdict.path || k.startsWith(`${verdict.path}#`)))
      throw new ProviderError('UNSUPPORTED', `${verdict.path} does not exist in the granted folder`, {
        retryable: false,
      });
    return verdict.path;
  }
  async detect(): Promise<Ogr2ogrDetection> {
    return this.opts.detection ?? { found: true, version: '0.0.0-fixture' };
  }
  async datasetStat(input: string): Promise<GrantedFileStat> {
    const key = this.check(input);
    this.stats[key] = (this.stats[key] ?? 0) + 1;
    const size = Object.entries(this.outputs)
      .filter(([k]) => k === key || k.startsWith(`${key}#`))
      .reduce((n, [, v]) => n + v.byteLength, 0);
    return { size, mtimeMs: this.mtimes[key] ?? 0 };
  }
  async toGeoJson(req: Ogr2ogrRequest): Promise<Uint8Array> {
    const key = this.check(req.input);
    if (req.layer !== undefined && !OGR_LAYER_NAME.test(req.layer))
      throw new ProviderError('HOST_NOT_ALLOWED', 'the layer name is not allowed', { retryable: false });
    this.calls.push(req);
    if (this.opts.fail) throw this.opts.fail;
    if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'the conversion was cancelled');
    const out = this.outputs[req.layer ? `${key}#${req.layer}` : key] ?? this.outputs[key];
    if (!out)
      throw new ProviderError('MALFORMED', `ogr2ogr failed: layer ${req.layer ?? '?'} not found`, {
        retryable: false,
      });
    const limit = req.maxOutputBytes ?? Number.MAX_SAFE_INTEGER;
    if (out.byteLength > limit)
      throw new ProviderError('TOO_LARGE', `the converted GeoJSON exceeds ${limit} bytes`, { retryable: false });
    return out;
  }
}

export interface FixtureContextOptions {
  providerId: string;
  responder?: FixtureResponder;
  clock?: VirtualClock;
  credentials?: string[];
  settings?: Record<string, JsonValue>;
  online?: boolean;
  cacheAllowed?: boolean;
  sockets?: FixtureSockets;
  local?: FixtureLocalAccess;
  /** Absent → the context has no `mqtt` (a host without the transport). */
  mqtt?: FixtureMqtt;
}

export interface FixtureContext extends ProviderContext {
  readonly clock: VirtualClock;
  readonly http: FixtureHttp;
  readonly logger: MemoryLogger;
  readonly credentials: MemoryCredentials;
  readonly cache: MemoryCache;
  readonly settings: MemorySettings;
  readonly sockets: FixtureSockets;
  setOnline(online: boolean): void;
}

export function createFixtureContext(opts: FixtureContextOptions): FixtureContext {
  const clock = opts.clock ?? new VirtualClock();
  let online = opts.online ?? true;
  const responder: FixtureResponder = opts.responder ?? (() => ({ status: 404, body: '' }));
  const http = new FixtureHttp(async (req) => {
    if (!online) throw new ProviderError('OFFLINE', 'application offline');
    return responder(req);
  }, clock);
  return {
    providerId: opts.providerId,
    clock,
    logger: new MemoryLogger(),
    http,
    sockets: opts.sockets ?? new FixtureSockets(),
    ...(opts.mqtt ? { mqtt: opts.mqtt } : {}),
    credentials: new MemoryCredentials(new Set(opts.credentials ?? [])),
    cache: new MemoryCache(clock, opts.cacheAllowed ?? true),
    settings: new MemorySettings(opts.settings ?? {}),
    local: opts.local ?? new FixtureLocalAccess(),
    hash: { sha256Hex: (input) => createHash('sha256').update(input).digest('hex') },
    connectivity: { online: () => online },
    setOnline: (v: boolean) => {
      online = v;
    },
  };
}
