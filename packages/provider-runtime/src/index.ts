import { createHash } from 'node:crypto';
import type { Clock, JsonValue, Observation, GeoBounds, RasterOverlay } from '@worldview/world-model';
import { MAX_OVERLAYS_PER_PROVIDER, overlayHost, rasterOverlaySchema, systemClock } from '@worldview/world-model';
import {
  ProviderError,
  admitObservations,
  manifestSchema,
  isNameableHost,
  formatIssuesForManifest,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type RefreshPolicy,
  type WorldProvider,
  type ProviderCache,
  type ProviderCredentials,
  type ProviderSettings,
  type ProviderLocalAccess,
  type LocalListenerHandle,
  type ProviderMqtt,
  type ProviderSockets,
  type ProviderSocketEvents,
  type ProviderSocketHandle,
  type ProviderSocketOptions,
  type Unsubscribe,
} from '@worldview/provider-sdk';
import { HttpClient, backoffDelay, type Logger, type LoggerHub, type CredentialResolver } from '@worldview/core';
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
  credentials: CredentialResolver & {
    has(key: string): Promise<boolean>;
    onChange?(listener: (key: string) => void): Unsubscribe;
  };
  cacheStore: (providerId: string, cacheAllowed: boolean) => ProviderCache;
  settingsStore: (providerId: string) => ProviderSettings;
  localAccess?: (
    providerId: string,
    allowedHosts: string[],
    trustedHosts: () => readonly string[],
    /** The folder the user named in the manifest's `grantedFolderSetting`, while it names one. */
    grantedFolder: () => string | undefined,
    /**
     * Whether the manifest declares a `grantedFolderSetting` (ADR-003 amendment): then the
     * folder the user named is the only grant — no fallback to the bundled resources, and
     * nothing at all while the setting is empty — and the host may offer `ogr2ogr` on it.
     */
    grantedFolderDeclared: boolean,
  ) => ProviderLocalAccess;
  /**
   * MQTT for local transports (ADR-003 amendment 2026-09-23): the runtime's client, scoped to
   * loopback hosts in the manifest and the trusted host, with the provider's own credential
   * keys. Absent → providers get no `mqtt` on their context.
   */
  mqtt?: (
    providerId: string,
    allowedHosts: string[],
    trustedHosts: () => readonly string[],
    resolveSecret: (key: string) => Promise<string | undefined>,
  ) => ProviderMqtt;
  /**
   * The loopback listener (ADR-003 amendment 2026-09-23, for phase `ingest`): offered as
   * `local.listen` to `local-process` providers only, with the provider's own credential
   * keys; the host keeps one listener per provider and closes it when the provider stops.
   * Absent → providers get no `listen`.
   */
  listen?: (
    providerId: string,
    resolveSecret: (key: string) => Promise<string | undefined>,
  ) => NonNullable<ProviderLocalAccess['listen']>;
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
  trusted: { hosts: readonly string[] };
  granted: { folder: string | undefined };
  logger: Logger;
  consecutiveFailures: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: AbortController | undefined;
  unsubscribe: Unsubscribe | undefined;
  lastPollAt: number;
  polling: boolean;
  /** Raster overlays the provider published (ADR-008); empty while it is not running. */
  overlays: RasterOverlay[];
  /** The provider's loopback listener while it runs (ADR-003 `listen`); closed on stop. */
  listener: LocalListenerHandle | undefined;
}

export class ProviderHost {
  readonly health: SourceHealthRegistry;
  private readonly hosted = new Map<string, Hosted>();
  private readonly sinks = new Set<(batch: ObservationBatch) => void>();
  private readonly overlaySinks = new Set<(overlays: RasterOverlay[]) => void>();
  private readonly clock: Clock;
  private readonly log: Logger;
  private online = true;
  private viewport: GeoBounds | undefined;
  private viewportCenter: { latitude: number; longitude: number } | undefined;
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
    // The one host the user named in this provider's trustedHostSetting (ADR-003), kept
    // current from its settings; read by the HTTP client and the local probe on each use.
    const trusted: { hosts: readonly string[] } = { hosts: [] };
    if (manifest.trustedHostSetting) this.watchTrustedHost(manifest, trusted, logger);
    // The one folder the user named in this provider's grantedFolderSetting (ADR-003), kept
    // current from its settings; read by the local access on each file read.
    const granted: { folder: string | undefined } = { folder: undefined };
    if (manifest.grantedFolderSetting) this.watchGrantedFolder(manifest, granted, logger);
    const http = new HttpClient({
      allowedHosts: manifest.allowedHosts,
      trustedHosts: () => trusted.hosts,
      clock: this.clock,
      logger,
      // Only the keys this provider declares: a request naming another provider's key is
      // sent without it (and fails as unauthenticated), as sockets already refuse (below).
      credentials: scopedCredentials(
        this.deps.credentials,
        manifest.credentials.map((c) => c.key),
      ),
      defaultTimeoutMs: manifest.refreshPolicy.timeoutMs,
      maxTimeoutMs: Math.max(manifest.refreshPolicy.timeoutMs, 60_000),
      maxRetries: Math.min(manifest.refreshPolicy.maxRetries, 3),
      requestsPerMinute: manifest.refreshPolicy.maxRequestsPerMinute,
      staleWhileErrorMs: manifest.dataPolicy.cacheAllowed ? manifest.refreshPolicy.staleWhileErrorMs : 0,
      cacheEnabled: manifest.dataPolicy.cacheAllowed,
      online: () =>
        this.online ||
        manifest.transport === 'local-process' ||
        manifest.transport === 'hardware' ||
        manifest.transport === 'filesystem',
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.userAgent ? { userAgent: this.deps.userAgent } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.hosted.set(manifest.id, {
      provider,
      manifest,
      enabled,
      initialized: false,
      running: false,
      http,
      trusted,
      granted,
      logger,
      consecutiveFailures: 0,
      timer: undefined,
      abort: undefined,
      unsubscribe: undefined,
      lastPollAt: 0,
      polling: false,
      overlays: [],
      listener: undefined,
    });
    this.health.register(manifest, { enabled });
    if (this.started && enabled) void this.startProvider(manifest.id);
  }

  onObservations(sink: (batch: ObservationBatch) => void): Unsubscribe {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  /** Called with the full list whenever a provider's overlays appear, change or go away. */
  onOverlays(sink: (overlays: RasterOverlay[]) => void): Unsubscribe {
    this.overlaySinks.add(sink);
    return () => {
      this.overlaySinks.delete(sink);
    };
  }

  /** Every overlay of every running provider, in registration order. */
  overlays(): RasterOverlay[] {
    const out: RasterOverlay[] = [];
    for (const h of this.hosted.values()) if (h.running) out.push(...h.overlays);
    return out;
  }

  /**
   * Ask a running provider for its overlays again (the source's catalogue changed, a
   * setting changed). Each descriptor is validated, given the provider's id, and refused
   * when its host is not one the manifest allows — the same allow-list the HTTP client
   * enforces, so a provider cannot point the renderer at a host it may not reach itself.
   */
  async refreshOverlays(providerId: string): Promise<RasterOverlay[]> {
    const h = this.hosted.get(providerId);
    if (!h || !h.running || !h.provider.overlays) return [];
    let published: RasterOverlay[] = [];
    try {
      published = await h.provider.overlays();
    } catch (err) {
      h.logger.warn('overlays failed', { message: err instanceof Error ? err.message : String(err) });
      published = [];
    }
    const accepted: RasterOverlay[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of published.slice(0, MAX_OVERLAYS_PER_PROVIDER).entries()) {
      const parsed = rasterOverlaySchema.parse({ ...(raw as object), providerId: h.manifest.id });
      if (!parsed.ok) {
        h.logger.warn('overlay rejected', { index: i, reason: parsed.issues[0]?.message ?? 'invalid' });
        continue;
      }
      const o = parsed.value;
      const host = overlayHost(o);
      if (!h.manifest.allowedHosts.some((a) => a.toLowerCase() === host)) {
        h.logger.warn('overlay rejected', { id: o.id, reason: `host ${host} is not in allowedHosts` });
        continue;
      }
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      accepted.push(o);
    }
    if (published.length > MAX_OVERLAYS_PER_PROVIDER)
      h.logger.warn('overlays truncated', { published: published.length, kept: MAX_OVERLAYS_PER_PROVIDER });
    this.setOverlays(h, accepted);
    return accepted;
  }

  private setOverlays(h: Hosted, overlays: RasterOverlay[]): void {
    const same =
      overlays.length === h.overlays.length &&
      overlays.every((o, i) => JSON.stringify(o) === JSON.stringify(h.overlays[i]));
    h.overlays = overlays;
    if (same) return;
    const all = this.overlays();
    for (const sink of this.overlaySinks) {
      try {
        sink(all);
      } catch (err) {
        this.log.warn('overlay sink failed', { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  list(): Array<{ manifest: ProviderManifest; enabled: boolean; running: boolean }> {
    return [...this.hosted.values()].map((h) => ({ manifest: h.manifest, enabled: h.enabled, running: h.running }));
  }

  manifest(providerId: string): ProviderManifest | undefined {
    return this.hosted.get(providerId)?.manifest;
  }

  async start(): Promise<void> {
    this.started = true;
    await Promise.all(
      [...this.hosted.keys()].map((id) => (this.hosted.get(id)!.enabled ? this.startProvider(id) : Promise.resolve())),
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.hosted.keys()].map((id) => this.stopProvider(id)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    this.sinks.clear();
    this.overlaySinks.clear();
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

  isOnline(): boolean {
    return this.online;
  }

  /**
   * Viewport hint for boundsQuery providers, with the point the view is centred on. Triggers
   * an early poll when the view moved significantly — its edges, or (a globe-wide view, whose
   * bounds are the whole world however it turns) its centre, by more than a degree.
   */
  setViewport(bounds: GeoBounds | undefined, center?: { latitude: number; longitude: number }): void {
    const centreMoved =
      !center !== !this.viewportCenter ||
      (center !== undefined &&
        this.viewportCenter !== undefined &&
        (Math.abs(center.latitude - this.viewportCenter.latitude) > 1 ||
          Math.abs(center.longitude - this.viewportCenter.longitude) > 1));
    const moved =
      !this.viewport ||
      !bounds ||
      centreMoved ||
      Math.abs(bounds.west - this.viewport.west) > 1 ||
      Math.abs(bounds.east - this.viewport.east) > 1 ||
      Math.abs(bounds.north - this.viewport.north) > 1 ||
      Math.abs(bounds.south - this.viewport.south) > 1;
    this.viewport = bounds;
    this.viewportCenter = bounds ? center : undefined;
    if (!moved) return;
    for (const h of this.hosted.values()) {
      if (
        h.running &&
        h.manifest.capabilities.boundsQuery &&
        !h.polling &&
        this.clock.now() - h.lastPollAt > Math.max(h.manifest.refreshPolicy.minIntervalMs, 5000)
      )
        this.schedule(h, 250);
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

  /** Keeps `trusted.hosts` equal to the valid host named in the provider's trustedHostSetting. */
  private watchTrustedHost(manifest: ProviderManifest, trusted: { hosts: readonly string[] }, logger: Logger): void {
    const key = manifest.trustedHostSetting!;
    const apply = (settings: Record<string, JsonValue>) => {
      const raw = settings[key];
      const host = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      const next = host && isNameableHost(host) ? [host] : [];
      if (host && !next.length)
        logger.warn('trusted host setting ignored', { setting: key, reason: 'not a host name' });
      if (next.join() !== trusted.hosts.join()) {
        trusted.hosts = next;
        if (next.length) logger.info('trusted host', { host: next[0]! });
      }
    };
    const store = this.deps.settingsStore(manifest.id);
    store.onChange(apply);
    void store.get().then(apply, () => undefined);
  }

  /** Keeps `granted.folder` equal to the absolute folder named in the provider's grantedFolderSetting. */
  private watchGrantedFolder(
    manifest: ProviderManifest,
    granted: { folder: string | undefined },
    logger: Logger,
  ): void {
    const key = manifest.grantedFolderSetting!;
    const apply = (settings: Record<string, JsonValue>) => {
      const raw = settings[key];
      const folder = typeof raw === 'string' ? raw.trim() : '';
      const next = folder && isGrantableFolder(folder) ? folder : undefined;
      if (folder && !next)
        logger.warn('granted folder setting ignored', { setting: key, reason: 'not an absolute folder path' });
      if (next !== granted.folder) {
        granted.folder = next;
        if (next) logger.info('granted folder', { folder: next });
      }
    };
    const store = this.deps.settingsStore(manifest.id);
    store.onChange(apply);
    void store.get().then(apply, () => undefined);
  }

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
      local: this.withListener(
        h,
        this.deps.localAccess?.(
          manifest.id,
          manifest.allowedHosts,
          () => h.trusted.hosts,
          () => h.granted.folder,
          Boolean(manifest.grantedFolderSetting),
        ) ?? deniedLocalAccess(),
      ),
      // MQTT is a local transport: only providers declared as such get a client, and only for
      // the hosts a line stream could reach — loopback in the manifest or the one the user named.
      ...(this.deps.mqtt && (manifest.transport === 'local-process' || manifest.transport === 'hardware')
        ? {
            mqtt: this.deps.mqtt(
              manifest.id,
              manifest.allowedHosts,
              () => h.trusted.hosts,
              scopedCredentials(
                this.deps.credentials,
                manifest.credentials.map((c) => c.key),
              ).get,
            ),
          }
        : {}),
      hash: { sha256Hex: (input) => createHash('sha256').update(input).digest('hex') },
      connectivity: { online: () => this.online },
    };
  }

  private async startProvider(id: string): Promise<void> {
    const h = this.hosted.get(id);
    if (!h || h.running || this.disposed) return;
    try {
      if (!h.initialized) {
        await h.provider.initialize(this.context(h));
        h.initialized = true;
      }
      await h.provider.start();
      h.running = true;
      h.consecutiveFailures = 0;
      if (h.provider.subscribe) await this.openSubscription(h);
      if (h.provider.query) this.schedule(h, 0);
      else await this.publishHealth(h);
      // Overlays are asked for after start and again after every successful poll (a first
      // capabilities read that fails leaves nothing behind; a changed setting reaches the
      // renderers on the next poll) — and never awaited here, so a slow or unreachable
      // service cannot hold up the application's start.
      if (h.provider.overlays) void this.refreshOverlays(id);
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      h.logger.error('provider failed to start', { code: pe.code, message: pe.message });
      await this.publishHealth(h, {
        status: 'ERROR',
        message: pe.message,
        lastError: pe.toInfo(new Date(this.clock.now()).toISOString()),
      });
    }
  }

  private async stopProvider(id: string): Promise<void> {
    const h = this.hosted.get(id);
    if (!h) return;
    this.cancelPoll(h);
    if (h.unsubscribe) {
      try {
        h.unsubscribe();
      } catch {
        /* ignore */
      }
      h.unsubscribe = undefined;
    }
    if (h.running) {
      h.running = false;
      try {
        await h.provider.stop();
      } catch (err) {
        h.logger.warn('provider stop failed', { message: String(err) });
      }
    }
    if (h.overlays.length) this.setOverlays(h, []);
    if (h.listener) {
      const listener = h.listener;
      h.listener = undefined;
      await listener.close().catch(() => undefined);
    }
    await this.publishHealth(h, { status: h.enabled ? 'STARTING' : 'DISABLED' });
  }

  private schedule(h: Hosted, delayMs: number): void {
    if (this.deps.manualScheduling || !h.running || this.disposed) return;
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => {
      h.timer = undefined;
      void this.poll(h);
    }, delayMs);
    if (typeof h.timer === 'object' && 'unref' in h.timer) (h.timer as { unref(): void }).unref();
  }

  private cancelPoll(h: Hosted): void {
    if (h.timer) {
      clearTimeout(h.timer);
      h.timer = undefined;
    }
    h.abort?.abort();
    h.abort = undefined;
  }

  private async poll(h: Hosted): Promise<ObservationBatch | undefined> {
    if (!h.running || !h.provider.query || h.polling) return undefined;
    if (isRemote(h.manifest) && !this.online) {
      await this.publishHealth(h, { status: 'OFFLINE', message: 'network offline' });
      return undefined;
    }
    h.polling = true;
    h.lastPollAt = this.clock.now();
    const abort = new AbortController();
    h.abort = abort;
    const budget = pollBudgetMs(h.manifest.refreshPolicy);
    const timeout = setTimeout(() => abort.abort(new ProviderError('TIMEOUT', `poll exceeded ${budget}ms`)), budget);
    try {
      const observations = await h.provider.query({
        signal: abort.signal,
        background: true,
        ...(this.viewport && h.manifest.capabilities.boundsQuery ? { bounds: this.viewport } : {}),
        ...(this.viewport && this.viewportCenter && h.manifest.capabilities.boundsQuery
          ? { center: this.viewportCenter }
          : {}),
      });
      const batch = this.admit(h, observations, true);
      h.consecutiveFailures = 0;
      await this.publishHealth(h);
      this.schedule(h, Math.max(h.manifest.refreshPolicy.intervalMs, h.manifest.refreshPolicy.minIntervalMs));
      if (h.provider.overlays) void this.refreshOverlays(h.manifest.id);
      return batch;
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      if (pe.code === 'CANCELLED') return undefined;
      h.consecutiveFailures++;
      h.logger.warn('poll failed', { code: pe.code, message: pe.message, consecutiveFailures: h.consecutiveFailures });
      await this.publishHealth(h);
      const base =
        pe.retryAfterMs ??
        backoffDelay(h.consecutiveFailures - 1, {
          baseMs: Math.max(5000, h.manifest.refreshPolicy.intervalMs / 4),
          maxMs: 15 * 60_000,
          factor: 2,
          jitter: 0.2,
        });
      const delay =
        pe.code === 'AUTH' || pe.code === 'HOST_NOT_ALLOWED'
          ? Number.POSITIVE_INFINITY
          : Math.max(base, h.manifest.refreshPolicy.minIntervalMs);
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
    if (rejected.length || wrongProvider)
      h.logger.warn('rejected observations', {
        rejected: rejected.length + wrongProvider,
        sample: rejected.slice(0, 3).map((r) => r.reason),
      });
    const batch: ObservationBatch = {
      providerId: h.manifest.id,
      observations,
      snapshot,
      receivedAt: new Date(this.clock.now()).toISOString(),
      rejected: rejected.length + wrongProvider + (raw.length - sliced.length),
      ...(h.manifest.refreshPolicy.freshness ? { freshness: h.manifest.refreshPolicy.freshness } : {}),
    };
    for (const sink of [...this.sinks]) {
      try {
        sink(batch);
      } catch (err) {
        this.log.error('observation sink threw', { message: err instanceof Error ? err.message : String(err) });
      }
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
        (observations, meta) => {
          if (h.running) {
            this.admit(h, observations, meta?.snapshot ?? false);
            void this.publishHealth(h);
          }
        },
      );
      h.unsubscribe = () => {
        abort.abort();
        unsub();
      };
      await this.publishHealth(h);
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      h.consecutiveFailures++;
      await this.publishHealth(h, {
        status: pe.code === 'AUTH' ? 'AUTH_REQUIRED' : 'ERROR',
        message: pe.message,
        lastError: pe.toInfo(new Date(this.clock.now()).toISOString()),
      });
      if (pe.code !== 'AUTH' && !this.deps.manualScheduling) {
        const delay = backoffDelay(h.consecutiveFailures - 1, {
          baseMs: 5000,
          maxMs: 5 * 60_000,
          factor: 2,
          jitter: 0.2,
        });
        h.timer = setTimeout(() => {
          h.timer = undefined;
          if (h.running) void this.openSubscription(h);
        }, delay);
      }
    }
  }

  /**
   * The provider's local access with `listen` offered — or taken away — by the host: only a
   * `local-process` provider gets one, only one at a time, only for a credential its manifest
   * declares, and only while it runs (the host closes it on stop).
   */
  private withListener(h: Hosted, local: ProviderLocalAccess): ProviderLocalAccess {
    const { listen: _ignored, ...rest } = local;
    const factory = this.deps.listen;
    if (!factory || h.manifest.transport !== 'local-process') return rest;
    const open = factory(
      h.manifest.id,
      scopedCredentials(
        this.deps.credentials,
        h.manifest.credentials.map((c) => c.key),
      ).get,
    );
    return {
      ...rest,
      listen: async (options, handler) => {
        if (!h.running && !h.initialized)
          throw new ProviderError('UNSUPPORTED', 'the source is not running', { retryable: false });
        if (!h.manifest.credentials.some((c) => c.key === options.credential?.key))
          throw new ProviderError('INTERNAL', `credential ${options.credential?.key} is not declared in the manifest`, {
            retryable: false,
          });
        if (h.listener) throw new ProviderError('INTERNAL', 'one listener per source', { retryable: false });
        const handle = await open(options, handler);
        h.listener = handle;
        h.logger.info('listening', { address: `127.0.0.1:${handle.port}`, path: options.path });
        const close = handle.close.bind(handle);
        return {
          get port() {
            return handle.port;
          },
          get received() {
            return handle.received;
          },
          get refused() {
            return handle.refused;
          },
          close: async () => {
            if (h.listener === handle) h.listener = undefined;
            await close();
          },
        };
      },
    };
  }

  private async openSocket(
    h: Hosted,
    url: string,
    events: ProviderSocketEvents,
    opts?: ProviderSocketOptions,
  ): Promise<ProviderSocketHandle> {
    if (!h.http.isHostAllowed(url) || !/^wss:/.test(url))
      throw new ProviderError('HOST_NOT_ALLOWED', 'websocket host not allowed (wss only, allowlisted hosts)', {
        retryable: false,
      });
    if (!this.online) throw new ProviderError('OFFLINE', 'application offline');
    const Impl = this.deps.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Impl) throw new ProviderError('UNSUPPORTED', 'WebSocket not available in this runtime', { retryable: false });
    // The secret is resolved here and handed to onOpen for the handshake only; it is
    // never attached to the handle, logged or retained (ADR-003).
    let secret: string | undefined;
    if (opts?.credential) {
      if (!h.manifest.credentials.some((c) => c.key === opts.credential!.key)) {
        throw new ProviderError('INTERNAL', `credential ${opts.credential.key} is not declared in the manifest`, {
          retryable: false,
        });
      }
      secret = await this.deps.credentials.get(opts.credential.key);
      if (!secret)
        throw new ProviderError('AUTH', `credential ${opts.credential.key} not configured`, { retryable: false });
    }
    const maxBytes = opts?.maxMessageBytes ?? 1024 * 1024;
    // A query credential goes into the URL the socket dials and nowhere else: not into the
    // handle, a log line or an error (the provider's own URL is what those would show).
    let dial = url;
    if (secret !== undefined && opts?.credential?.as === 'query') {
      const param = opts.credential.param ?? 'token';
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(param))
        throw new ProviderError('INTERNAL', `credential query parameter "${param}" is not a name`, {
          retryable: false,
        });
      const u = new URL(url);
      u.searchParams.set(param, secret);
      dial = u.toString();
      secret = undefined;
    }
    const ws = new Impl(dial);
    ws.binaryType = 'arraybuffer';
    let closed = false;
    const finish = (code: number, reason: string) => {
      if (!closed) {
        closed = true;
        events.onClose(code, reason);
      }
    };
    ws.onopen = () => {
      const ctx = secret !== undefined ? { secret } : {};
      secret = undefined;
      events.onOpen?.(ctx);
    };
    ws.onmessage = (ev: MessageEvent) => {
      const data = ev.data as string | ArrayBuffer;
      const size = typeof data === 'string' ? data.length : data.byteLength;
      if (size > maxBytes) {
        h.logger.warn('websocket message dropped (too large)', { size });
        return;
      }
      events.onMessage(typeof data === 'string' ? data : new Uint8Array(data));
    };
    ws.onerror = () => events.onError(new ProviderError('NETWORK', 'websocket error'));
    ws.onclose = (ev: CloseEvent) => finish(ev.code, ev.reason);
    opts?.signal?.addEventListener(
      'abort',
      () => {
        try {
          ws.close(1000, 'cancelled');
        } catch {
          /* ignore */
        }
        finish(1000, 'cancelled');
      },
      { once: true },
    );
    return {
      send: (d) =>
        ws.send(typeof d === 'string' ? d : (d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)),
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          /* ignore */
        }
      },
    };
  }

  private async publishHealth(h: Hosted, override?: Partial<ProviderHealth>): Promise<void> {
    let health: ProviderHealth;
    try {
      health = await h.provider.health();
    } catch {
      health = {
        providerId: h.manifest.id,
        status: 'ERROR',
        errorRate: 1,
        rateLimitState: { limited: false },
        credentialState: 'not-required',
        message: 'health() threw',
      };
    }
    if (!h.running && health.status !== 'DISABLED') health = { ...health, status: h.enabled ? 'STARTING' : 'DISABLED' };
    if (h.running && isRemote(h.manifest) && !this.online)
      health = { ...health, status: 'OFFLINE', message: 'network offline' };
    health = { ...health, ...override, providerId: h.manifest.id };
    this.health.update(health);
  }

  private onCredentialChange(key: string): void {
    for (const h of this.hosted.values()) {
      if (h.manifest.credentials.some((c) => c.key === key) && h.running) {
        h.consecutiveFailures = 0;
        this.schedule(h, 0);
      }
    }
  }
}

function scopedCredentials(resolver: CredentialResolver, keys: readonly string[]): CredentialResolver {
  const allowed = new Set(keys);
  return { get: async (key) => (allowed.has(key) ? resolver.get(key) : undefined) };
}

function isRemote(m: ProviderManifest): boolean {
  return m.transport === 'http' || m.transport === 'websocket';
}

function deniedLocalAccess(): ProviderLocalAccess {
  return {
    readGrantedFile: async () => {
      throw new ProviderError('UNSUPPORTED', 'no local access granted', { retryable: false });
    },
    statGrantedFile: async () => {
      throw new ProviderError('UNSUPPORTED', 'no local access granted', { retryable: false });
    },
    probeLocal: async () => ({ reachable: false }),
  };
}

/**
 * A folder a user may grant (ADR-003): an absolute path, on any platform's spelling, that
 * is not a drive or filesystem root and has no `..` segment. Existence is checked at read
 * time, not here: a folder that appears later is granted then.
 */
/** The time one poll may take: the manifest's own budget, or one request with its retries plus a margin. */
export function pollBudgetMs(policy: RefreshPolicy): number {
  return policy.pollBudgetMs ?? policy.timeoutMs * (policy.maxRetries + 1) + 5000;
}

export function isGrantableFolder(folder: string): boolean {
  if (folder.length > 1024) return false;
  const win = /^[A-Za-z]:[\\/]/.test(folder);
  const posix = folder.startsWith('/');
  const unc = /^\\\\[^\\]+\\[^\\]+/.test(folder);
  if (!win && !posix && !unc) return false;
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..')) return false;
  // A root alone: "C:", "/", "\\\\server\\share".
  if (win && parts.length <= 1) return false;
  if (posix && parts.length === 0) return false;
  if (unc && parts.length <= 2) return false;
  return true;
}

export type { ProviderCache, ProviderSettings, JsonValue };
