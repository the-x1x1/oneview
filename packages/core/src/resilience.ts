import type { Clock } from '@worldview/world-model';

/**
 * Resilience primitives shared by the network layer and provider runtime:
 * exponential backoff, sliding-window rate limiter, circuit breaker, single-flight
 * request coalescing, and bounded retry.
 */
export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** 0..1 jitter fraction. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, maxMs: 5 * 60_000, factor: 2, jitter: 0.2 };

export function backoffDelay(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const raw = Math.min(policy.maxMs, policy.baseMs * Math.pow(policy.factor, Math.max(0, attempt)));
  const jitter = raw * policy.jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

/** Sliding-window limiter: at most `max` events per `windowMs` per key, plus a global cap. */
export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly global: number[] = [];
  constructor(private readonly opts: { windowMs: number; max: number; globalMax?: number; maxKeys?: number }, private readonly clock: Clock) {}

  /** Try to consume one slot. Returns ms to wait (0 = allowed now). */
  tryAcquire(key = 'default'): number {
    const now = this.clock.now();
    const cutoff = now - this.opts.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= (this.opts.maxKeys ?? 2000)) this.buckets.delete(this.buckets.keys().next().value as string);
      bucket = [];
      this.buckets.set(key, bucket);
    }
    prune(bucket, cutoff);
    prune(this.global, cutoff);
    if (this.opts.max > 0 && bucket.length >= this.opts.max) return Math.max(1, bucket[0]! + this.opts.windowMs - now);
    if (this.opts.globalMax !== undefined && this.global.length >= this.opts.globalMax) return Math.max(1, this.global[0]! + this.opts.windowMs - now);
    bucket.push(now);
    this.global.push(now);
    return 0;
  }
}

function prune(list: number[], cutoff: number): void {
  let i = 0;
  while (i < list.length && list[i]! <= cutoff) i++;
  if (i > 0) list.splice(0, i);
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker: after `failureThreshold` consecutive failures the circuit opens for
 * `openMs` (doubling up to `maxOpenMs` on repeated trips), then allows one probe.
 */
export class CircuitBreaker {
  private failures = 0;
  private trips = 0;
  private openedAt: number | undefined;
  private probing = false;

  constructor(private readonly opts: { failureThreshold: number; openMs: number; maxOpenMs: number }, private readonly clock: Clock) {}

  state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    if (this.clock.now() - this.openedAt >= this.currentOpenMs()) return 'half-open';
    return 'open';
  }

  private currentOpenMs(): number {
    return Math.min(this.opts.maxOpenMs, this.opts.openMs * Math.pow(2, Math.max(0, this.trips - 1)));
  }

  /** ms until the next attempt is allowed (0 = allowed). */
  retryInMs(): number {
    const st = this.state();
    if (st === 'closed') return 0;
    if (st === 'half-open') return this.probing ? Math.max(1, this.currentOpenMs()) : 0;
    return Math.max(1, this.openedAt! + this.currentOpenMs() - this.clock.now());
  }

  /** Call before an attempt. Returns false when the attempt must be skipped. */
  allow(): boolean {
    const st = this.state();
    if (st === 'closed') return true;
    if (st === 'half-open' && !this.probing) { this.probing = true; return true; }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.trips = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  recordFailure(): void {
    this.failures++;
    this.probing = false;
    if (this.openedAt !== undefined || this.failures >= this.opts.failureThreshold) {
      this.trips++;
      this.openedAt = this.clock.now();
      this.failures = 0;
    }
  }

  reset(): void { this.recordSuccess(); }
}

/** Single-flight coalescing: concurrent callers with the same key share one promise. */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, create: () => Promise<T>): { promise: Promise<T>; shared: boolean } {
    const existing = this.inflight.get(key);
    if (existing) return { promise: existing, shared: true };
    const p = create().finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    return { promise: p, shared: false };
  }

  size(): number { return this.inflight.size; }
}

export interface RetryOptions {
  maxRetries: number;
  backoff?: BackoffPolicy;
  isRetryable: (err: unknown) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (opts.signal?.aborted || attempt >= opts.maxRetries || !opts.isRetryable(err)) throw err;
      const delay = opts.retryAfterMs?.(err) ?? backoffDelay(attempt, opts.backoff);
      opts.onRetry?.(attempt + 1, delay, err);
      await opts.sleep(delay, opts.signal);
      attempt++;
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** Combine signals; also creates a timeout signal. Works on Node 22 and Chromium. */
export function combineSignals(signals: Array<AbortSignal | undefined>, timeoutMs?: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { controller.abort(s.reason); break; }
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const t = setTimeout(() => { const e = new Error(`timeout after ${timeoutMs}ms`); e.name = 'TimeoutError'; controller.abort(e); }, timeoutMs);
    cleanups.push(() => clearTimeout(t));
  }
  return { signal: controller.signal, dispose: () => { for (const c of cleanups) c(); } };
}
