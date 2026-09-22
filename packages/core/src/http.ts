import type { Clock } from '@worldview/world-model';
import { ProviderError, type ProviderHttpRequest, type ProviderHttpResponse } from '@worldview/provider-sdk';
import { RateLimiter, CircuitBreaker, SingleFlight, withRetry, sleep, combineSignals } from './resilience.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

/**
 * Centralized network layer (directive §90–91). Every outbound HTTP request in
 * WORLDVIEW goes through an HttpClient:
 *
 *  - host allowlist (per client; providers get their manifest.allowedHosts)
 *  - AbortSignal + timeout
 *  - response size cap (streamed; decompression happens before the cap so the cap
 *    bounds decoded bytes)
 *  - ETag / If-Modified-Since conditional requests with an in-memory body cache
 *  - client-side rate limiting, bounded retry with exponential backoff
 *  - circuit breaker per host
 *  - single-flight coalescing of identical concurrent requests
 *  - stale-on-error fallback bounded by `staleWhileErrorMs`
 *  - credential injection by key (the caller never sees the secret)
 */
export interface CredentialResolver {
  get(key: string): Promise<string | undefined>;
}

export interface HttpClientOptions {
  allowedHosts: string[];
  clock: Clock;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  credentials?: CredentialResolver;
  userAgent?: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxBytes?: number;
  hardMaxBytes?: number;
  maxRetries?: number;
  requestsPerMinute?: number;
  staleWhileErrorMs?: number;
  cacheEnabled?: boolean;
  /** Returns false to fail fast with OFFLINE (application-level connectivity state). */
  online?: () => boolean;
  /** Test hook: how to sleep between retries. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

interface CacheEntry {
  etag?: string;
  lastModified?: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  storedAt: number;
  /** The previously accepted entry, restored if this one is invalidated by the consumer. */
  previousGood?: CacheEntry;
}

export interface HttpClientStats {
  requests: number;
  coalesced: number;
  cacheHits: number;
  notModified: number;
  staleServed: number;
  failures: number;
  rateLimitedWaits: number;
}

export class HttpClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new SingleFlight<ProviderHttpResponse>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly limiter: RateLimiter;
  private readonly logger: Logger;
  readonly stats: HttpClientStats = {
    requests: 0,
    coalesced: 0,
    cacheHits: 0,
    notModified: 0,
    staleServed: 0,
    failures: 0,
    rateLimitedWaits: 0,
  };

  constructor(private readonly opts: HttpClientOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.limiter = new RateLimiter({ windowMs: 60_000, max: opts.requestsPerMinute ?? 120 }, opts.clock);
  }

  isHostAllowed(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return this.opts.allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
  }

  private breaker(host: string): CircuitBreaker {
    let b = this.breakers.get(host);
    if (!b) {
      b = new CircuitBreaker({ failureThreshold: 3, openMs: 30_000, maxOpenMs: 10 * 60_000 }, this.opts.clock);
      this.breakers.set(host, b);
    }
    return b;
  }

  async request(req: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      throw new ProviderError('INTERNAL', `invalid url`, { retryable: false });
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
      throw new ProviderError('HOST_NOT_ALLOWED', `only https (or http to loopback) is allowed`, { retryable: false });
    }
    if (!this.isHostAllowed(req.url))
      throw new ProviderError('HOST_NOT_ALLOWED', `host ${parsed.hostname} is not in the allowlist`, {
        retryable: false,
      });
    if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'cancelled');

    const key = req.cacheKey ?? `${req.method ?? 'GET'} ${req.url}`;
    const { promise, shared } = this.inflight.run(key, () => this.execute(req, parsed, key));
    if (shared) this.stats.coalesced++;
    return promise;
  }

  private async execute(req: ProviderHttpRequest, parsed: URL, key: string): Promise<ProviderHttpResponse> {
    const clock = this.opts.clock;
    const host = parsed.hostname.toLowerCase();
    const breaker = this.breaker(host);
    const cached = this.opts.cacheEnabled === false ? undefined : this.cache.get(key);
    const staleMs = this.opts.staleWhileErrorMs ?? 0;

    const serveStale = (err: ProviderError): ProviderHttpResponse => {
      if (req.allowStale !== false && cached && staleMs > 0 && clock.now() - cached.storedAt <= staleMs) {
        this.stats.staleServed++;
        this.logger.warn('serving stale response after failure', {
          host,
          code: err.code,
          ageMs: clock.now() - cached.storedAt,
        });
        return toResponse(cached, { fromCache: true, stale: true, ageMs: clock.now() - cached.storedAt, latencyMs: 0 });
      }
      throw err;
    };

    if (this.opts.online && !this.opts.online())
      return serveStale(new ProviderError('OFFLINE', 'application is offline'));
    if (!breaker.allow())
      return serveStale(
        new ProviderError('NETWORK', `circuit open for ${host}; retry in ${breaker.retryInMs()}ms`, {
          retryAfterMs: breaker.retryInMs(),
        }),
      );

    const wait = this.limiter.tryAcquire(host);
    if (wait > 0) {
      this.stats.rateLimitedWaits++;
      if (wait > 10_000)
        return serveStale(new ProviderError('RATE_LIMITED', `client rate limit for ${host}`, { retryAfterMs: wait }));
      await (this.opts.sleep ?? sleep)(wait, req.signal);
    }

    const timeoutMs = Math.min(
      req.timeoutMs ?? this.opts.defaultTimeoutMs ?? 15_000,
      this.opts.maxTimeoutMs ?? 120_000,
    );
    const maxBytes = Math.min(
      req.maxBytes ?? this.opts.defaultMaxBytes ?? 8 * 1024 * 1024,
      this.opts.hardMaxBytes ?? 64 * 1024 * 1024,
    );

    const attemptOnce = async (): Promise<ProviderHttpResponse> => {
      this.stats.requests++;
      const headers: Record<string, string> = { ...(this.opts.headers ?? {}), ...(req.headers ?? {}) };
      if (this.opts.userAgent && !hasHeader(headers, 'user-agent')) headers['User-Agent'] = this.opts.userAgent;
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      else if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

      let url = req.url;
      if (req.credential) {
        const secret = await this.opts.credentials?.get(req.credential.key);
        if (!secret)
          throw new ProviderError('AUTH', `credential ${req.credential.key} not configured`, { retryable: false });
        if (req.credential.as === 'query') {
          const u = new URL(url);
          u.searchParams.set(req.credential.name ?? 'key', secret);
          url = u.toString();
        } else if (req.credential.as === 'bearer') headers['Authorization'] = `Bearer ${secret}`;
        else if (req.credential.as === 'path')
          url = substitutePathCredential(url, req.credential.name ?? 'TOKEN', secret);
        else headers[req.credential.name ?? 'X-API-Key'] = secret;
      }

      const { signal, dispose } = combineSignals([req.signal], timeoutMs);
      const started = clock.now();
      try {
        const fetchImpl = this.opts.fetchImpl ?? fetch;
        const init: RequestInit = { method: req.method ?? 'GET', headers, signal, redirect: 'manual' };
        if (req.body !== undefined) init.body = req.body as string;
        const res = await fetchImpl(url, init);
        const latencyMs = clock.now() - started;
        if (res.status === 304 && cached) {
          this.stats.notModified++;
          cached.storedAt = clock.now();
          return toResponse(cached, { fromCache: true, stale: false, ageMs: 0, latencyMs });
        }
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          throw new ProviderError('HTTP_4XX', `redirect to ${location ? safeHost(location) : 'unknown'} not followed`, {
            httpStatus: res.status,
            retryable: false,
          });
        }
        if (res.status === 429) {
          const ra = parseRetryAfter(res.headers.get('retry-after'), clock.now());
          throw new ProviderError('RATE_LIMITED', 'HTTP 429', { httpStatus: 429, retryAfterMs: ra ?? 45_000 });
        }
        if (res.status === 401 || res.status === 403)
          throw new ProviderError('AUTH', `HTTP ${res.status}`, { httpStatus: res.status, retryable: false });
        if (res.status >= 500) throw new ProviderError('HTTP_5XX', `HTTP ${res.status}`, { httpStatus: res.status });
        if (res.status >= 400)
          throw new ProviderError('HTTP_4XX', `HTTP ${res.status}`, { httpStatus: res.status, retryable: false });

        const body = await readCapped(res, maxBytes, signal);
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          respHeaders[k.toLowerCase()] = v;
        });
        const entry: CacheEntry = { status: res.status, headers: respHeaders, body, storedAt: clock.now() };
        const etag = res.headers.get('etag');
        const lm = res.headers.get('last-modified');
        if (etag) entry.etag = etag;
        if (lm) entry.lastModified = lm;
        const cacheable = this.opts.cacheEnabled !== false && (req.method ?? 'GET') === 'GET';
        if (cacheable) {
          const prev = this.cache.get(key);
          if (prev) {
            entry.previousGood = prev;
            delete prev.previousGood;
          }
          this.cache.set(key, entry);
        }
        return toResponse(entry, { fromCache: false, stale: false, ageMs: 0, latencyMs }, () => {
          if (!cacheable || this.cache.get(key) !== entry) return;
          if (entry.previousGood) this.cache.set(key, entry.previousGood);
          else this.cache.delete(key);
        });
      } catch (err) {
        const pe = classify(err);
        if (countsForBreaker(pe)) breaker.recordFailure();
        throw pe;
      } finally {
        dispose();
      }
    };

    try {
      const result = await withRetry(attemptOnce, {
        maxRetries: this.opts.maxRetries ?? 2,
        isRetryable: (e) =>
          e instanceof ProviderError && e.retryable && e.code !== 'RATE_LIMITED' && e.code !== 'CANCELLED',
        sleep: this.opts.sleep ?? sleep,
        ...(req.signal ? { signal: req.signal } : {}),
        onRetry: (attempt, delayMs, e) =>
          this.logger.debug('retrying request', {
            host,
            attempt,
            delayMs,
            code: e instanceof ProviderError ? e.code : 'unknown',
          }),
      });
      breaker.recordSuccess();
      return result;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : classify(err);
      this.stats.failures++;
      if (pe.code === 'CANCELLED') throw pe;
      return serveStale(pe);
    }
  }

  cacheSize(): number {
    return this.cache.size;
  }
  clearCache(): void {
    this.cache.clear();
  }
}

function countsForBreaker(e: ProviderError): boolean {
  return e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'DNS' || e.code === 'HTTP_5XX';
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name);
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

/**
 * `credential.as: 'path'` — replace every `{NAME}` placeholder in the *path* with the
 * percent-encoded secret (ADR-003). The placeholder must appear in the path, never in
 * the host or the query, so a secret can neither move the request to another host nor
 * be logged through a query string. Encoding is per path segment: `encodeURIComponent`
 * escapes `/`, `?` and `#`, so a secret can never introduce new segments.
 */
export function substitutePathCredential(url: string, name: string, secret: string): string {
  const placeholder = `{${name}}`;
  const origin = new URL(url).origin;
  const rest = url.slice(url.indexOf(origin) + origin.length);
  const queryAt = Math.min(...[rest.indexOf('?'), rest.indexOf('#')].filter((i) => i >= 0).concat([rest.length]));
  const pathPart = rest.slice(0, queryAt);
  if (!pathPart.includes(placeholder)) {
    throw new ProviderError('INTERNAL', `credential placeholder ${placeholder} is not present in the request path`, {
      retryable: false,
    });
  }
  return origin + pathPart.split(placeholder).join(encodeURIComponent(secret)) + rest.slice(queryAt);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ProviderError('TOO_LARGE', `content-length ${declared} exceeds ${maxBytes}`, { retryable: false });
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new ProviderError('TOO_LARGE', `response exceeded ${maxBytes} bytes`, { retryable: false });
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function toResponse(
  entry: CacheEntry,
  meta: { fromCache: boolean; stale: boolean; ageMs: number; latencyMs: number },
  invalidate: () => void = () => {},
): ProviderHttpResponse {
  let textCache: string | undefined;
  const text = () => (textCache ??= new TextDecoder().decode(entry.body));
  return {
    status: entry.status,
    headers: entry.headers,
    text,
    json: () => JSON.parse(text()) as unknown,
    bytes: () => entry.body,
    ...meta,
    invalidate,
  };
}

function classify(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'TimeoutError') return new ProviderError('TIMEOUT', 'request timed out', { cause: err });
  if (name === 'AbortError') return new ProviderError('CANCELLED', 'cancelled', { cause: err });
  const message =
    err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}` : String(err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message))
    return new ProviderError('DNS', 'dns lookup failed', { cause: err });
  if (/timeout|timed out/i.test(message)) return new ProviderError('TIMEOUT', 'request timed out', { cause: err });
  return new ProviderError('NETWORK', message.slice(0, 200), { cause: err });
}
