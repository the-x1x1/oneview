import { createHash } from 'node:crypto';
import type { Clock, JsonValue, Observation, GeoBounds } from '@worldview/world-model';
import { systemClock } from '@worldview/world-model';
import {
  ProviderError, admitObservations, manifestSchema, formatIssuesForManifest,
  type ProviderContext, type ProviderHealth, type ProviderManifest, type WorldProvider, type ProviderCache,
  type ProviderCredentials, type ProviderSettings, type ProviderLocalAccess, type ProviderSockets, type ProviderSocketEvents,
  type ProviderSocketHandle, type Unsubscribe,
} from '@worldview/provider-sdk';
import { HttpClient, backoffDelay, sleep, type Logger, type LoggerHub, type CredentialResolver } from '@worldview/core';
import { SourceHealthRegistry } from '@worldview/source-health';

/**
 * @worldview/provider-runtime — hosts providers with isolation.
 *
 * Every provider gets: cancellation, timeout, bounded retries, exponential backoff,
 * rate limiting, circuit breaker (in HttpClient), structured errors and a health
 * state. One provider failure never propagates beyond its own health entry.
 */
export interface ObservationBatch {
  providerId: string;
  observations: Observation[];
  snapshot: boolean;
  receivedAt: string;
  /** Provider-declared freshness overrides. */
  freshness?: ProviderManifest['refreshPolicy']['freshness'];
  rejected: number;
}

export interface ProviderHostDeps {
  clock?: Clock;
  loggerHub: LoggerHub;
  credentials: CredentialResolver & { has(key: string): Promise<boolean>; onChange?(listener: (key: string) => void): Unsubscribe };
  cacheStore: (providerId: string, cacheAllowed: boolean) => ProviderCache;
  settingsStore: (providerId: string) => ProviderSettings;
  localAccess?: (providerId: string, allowedHosts: string[]) => ProviderLocalAccess;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
  userAgent?: string;
  /** Sleep hook for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Cap on observations accepted per batch (defence against runaway feeds). */
  maxBatch?: number;
  /** Disables the polling scheduler; use `pollNow` (tests / CLI). */
  manualScheduling?: boolean;
}

interface Hosted {
  provider: WorldProvider;
  manifest: ProviderManifest;
  enabled: boolean;
  initialized: boolean;
  running: boolean;
  http: HttpClient;
  logger: Logger;
  consecutiveFailures: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: AbortController | undefined;
  unsubscribe: Unsubscribe | undefined;
  lastPollAt: number;
  polling: boolean;
}

export class ProviderHost {
  readonly health: SourceHealthRegistry;
  private readonly hosted = new Map<string, Hosted>();
  private readonly sinks = new Set<(batch: ObservationBatch) => void>();
  private readonly clock: Clock;
  private readonly log: Logger;
  private online = true;
  private viewport: GeoBounds | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly deps: ProviderHostDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.loggerHub.logger('provider');
    this.health = new SourceHealthRegistry(this.clock);
    deps.credentials.onChange?.((key) => this.onCredentialChange(key));
  }

  /** Register a provider. Manifest is validated; excluded providers are refused. */
  register(provider: WorldProvider, opts: { enabled?: boolean } = {}): void {
    const parsed = manifestSchema.parse(provider.manifest);
    if (!parsed.ok) throw new Error(`provider manifest invalid: ${formatIssuesForManifest(parsed.issues)}`);
    const manifest = parsed.value;
    if (this.hosted.has(manifest.id)) throw new Error(`provider ${manifest.id} already registered`);
    const enabled = opts.enabled ?? manifest.enabledByDefault;
    const logger = this.log.child({ providerId: manifest.id });
    const http = new HttpClient({
      allowedHosts: manifest.allowedHosts,
      clock: this.clock,
      logger,
      credentials: this.deps.credentials,
      defaultTimeoutMs: manifest.refreshPolicy.timeoutMs,
      maxTimeoutMs: Math.max(manifest.refreshPolicy.timeoutMs, 60_000),
      maxRetries: Math.min(manifest.refreshPolicy.maxRetries, 3),
      requestsPerMinute: manifest.refreshPolicy.maxRequestsPerMinute,
      staleWhileErrorMs: manifest.dataPolicy.cacheAllowed ? manifest.refreshPolicy.staleWhileErrorMs : 0,
      cacheEnabled: manifest.dataPolicy.cacheAllowed,
      online: () => this.online || manifest.transport === 'local-process' || manifest.transport === 'hardware' || manifest.transport === 'filesystem',
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.userAgent ? { userAgent: this.deps.userAgent } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.hosted.set(manifest.id, { provider, manifest, enabled, initialized: false, running: false, http, logger, consecutiveFailures: 0, timer: undefined, abort: undefined, unsubscribe: undefined, lastPollAt: 0, polling: false });
    this.health.register(manifest, { enabled });
    if (this.started && enabled) void this.startProvider(manifest.id);
  }

  onObservations(sink: (batch: ObservationBatch) => void): Unsubscribe {
    this.sinks.add(sink);
    return () => { this.sinks.delete(sink); };
  }

  list(): Array<{ manifest: ProviderManifest; enabled: boolean; running: boolean }> {
    return [...this.hosted.values()].map((h) => ({ manifest: h.manifest, enabled: h.enabled, running: h.running }));
  }

  manifest(providerId: string): ProviderManifest | undefined { return this.hosted.get(providerId)?.manifest; }

  async start(): Promise<void> {
    this.started = true;
    await Promise.all([...this.hosted.keys()].map((id) => this.hosted.get(id)!.enabled ? this.startProvider(id) : Promise.resolve()));
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.hosted.keys()].map((id) => this.stopProvider(id)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    this.sinks.clear();
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<void> {
    const h = this.hosted.get(providerId);
    if (!h || h.enabled === enabled) return;
    h.enabled = enabled;
    this.health.setEnabled(providerId, enabled);
    if (enabled && this.started) await this.startProvider(providerId);
    else if (!enabled) await this.stopProvider(providerId);
  }

  /** Application connectivity changed (from the desktop shell / connectivity monitor). */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.health.setNetworkOnline(online);
    for (const h of this.hosted.values()) {
      if (!h.running || !isRemote(h.manifest)) continue;
      if (!online) {
        this.cancelPoll(h);
        const current = this.health.get(h.manifest.id)?.health;
        if (current) this.health.update({ ...current, status: 'OFFLINE', message: 'network offline' });
      } else {
        h.consecutiveFailures = 0;
        this.schedule(h, 0);
      }
    }
  }

  isOnline(): boolean { return this.online; }

  /** Viewport hint for boundsQuery providers. Triggers an early poll when the view moved significantly. */
  setViewport(bounds: GeoBounds | undefined): void {
    const moved = !this.viewport || !bounds || Math.abs(bounds.west - this.viewport.west) > 1 || Math.abs(bounds.east - this.viewport.east) > 1 || Math.abs(bounds.north - this.viewport.north) > 1 || Math.abs(bounds.south - this.viewport.south) > 1;
    this.viewport = bounds;
    if (!moved) return;
    for (const h of this.hosted.values()) {
      if (h.running && h.manifest.capabilities.boundsQuery && !h.polling && this.clock.now() - h.lastPollAt > Math.max(h.manifest.refreshPolicy.minIntervalMs, 5000)) this.schedule(h, 250);
    }
  }

  /** Poll one provider immediately (tests, CLI, user refresh). */
  async pollNow(providerId: string): Promise<ObservationBatch | undefined> {
    const h = this.hosted.get(providerId);
    if (!h || !h.running) return undefined;
    return this.poll(h);
  }

  async healthOf(providerId: string): Promise<ProviderHealth | undefined> {
    return this.hosted.get(providerId)?.provider.health();
  }

  // ---- internals ------------------------------------------------------------

  private context(h: Hosted): ProviderContext {
    const manifest = h.manifest;
    const sockets: ProviderSockets = {
      open: (url, events, opts) => this.openSocket(h, url, events, opts),
    };
    return {
      providerId: manifest.id,
      clock: this.clock,
      logger: h.logger,
      http: h.http,
      sockets,
      credentials: { has: (key) => this.deps.credentials.has(key) } satisfies ProviderCredentials,
      cache: this.deps.cacheStore(manifest.id, manifest.dataPolicy.cacheAllowed),
      settings: this.deps.settingsStore(manifest.id),
      local: this.deps.localAccess?.(manifest.id, manifest.allowedHosts) ?? deniedLocalAccess(),
      hash: { sha256Hex: (input) => createHash('sha256').update(input).digest('hex') },
      connectivity: { online: () => this.online },
    };
  }

  private async startProvider(id: string): Promise<void> {
    const h = this.hosted.get(id);
    if (!h || h.running || this.disposed) return;
    try {
      if (!h.initialized) { await h.provider.initialize(this.context(h)); h.initialized = true; }
      await h.provider.start();
      h.running = true;
      h.consecutiveFailures = 0;
      if (h.provider.subscribe) await this.openSubscription(h);
      if (h.provider.query) this.schedule(h, 0);
      else await this.publishHealth(h);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      h.logger.error('provider failed to start', { code: pe.code, message: pe.message });
      await this.publishHealth(h, { status: 'ERROR', message: pe.message, lastError: pe.toInfo(new Date(this.clock.now()).toISOString()) });
    }
  }

  private async stopProvider(id: string): Promise<void> {
    const h = this.hosted.get(id);
    if (!h) return;
    this.cancelPoll(h);
    if (h.unsubscribe) { try { h.unsubscribe(); } catch { /* ignore */ } h.unsubscribe = undefined; }
    if (h.running) {
      h.running = false;
      try { await h.provider.stop(); } catch (err) { h.logger.warn('provider stop failed', { message: String(err) }); }
    }
    await this.publishHealth(h, { status: h.enabled ? 'STARTING' : 'DISABLED' });
  }

  private schedule(h: Hosted, delayMs: number): void {
    if (this.deps.manualScheduling || !h.running || this.disposed) return;
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => { h.timer = undefined; void this.poll(h); }, delayMs);
    if (typeof h.timer === 'object' && 'unref' in h.timer) (h.timer as { unref(): void }).unref();
  }

  private cancelPoll(h: Hosted): void {
    if (h.timer) { clearTimeout(h.timer); h.timer = undefined; }
    h.abort?.abort();
    h.abort = undefined;
  }

  private async poll(h: Hosted): Promise<ObservationBatch | undefined> {
    if (!h.running || !h.provider.query || h.polling) return undefined;
    if (isRemote(h.manifest) && !this.online) { await this.publishHealth(h, { status: 'OFFLINE', message: 'network offline' }); return undefined; }
    h.polling = true;
    h.lastPollAt = this.clock.now();
    const abort = new AbortController();
    h.abort = abort;
    const budget = h.manifest.refreshPolicy.timeoutMs * (h.manifest.refreshPolicy.maxRetries + 1) + 5000;
    const timeout = setTimeout(() => abort.abort(new ProviderError('TIMEOUT', `poll exceeded ${budget}ms`)), budget);
    try {
      const observations = await h.provider.query({ signal: abort.signal, background: true, ...(this.viewport && h.manifest.capabilities.boundsQuery ? { bounds: this.viewport } : {}) });
      const batch = this.admit(h, observations, true);
      h.consecutiveFailures = 0;
      await this.publishHealth(h);
      this.schedule(h, Math.max(h.manifest.refreshPolicy.intervalMs, h.manifest.refreshPolicy.minIntervalMs));
      return batch;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      if (pe.code === 'CANCELLED') return undefined;
      h.consecutiveFailures++;
      h.logger.warn('poll failed', { code: pe.code, message: pe.message, consecutiveFailures: h.consecutiveFailures });
      await this.publishHealth(h);
      const base = pe.retryAfterMs ?? backoffDelay(h.consecutiveFailures - 1, { baseMs: Math.max(5000, h.manifest.refreshPolicy.intervalMs / 4), maxMs: 15 * 60_000, factor: 2, jitter: 0.2 });
      const delay = pe.code === 'AUTH' || pe.code === 'HOST_NOT_ALLOWED' ? Number.POSITIVE_INFINITY : Math.max(base, h.manifest.refreshPolicy.minIntervalMs);
      if (Number.isFinite(delay)) this.schedule(h, delay);
      return undefined;
    } finally {
      clearTimeout(timeout);
      h.polling = false;
      if (h.abort === abort) h.abort = undefined;
    }
  }

  private admit(h: Hosted, raw: unknown[], snapshot: boolean): ObservationBatch {
    const max = this.deps.maxBatch ?? 250_000;
    const sliced = raw.length > max ? raw.slice(0, max) : raw;
    const { accepted, rejected } = admitObservations(sliced);
    const wrongProvider = accepted.filter((o) => o.providerId !== h.manifest.id).length;
    const observations = wrongProvider ? accepted.filter((o) => o.providerId === h.manifest.id) : accepted;
    if (rejected.length || wrongProvider) h.logger.warn('rejected observations', { rejected: rejected.length + wrongProvider, sample: rejected.slice(0, 3).map((r) => r.reason) });
    const batch: ObservationBatch = {
      providerId: h.manifest.id,
      observations,
      snapshot,
      receivedAt: new Date(this.clock.now()).toISOString(),
      rejected: rejected.length + wrongProvider + (raw.length - sliced.length),
      ...(h.manifest.refreshPolicy.freshness ? { freshness: h.manifest.refreshPolicy.freshness } : {}),
    };
    for (const sink of [...this.sinks]) {
      try { sink(batch); } catch (err) { this.log.error('observation sink threw', { message: err instanceof Error ? err.message : String(err) }); }
    }
    return batch;
  }

  private async openSubscription(h: Hosted): Promise<void> {
    if (!h.provider.subscribe) return;
    const abort = new AbortController();
    h.abort = abort;
    try {
      const unsub = await h.provider.subscribe(
        { signal: abort.signal, ...(this.viewport ? { bounds: this.viewport } : {}) },
        (observations, meta) => { if (h.running) { this.admit(h, observations, meta?.snapshot ?? false); void this.publishHealth(h); } },
      );
      h.unsubscribe = () => { abort.abort(); unsub(); };
      await this.publishHealth(h);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      h.consecutiveFailures++;
      await this.publishHealth(h, { status: pe.code === 'AUTH' ? 'AUTH_REQUIRED' : 'ERROR', message: pe.message, lastError: pe.toInfo(new Date(this.clock.now()).toISOString()) });
      if (pe.code !== 'AUTH' && !this.deps.manualScheduling) {
        const delay = backoffDelay(h.consecutiveFailures - 1, { baseMs: 5000, maxMs: 5 * 60_000, factor: 2, jitter: 0.2 });
        h.timer = setTimeout(() => { h.timer = undefined; if (h.running) void this.openSubscription(h); }, delay);
      }
    }
  }

  private async openSocket(h: Hosted, url: string, events: ProviderSocketEvents, opts?: { headers?: Record<string, string>; maxMessageBytes?: number; signal?: AbortSignal }): Promise<ProviderSocketHandle> {
    if (!h.http.isHostAllowed(url) || !/^wss:/.test(url)) throw new ProviderError('HOST_NOT_ALLOWED', 'websocket host not allowed (wss only, allowlisted hosts)', { retryable: false });
    if (!this.online) throw new ProviderError('OFFLINE', 'application offline');
    const Impl = this.deps.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Impl) throw new ProviderError('UNSUPPORTED', 'WebSocket not available in this runtime', { retryable: false });
    const maxBytes = opts?.maxMessageBytes ?? 1024 * 1024;
    const ws = new Impl(url);
    ws.binaryType = 'arraybuffer';
    let closed = false;
    const finish = (code: number, reason: string) => { if (!closed) { closed = true; events.onClose(code, reason); } };
    ws.onopen = () => events.onOpen?.();
    ws.onmessage = (ev: MessageEvent) => {
      const data = ev.data as string | ArrayBuffer;
      const size = typeof data === 'string' ? data.length : data.byteLength;
      if (size > maxBytes) { h.logger.warn('websocket message dropped (too large)', { size }); return; }
      events.onMessage(typeof data === 'string' ? data : new Uint8Array(data));
    };
    ws.onerror = () => events.onError(new ProviderError('NETWORK', 'websocket error'));
    ws.onclose = (ev: CloseEvent) => finish(ev.code, ev.reason);
    opts?.signal?.addEventListener('abort', () => { try { ws.close(1000, 'cancelled'); } catch { /* ignore */ } finish(1000, 'cancelled'); }, { once: true });
    return { send: (d) => ws.send(typeof d === 'string' ? d : (d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)), close: (code, reason) => { try { ws.close(code, reason); } catch { /* ignore */ } } };
  }

  private async publishHealth(h: Hosted, override?: Partial<ProviderHealth>): Promise<void> {
    let health: ProviderHealth;
    try { health = await h.provider.health(); } catch { health = { providerId: h.manifest.id, status: 'ERROR', errorRate: 1, rateLimitState: { limited: false }, credentialState: 'not-required', message: 'health() threw' }; }
    if (!h.running && health.status !== 'DISABLED') health = { ...health, status: h.enabled ? 'STARTING' : 'DISABLED' };
    if (h.running && isRemote(h.manifest) && !this.online) health = { ...health, status: 'OFFLINE', message: 'network offline' };
    health = { ...health, ...override, providerId: h.manifest.id };
    this.health.update(health);
  }

  private onCredentialChange(key: string): void {
    for (const h of this.hosted.values()) {
      if (h.manifest.credentials.some((c) => c.key === key) && h.running) { h.consecutiveFailures = 0; this.schedule(h, 0); }
    }
  }
}

function isRemote(m: ProviderManifest): boolean {
  return m.transport === 'http' || m.transport === 'websocket';
}

function deniedLocalAccess(): ProviderLocalAccess {
  return {
    readGrantedFile: async () => { throw new ProviderError('UNSUPPORTED', 'no local access granted', { retryable: false }); },
    probeLocal: async () => ({ reachable: false }),
  };
}

export type { ProviderCache, ProviderSettings, JsonValue };
