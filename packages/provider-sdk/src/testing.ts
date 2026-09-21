import { createHash } from 'node:crypto';
import type { JsonValue, Clock } from '@worldview/world-model';
import type {
  ProviderContext, ProviderHttp, ProviderHttpRequest, ProviderHttpResponse, ProviderLogger, ProviderSockets,
  ProviderSocketEvents, ProviderSocketHandle, ProviderSocketOptions, ProviderCredentials, ProviderCache, ProviderSettings, ProviderLocalAccess,
} from './provider.js';
import { ProviderError } from './health.js';

/**
 * Test doubles for provider contract tests and the provider-validator CLI.
 * Fixture-driven: no network. Used by every provider's test/contract suite.
 */
export class VirtualClock implements Clock {
  private t: number;
  constructor(start = Date.parse('2026-09-21T00:00:00.000Z')) { this.t = start; }
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
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
}

export class FixtureHttp implements ProviderHttp {
  readonly requests: ProviderHttpRequest[] = [];
  constructor(private readonly responder: FixtureResponder, private readonly clock: Clock) {}

  async request(req: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(req);
    if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const started = this.clock.now();
    const res = await this.responder(req);
    if (res.delayMs && this.clock instanceof VirtualClock) this.clock.advance(res.delayMs);
    if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'cancelled during request');
    switch (res.error) {
      case 'timeout': throw new ProviderError('TIMEOUT', `timeout after ${req.timeoutMs ?? 0}ms`);
      case 'network': throw new ProviderError('NETWORK', 'fetch failed: ECONNRESET');
      case 'dns': throw new ProviderError('DNS', 'getaddrinfo ENOTFOUND');
      case 'too-large': throw new ProviderError('TOO_LARGE', `response exceeded ${req.maxBytes ?? 0} bytes`);
      case 'abort': throw new ProviderError('CANCELLED', 'cancelled');
      default: break;
    }
    const status = res.status ?? 200;
    const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (status === 429) {
      const ra = Number(headers['retry-after'] ?? '45');
      throw new ProviderError('RATE_LIMITED', 'HTTP 429', { httpStatus: 429, retryAfterMs: (Number.isFinite(ra) ? ra : 45) * 1000 });
    }
    if (status === 401 || status === 403) throw new ProviderError('AUTH', `HTTP ${status}`, { httpStatus: status, retryable: false });
    if (status >= 500) throw new ProviderError('HTTP_5XX', `HTTP ${status}`, { httpStatus: status });
    if (status >= 400) throw new ProviderError('HTTP_4XX', `HTTP ${status}`, { httpStatus: status, retryable: false });
    const bodyBytes = typeof res.body === 'string' ? new TextEncoder().encode(res.body) : (res.body ?? new Uint8Array());
    if (req.maxBytes !== undefined && bodyBytes.byteLength > req.maxBytes) throw new ProviderError('TOO_LARGE', `response exceeded ${req.maxBytes} bytes`);
    const text = typeof res.body === 'string' ? res.body : new TextDecoder().decode(bodyBytes);
    return {
      status,
      headers,
      text: () => text,
      json: () => JSON.parse(text) as unknown,
      bytes: () => bodyBytes,
      fromCache: false,
      stale: false,
      ageMs: 0,
      latencyMs: this.clock.now() - started,
      invalidate: () => {},
    };
  }
}

export class MemoryLogger implements ProviderLogger {
  readonly entries: Array<{ level: string; message: string; fields?: Record<string, JsonValue> }> = [];
  private log(level: string, message: string, fields?: Record<string, JsonValue>): void { this.entries.push(fields ? { level, message, fields } : { level, message }); }
  debug(m: string, f?: Record<string, JsonValue>): void { this.log('debug', m, f); }
  info(m: string, f?: Record<string, JsonValue>): void { this.log('info', m, f); }
  warn(m: string, f?: Record<string, JsonValue>): void { this.log('warn', m, f); }
  error(m: string, f?: Record<string, JsonValue>): void { this.log('error', m, f); }
}

export class MemoryCredentials implements ProviderCredentials {
  constructor(private readonly present: Set<string> = new Set()) {}
  async has(key: string): Promise<boolean> { return this.present.has(key); }
  grant(key: string): void { this.present.add(key); }
  revoke(key: string): void { this.present.delete(key); }
}

export class MemoryCache implements ProviderCache {
  readonly store = new Map<string, { value: JsonValue; storedAt: string; expiresAt?: number }>();
  constructor(private readonly clock: Clock, private readonly enabled = true) {}
  async get<T extends JsonValue>(key: string): Promise<{ value: T; storedAt: string } | undefined> {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt < this.clock.now()) { this.store.delete(key); return undefined; }
    return { value: e.value as T, storedAt: e.storedAt };
  }
  async set(key: string, value: JsonValue, ttlMs?: number): Promise<void> {
    if (!this.enabled) return;
    this.store.set(key, { value, storedAt: new Date(this.clock.now()).toISOString(), ...(ttlMs !== undefined ? { expiresAt: this.clock.now() + ttlMs } : {}) });
  }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

export class MemorySettings implements ProviderSettings {
  private listeners = new Set<(s: Record<string, JsonValue>) => void>();
  constructor(private value: Record<string, JsonValue> = {}) {}
  async get(): Promise<Record<string, JsonValue>> { return this.value; }
  onChange(listener: (s: Record<string, JsonValue>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  update(next: Record<string, JsonValue>): void { this.value = next; for (const l of this.listeners) l(next); }
}

export class FixtureSockets implements ProviderSockets {
  readonly opened: Array<{ url: string; events: ProviderSocketEvents; handle: FixtureSocketHandle; credential?: { key: string } }> = [];
  /** Secrets this fake resolves for `opts.credential` (mirrors the runtime's socket credential path). */
  secrets: Record<string, string> = {};
  constructor(private readonly onOpen?: (url: string, events: ProviderSocketEvents, handle: FixtureSocketHandle) => void) {}
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
  constructor(private readonly events: ProviderSocketEvents, private readonly secret?: string) {}
  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void { if (!this.closed) { this.closed = true; this.events.onClose(code, reason); } }
  /** Test hooks */
  simulateOpen(ctx?: { secret?: string }): void {
    const resolved = ctx?.secret ?? this.secret;
    this.events.onOpen?.(resolved !== undefined ? { secret: resolved } : {});
  }
  simulateMessage(data: string | Uint8Array): void { this.events.onMessage(data); }
  simulateError(err: Error): void { this.events.onError(err); }
  simulateClose(code = 1006, reason = 'abnormal'): void { this.closed = true; this.events.onClose(code, reason); }
}

export class FixtureLocalAccess implements ProviderLocalAccess {
  constructor(private readonly files: Record<string, Uint8Array> = {}, private readonly reachable: Record<string, number> = {}) {}
  async readGrantedFile(path: string): Promise<Uint8Array> {
    const f = this.files[path];
    if (!f) throw new ProviderError('INTERNAL', `no granted file ${path}`, { retryable: false });
    return f;
  }
  async probeLocal(url: string): Promise<{ reachable: boolean; status?: number }> {
    const status = this.reachable[url];
    return status === undefined ? { reachable: false } : { reachable: true, status };
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
    credentials: new MemoryCredentials(new Set(opts.credentials ?? [])),
    cache: new MemoryCache(clock, opts.cacheAllowed ?? true),
    settings: new MemorySettings(opts.settings ?? {}),
    local: opts.local ?? new FixtureLocalAccess(),
    hash: { sha256Hex: (input) => createHash('sha256').update(input).digest('hex') },
    connectivity: { online: () => online },
    setOnline: (v: boolean) => { online = v; },
  };
}
