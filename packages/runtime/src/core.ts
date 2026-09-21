import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  systemClock, type Clock, type GeoBounds, type JsonValue, type WorldObject,
} from '@worldview/world-model';
import { HttpClient, LoggerHub, RingBufferSink, type Logger } from '@worldview/core';
import { type ProviderDataPolicy, type ProviderManifest, type WorldProvider } from '@worldview/provider-sdk';
import { ProviderHost, type ObservationBatch } from '@worldview/provider-runtime';
import { WorldState } from '@worldview/state-engine';
import {
  HistoryStore, TimelineController, createHistoryBackend, type HistoryBackendKind,
} from '@worldview/history-store';
import { EventEngine, FeedBuilder, WatchZoneEvaluator } from '@worldview/event-engine';
import { BuiltinGazetteer, CompositeGazetteer, type Gazetteer, type HistoryReader } from '@worldview/query-engine';
import { ConnectionMonitor, WorldPackRegistry } from '@worldview/offline';
import {
  CameraHub, CameraRelay, DirectGateway, Go2rtcGateway, Go2rtcSidecar, MemorySecretStore, PublicFrameRegistry,
  createFetchByteFetcher, createFetchUpstreamOpener, type SecretStore, type SpawnFn,
} from '@worldview/camera-gateway';
import { DEFAULT_SETTINGS, SettingsStore, dataDirs, ensureDataDirs, type DataDirs } from '@worldview/config';
import { DiagnosticsCollector } from '@worldview/diagnostics';
import { UpdaterController, createInertAutoUpdater, policyInputFromSettings } from '@worldview/updater';
import { BUILT_IN_LENSES, type LensDefinition } from '@worldview/render-core';
import type {
  AppSettings as ContractSettings, Collection, DiagnosticsSnapshot, FeedItem, OfflineStatus, WatchZone,
} from '@worldview/ipc-contract';
import { createAllProviders } from '@worldview/providers';
import type { HostBridge, RuntimeCredentialStore, WorldRuntimeDeps } from './deps.js';
import { inProcessHostBridge } from './deps.js';
import { RuntimeEmitter } from './support/emitter.js';
import { JsonDocStore } from './support/json-doc-store.js';
import {
  FileProviderCache, ProviderSettingsStore, createLocalAccess, deniedProviderCache,
} from './support/provider-storage.js';
import { PlaceIndexGazetteer } from './support/gazetteer.js';
import { SubscriptionRegistry, deltaFor, diffObjectSets, filterObjects } from './support/subscriptions.js';
import { createDemoProviders } from './demo/index.js';
import { validateCollection, validateLens, validateWatchZone } from './validate.js';

const DEFAULT_SWEEP_MS = 15_000;
const DEFAULT_FLUSH_MS = 250;
const DEFAULT_RETENTION_MS = 6 * 3_600_000;
const TIMELINE_TICK_MS = 1_000;
const PROBE_HOST = 'earthquake.usgs.gov';
const PROBE_URL = `https://${PROBE_HOST}/earthquakes/feed/v1.0/summary/all_hour.geojson`;
const PROBE_MIN_INTERVAL_MS = 30_000;
const DEFAULT_VERSION = '0.1.0';

/** Project pages that are always openable, independent of which providers are registered. */
const STATIC_EXTERNAL_HOSTS: readonly string[] = Object.freeze(['github.com']);

function httpsHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

/** In-memory credentials for browser/demo composition — nothing is ever written to disk. */
class MemoryCredentialStore implements RuntimeCredentialStore {
  private readonly values = new Map<string, string>();
  private readonly listeners = new Set<(key: string) => void>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async has(key: string): Promise<boolean> { return this.values.has(key); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); this.fire(key); }
  async delete(key: string): Promise<void> { this.values.delete(key); this.fire(key); }
  onChange(listener: (key: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private fire(key: string): void { for (const l of [...this.listeners]) l(key); }
}

/**
 * RuntimeCore — the composed object graph. `createWorldRuntime` builds one of these and
 * wraps it in the `RequestHandlers` map; nothing outside the runtime package touches it.
 *
 * Data flow, once:
 *
 *   providers → ProviderHost ─┬→ WorldState ─→ EventEngine ─→ FeedBuilder / WatchZones
 *                             ├→ HistoryStore (policy-gated)
 *                             └→ PublicFrameRegistry (camera refs)
 *   WorldState / timeline projection → per-client `world.changed`
 *   SourceHealthRegistry + ConnectionMonitor → `sources.changed` / `connection.changed`
 */
/**
 * The only place the runtime starts a child process. go2rtc is detached from the
 * terminal's stdio and given no shell, so a path the operator typed is spawned as a
 * program and never interpreted by a shell.
 */
const defaultSpawn: SpawnFn = (command, args, opts) => nodeSpawn(command, args, { cwd: opts.cwd, shell: false, stdio: 'ignore', windowsHide: true });

export class RuntimeCore {
  readonly clock: Clock;
  readonly loggerHub: LoggerHub;
  readonly log: Logger;
  readonly logSink: RingBufferSink | undefined;
  readonly dirs: DataDirs;
  readonly demo: boolean;
  readonly version: string;
  readonly commit: string;
  readonly channel: 'stable' | 'prerelease' | 'dev';
  readonly platform: string;
  readonly startedAt: string;
  readonly hostBridge: HostBridge;
  readonly credentials: RuntimeCredentialStore;
  readonly emitter = new RuntimeEmitter();
  readonly subscriptions = new SubscriptionRegistry();

  settings!: SettingsStore;
  providerHost!: ProviderHost;
  state!: WorldState;
  history!: HistoryStore;
  timeline!: TimelineController;
  events!: EventEngine;
  feed!: FeedBuilder;
  watchZones!: WatchZoneEvaluator;
  packs!: WorldPackRegistry;
  connection!: ConnectionMonitor;
  cameras!: CameraHub;
  cameraSecrets!: SecretStore;
  directGateway!: DirectGateway;
  publicFrames!: PublicFrameRegistry;
  cameraRelay: CameraRelay | undefined;
  /** Constructed always; `not-configured` and inert until the operator sets a binary path. */
  go2rtc!: Go2rtcSidecar;
  go2rtcGateway!: Go2rtcGateway;
  diagnostics!: DiagnosticsCollector;
  updater!: UpdaterController;
  providerSettings!: ProviderSettingsStore;
  collections!: JsonDocStore<Collection>;
  watchZoneStore!: JsonDocStore<WatchZone>;
  lenses!: JsonDocStore<LensDefinition>;
  gazetteer!: Gazetteer;
  historyReader!: HistoryReader;

  /** Last viewport the shell reported; biases search and bounds-query providers. */
  viewport: GeoBounds | undefined;
  /** What the shell's OS network monitor last reported through `setNetworkOnline`. */
  osOnline = true;
  private osListeners = new Set<(online: boolean) => void>();
  private historyOpen = false;
  private lastProbeAt = 0;
  private probeClient: HttpClient | undefined;
  private projected = new Map<string, WorldObject>();
  private projecting = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private detach: Array<() => void> = [];
  private started = false;
  private stopped = false;

  constructor(private readonly deps: WorldRuntimeDeps) {
    this.clock = deps.clock ?? systemClock;
    this.demo = deps.demo ?? false;
    this.version = deps.version ?? DEFAULT_VERSION;
    this.commit = deps.commit ?? 'unknown';
    this.channel = deps.channel ?? 'dev';
    this.platform = deps.platform ?? process.platform;
    this.startedAt = new Date(this.clock.now()).toISOString();
    this.hostBridge = deps.host ?? inProcessHostBridge;
    this.credentials = deps.credentials ?? new MemoryCredentialStore();
    this.dirs = deps.dirs ?? dataDirs(deps.dataDir ?? path.join(os.tmpdir(), 'worldview-runtime'));
    if (deps.loggerHub) {
      this.loggerHub = deps.loggerHub;
      this.logSink = undefined;
    } else {
      this.logSink = new RingBufferSink();
      this.loggerHub = new LoggerHub({ level: 'info', sinks: [this.logSink], now: () => this.clock.now() });
    }
    this.log = deps.logger ?? this.loggerHub.logger('app');
  }

  // ---- construction ---------------------------------------------------------

  async build(): Promise<void> {
    await ensureDataDirs(this.dirs);

    this.settings = this.deps.settings ?? (await SettingsStore.open({ file: this.dirs.settingsFile, schemaVersion: 1, logger: this.loggerHub.logger('app'), now: () => this.clock.now() })).store;
    this.providerSettings = new ProviderSettingsStore(path.join(this.dirs.root, 'provider-settings.json'), this.loggerHub.logger('provider'));
    await this.providerSettings.load();

    this.state = new WorldState({ clock: this.clock, flushDelayMs: this.deps.flushDelayMs ?? DEFAULT_FLUSH_MS });
    this.buildProviderHost();
    await this.buildHistory();
    this.buildEvents();
    await this.buildOffline();
    this.buildCameras();
    await this.buildUserDocuments();
    this.buildUpdater();
    this.buildDiagnostics();
    this.wire();
  }

  private buildProviderHost(): void {
    const userAgent = `WorldView/${this.version}`;
    this.providerHost = new ProviderHost({
      clock: this.clock,
      loggerHub: this.loggerHub,
      credentials: this.credentials,
      userAgent,
      cacheStore: (providerId, cacheAllowed) => (cacheAllowed
        ? new FileProviderCache(path.join(this.dirs.cacheDir, `${safeFileName(providerId)}.json`), this.clock, true, this.loggerHub.logger('provider'))
        : deniedProviderCache),
      settingsStore: (providerId) => this.providerSettings.view(providerId),
      localAccess: (providerId, allowedHosts) => createLocalAccess({
        allowedHosts,
        ...(this.grantDirFor(providerId) ? { grantDir: this.grantDirFor(providerId)! } : {}),
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      }),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.webSocketImpl ? { webSocketImpl: this.deps.webSocketImpl } : {}),
      ...(this.deps.manualScheduling ? { manualScheduling: true } : {}),
    });

    const disabled = new Set(this.deps.disabledProviders ?? []);
    const enabledSetting = this.settings.get().providers;
    for (const provider of this.providerList()) {
      try {
        const id = provider.manifest.id;
        const configured = enabledSetting[id]?.enabled;
        const enabled = disabled.has(id) ? false : configured ?? provider.manifest.enabledByDefault;
        this.providerHost.register(provider, { enabled });
      } catch (err) {
        // A provider with an invalid manifest must never stop the application from starting.
        this.log.error('provider not registered', { providerId: provider.manifest?.id ?? 'unknown', error: errorText(err) });
      }
    }
  }

  private providerList(): WorldProvider[] {
    if (this.deps.providerInstances) return [...this.deps.providerInstances];
    if (this.demo) return createDemoProviders();
    return createAllProviders(this.deps.providers ?? {});
  }

  /** Bundled fixtures directory granted to filesystem-transport providers. */
  private grantDirFor(providerId: string): string | undefined {
    return this.deps.localGrants?.[providerId] ?? this.deps.resourcesDir;
  }

  private async buildHistory(): Promise<void> {
    const created = await createHistoryBackend({
      dataDir: this.dirs.historyDir,
      preferred: (this.deps.historyBackend ?? 'ndjson') as HistoryBackendKind,
      logger: this.loggerHub.logger('history'),
      clock: this.clock,
    });
    this.history = new HistoryStore({
      dataDir: this.dirs.historyDir,
      backend: created.backend,
      clock: this.clock,
      logger: this.loggerHub.logger('history'),
      policies: (providerId) => this.policyFor(providerId),
      providerInfo: (providerId) => {
        const m = this.providerHost.manifest(providerId);
        return m ? { sourceName: m.name, ...(m.attribution.text ? { attribution: m.attribution.text } : {}) } : undefined;
      },
      requestedBackend: created.requestedBackend,
      ...(created.fallbackReason !== undefined ? { fallbackReason: created.fallbackReason } : {}),
    });
    await this.history.open();
    this.historyOpen = true;

    this.timeline = new TimelineController({ history: this.history, clock: this.clock });
    // The adapter that lets query-engine read history without knowing the store.
    this.historyReader = {
      objectsAt: (cursor, opts) => this.history.snapshotAt(cursor, {
        ...(opts.objectTypes ? { objectTypes: opts.objectTypes } : {}),
        ...(opts.providerIds ? { providerIds: opts.providerIds } : {}),
        ...(opts.bounds ? { bounds: opts.bounds } : {}),
        ...(opts.lookbackSeconds !== undefined ? { lookbackSeconds: opts.lookbackSeconds } : {}),
      }),
    };
  }

  private buildEvents(): void {
    this.events = new EventEngine({ clock: this.clock, sourceHealth: this.providerHost.health });
    this.feed = new FeedBuilder();
    this.watchZones = new WatchZoneEvaluator({ clock: this.clock });
  }

  private async buildOffline(): Promise<void> {
    this.packs = new WorldPackRegistry({
      dataDir: this.dirs.root,
      appVersion: this.version,
      clock: this.clock,
      logger: this.loggerHub.logger('offline'),
      flags: () => ({
        history: this.historyOpen,
        collections: true,
        localAircraft: this.providerHost.list().some((p) => p.running && p.manifest.transport === 'local-process'),
      }),
    });
    await this.packs.refresh();
    this.gazetteer = new CompositeGazetteer([new PlaceIndexGazetteer(() => this.packs.placeIndex()), new BuiltinGazetteer()]);

    // The OS signal is the injected one AND whatever the shell last told us through
    // `setNetworkOnline`; either saying "offline" is authoritative.
    const injected = this.deps.network;
    const network = {
      isOnline: () => this.osOnline && (injected?.isOnline() ?? true),
      subscribe: (listener: (online: boolean) => void) => {
        this.osListeners.add(listener);
        const off = injected?.subscribe?.((online) => listener(online && this.osOnline));
        return () => { this.osListeners.delete(listener); off?.(); };
      },
    };
    this.connection = new ConnectionMonitor({
      network,
      sourceHealth: this.providerHost.health,
      clock: this.clock,
      logger: this.loggerHub.logger('offline'),
      ...(this.deps.disableReachabilityProbe ? {} : { probe: () => this.probeReachability() }),
    });
  }

  private buildCameras(): void {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const log = this.loggerHub.logger('camera');
    this.cameraSecrets = new MemorySecretStore();
    this.publicFrames = new PublicFrameRegistry({ logger: log });
    // The relay is a loopback HTTP server; it is constructed here but only listens once
    // a stream is actually requested, so a headless session never opens a socket.
    this.cameraRelay = new CameraRelay({
      openUpstream: createFetchUpstreamOpener(fetchImpl),
      fetchBytes: createFetchByteFetcher(fetchImpl),
      logger: log,
    });
    this.directGateway = new DirectGateway({
      fetchBytes: createFetchByteFetcher(fetchImpl),
      openUpstream: createFetchUpstreamOpener(fetchImpl),
      secrets: this.cameraSecrets,
      relay: this.cameraRelay,
      clock: this.clock,
      logger: log,
      userAgent: `WorldView/${this.version}`,
    });
    // go2rtc is optional and operator-supplied: nothing is downloaded and nothing is
    // spawned until `cameras.go2rtcPath` names a binary that exists. Constructing it
    // unconditionally means `camera.status` can report `not-configured` honestly instead
    // of the gateway being absent from the hub entirely.
    const configured = this.settings.get().cameras.go2rtcPath;
    this.go2rtc = new Go2rtcSidecar({
      ...(configured ? { binaryPath: configured } : {}),
      configDir: this.dirs.root,
      spawn: this.deps.spawnImpl ?? defaultSpawn,
      fetch: fetchImpl as unknown as ConstructorParameters<typeof Go2rtcSidecar>[0]['fetch'],
      fileExists: (filePath) => existsSync(filePath),
      writeFile: (filePath, content) => fs.writeFile(filePath, content, 'utf8'),
      clock: this.clock,
      logger: log,
    });
    this.go2rtcGateway = new Go2rtcGateway({
      sidecar: this.go2rtc,
      fetch: fetchImpl as unknown as ConstructorParameters<typeof Go2rtcGateway>[0]['fetch'],
      secrets: this.cameraSecrets,
      relay: this.cameraRelay,
      clock: this.clock,
      logger: log,
    });
    this.cameras = new CameraHub({
      direct: this.directGateway,
      go2rtc: this.go2rtcGateway,
      publicFrames: this.publicFrames,
      fetchBytes: createFetchByteFetcher(fetchImpl),
      relay: this.cameraRelay,
      clock: this.clock,
      logger: log,
      userAgent: `WorldView/${this.version}`,
    });
  }

  /**
   * Bring the go2rtc sidecar up on demand (an RTSP camera is registered or streamed).
   * Returns false when it is not configured or would not start — the caller reports that
   * as a camera error rather than pretending the stream exists.
   */
  async ensureGo2rtc(): Promise<boolean> {
    if (this.stopped || !this.go2rtc.configured()) return false;
    if (this.go2rtc.isRunning()) return true;
    const started = await this.go2rtc.start();
    if (started) await this.go2rtcGateway.syncStreams().catch((err: unknown) => this.log.warn('go2rtc stream sync failed', { error: errorText(err) }));
    else this.log.warn('go2rtc sidecar did not start', { status: this.go2rtc.status().status });
    return started;
  }

  /** Apply a changed `cameras.go2rtcPath`; a running sidecar is stopped before the swap. */
  async applyGo2rtcSetting(): Promise<void> {
    await this.go2rtc.setBinaryPath(this.settings.get().cameras.go2rtcPath);
  }

  /** Bring the loopback camera relay up on demand (first `camera.stream`). */
  async ensureCameraRelay(): Promise<void> {
    const relay = this.cameraRelay;
    if (!relay || relay.isListening() || this.stopped) return;
    try {
      await relay.start();
    } catch (err) {
      this.log.warn('camera relay failed to start', { error: errorText(err) });
    }
  }

  private async buildUserDocuments(): Promise<void> {
    const log = this.loggerHub.logger('app');
    this.collections = new JsonDocStore<Collection>(this.dirs.collectionsFile, validateCollection, log);
    this.watchZoneStore = new JsonDocStore<WatchZone>(this.dirs.watchzonesFile, validateWatchZone, log);
    this.lenses = new JsonDocStore<LensDefinition>(this.dirs.lensesFile, validateLens, log);
    await this.collections.load();
    await this.lenses.load();
    const zones = await this.watchZoneStore.load();
    this.watchZones.setZones(zones);
  }

  private buildUpdater(): void {
    this.updater = new UpdaterController({
      updater: this.deps.updater ?? createInertAutoUpdater(),
      currentVersion: this.version,
      policy: () => policyInputFromSettings(this.settings.get().updater, this.deps.build ?? { signed: false, packaged: false }),
      logger: this.loggerHub.logger('updater'),
      now: () => this.clock.now(),
    });
  }

  private buildDiagnostics(): void {
    this.diagnostics = new DiagnosticsCollector({
      app: () => ({ version: this.version, channel: this.channel, commit: this.commit, demoMode: this.demoMode(), startedAt: this.startedAt }),
      runtime: () => this.deps.runtimeInfo?.() ?? { electron: 'n/a', chrome: 'n/a', node: process.version, platform: this.platform, arch: process.arch },
      providers: () => this.providerHost.health.list(),
      database: async () => {
        const d = await this.history.diagnostics();
        return { status: d.status, backend: d.kind, sizeBytes: d.sizeBytes, partitions: d.partitions, ...(d.message ? { message: d.message } : {}) };
      },
      offline: () => this.offlineStatus(),
      renderer: () => this.deps.rendererInfo?.() ?? { active: '2D', webgl2: false },
      sidecars: async () => {
        const status = await this.cameras.status();
        const out: DiagnosticsSnapshot['sidecars'] = [
          {
            id: 'go2rtc',
            status: status.go2rtc ? mapSidecarStatus(status.go2rtc.state) : 'not-configured',
            ...(status.go2rtc?.sidecar?.version ? { version: status.go2rtc.sidecar.version } : {}),
            ...(status.go2rtc?.message ? { message: status.go2rtc.message } : {}),
          },
          {
            id: 'camera-relay',
            status: this.cameraRelay?.isListening() ? 'running' : 'stopped',
            message: this.cameraRelay?.isListening()
              ? `loopback relay on 127.0.0.1:${this.cameraRelay.port() ?? 0}, ${this.cameraRelay.activeStreams()} active stream(s)`
              : 'starts on the first camera stream request',
          },
        ];
        return out;
      },
      updater: () => this.updater.state(),
      disk: async () => ({ dataDir: this.dirs.root, usedBytes: await directorySize(this.dirs.root) }),
      logs: async () => ({ path: this.dirs.logFile, sizeBytes: await fileSize(this.dirs.logFile) }),
    }, { logger: this.loggerHub.logger('diagnostics'), now: () => this.clock.now() });
  }

  // ---- wiring ---------------------------------------------------------------

  private wire(): void {
    this.detach.push(this.providerHost.onObservations((batch) => this.onBatch(batch)));
    this.detach.push(this.state.onChange((change) => { void this.onStateChange(change); }));
    this.detach.push(this.events.attach(this.state));
    this.detach.push(this.events.on('event', ({ event }) => this.onEvent(event)));
    this.detach.push(this.providerHost.health.on('change', () => {
      // A provider coming up or going down is a real connectivity observation, so the
      // monitor re-evaluates: together with its own SourceHealthRegistry subscription
      // this gives the two agreeing evaluations its hysteresis asks for, and the
      // indicator follows the sources instead of waiting for the next 30 s probe.
      void this.connection.tick().catch(() => undefined);
      this.emitter.emit('sources.changed', { entries: this.providerHost.health.list(), connection: this.connectionSnapshot() });
    }));
    this.detach.push(this.connection.on('change', (snapshot) => {
      this.providerHost.setOnline(snapshot.state !== 'OFFLINE');
      this.emitter.emit('connection.changed', snapshot);
      this.emitter.emit('offline.changed', this.offlineStatus());
    }));
    this.detach.push(this.packs.on('changed', () => { this.emitter.emit('offline.changed', this.offlineStatus()); }));
    this.detach.push(this.timeline.onChange((state) => {
      this.emitter.emit('timeline.changed', state);
      if (!isLiveMode(state.mode)) void this.projectHistorical();
    }));
    this.detach.push(this.settings.onChange((settings) => {
      this.emitter.emit('settings.changed', settings as ContractSettings);
      this.updater.applyPolicy();
    }));
    this.detach.push(this.updater.onChange((state) => { this.emitter.emit('updater.changed', state); }));
    this.detach.push(this.feed.on('item', (item) => { this.emitter.emit('feed.item', item); }));
  }

  private onBatch(batch: ObservationBatch): void {
    this.state.ingest(batch.observations, {
      snapshot: batch.snapshot,
      providerId: batch.providerId,
      ...(batch.freshness ? { freshness: batch.freshness } : {}),
    });
    this.history.writeBatch(batch);
    // Camera objects are the only source of public frame refs the gateway will resolve.
    this.publicFrames.syncFromObjects(this.state.ofType('camera'));
  }

  private async onStateChange(change: import('@worldview/state-engine').StateChange): Promise<void> {
    for (const id of change.removed) this.watchZones.forgetObject(id);

    const touched: WorldObject[] = [];
    for (const id of [...change.added, ...change.updated]) {
      const o = this.state.get(id);
      if (o) touched.push(o);
    }
    for (const hit of this.watchZones.evaluateObjects(touched)) this.onWatchZoneHit(hit);

    if (isLiveMode(this.timeline.currentMode)) this.publishDelta(change, (id) => this.state.get(id));
  }

  private onEvent(event: import('@worldview/world-model').WorldEvent): void {
    this.feed.push(event);
    for (const hit of this.watchZones.evaluateEvent(event)) this.onWatchZoneHit(hit);
  }

  private onWatchZoneHit(hit: import('@worldview/event-engine').WatchZoneHit): void {
    // Entry events are real events: they go through the store (and therefore the feed).
    this.events.ingestEvent(hit.event);
    this.emitter.emit('notification', hit.notification);
    if (hit.zone.notifications.desktop) {
      try { this.hostBridge.showNotification({ title: hit.notification.title, body: hit.notification.body }); } catch { /* the shell may not support it */ }
    }
  }

  private publishDelta(change: import('@worldview/state-engine').StateChange, lookup: (id: string) => WorldObject | undefined): void {
    for (const subscription of this.subscriptions.all()) {
      const delta = deltaFor(change, subscription, lookup);
      if (delta) this.emitter.emit('world.changed', delta, subscription.clientId);
    }
  }

  // ---- the single live/historical seam --------------------------------------

  /**
   * The objects the application is currently showing. LIVE and PAUSED serve live world
   * state; REPLAY and HISTORICAL serve objects reconstructed from history at the cursor
   * (freshness HISTORICAL, provenance origin 'historical'). Every read path goes through
   * here so the shell never branches on the timeline mode.
   */
  async activeObjects(): Promise<Iterable<WorldObject>> {
    if (isLiveMode(this.timeline.currentMode)) return this.state.all();
    return this.timeline.snapshotAt(this.timeline.cursor);
  }

  isLive(): boolean { return isLiveMode(this.timeline.currentMode); }

  /** Recompute the historical projection and push the difference to subscribers. */
  async projectHistorical(): Promise<void> {
    if (this.projecting || this.stopped) return;
    this.projecting = true;
    try {
      const objects = await this.timeline.snapshotAt(this.timeline.cursor);
      const next = new Map(objects.map((o) => [o.id, o] as const));
      const change = diffObjectSets(this.projected, next, this.timeline.cursor);
      this.projected = next;
      if (change.added.length || change.updated.length || change.removed.length) {
        this.publishDelta(change, (id) => next.get(id));
      }
    } catch (err) {
      this.log.warn('historical projection failed', { error: errorText(err) });
    } finally {
      this.projecting = false;
    }
  }

  /** Called when the timeline returns to LIVE: the shell's view is replaced by live state. */
  resetProjection(): void {
    if (this.projected.size === 0) return;
    const change = diffObjectSets(this.projected, new Map([...this.state.all()].map((o) => [o.id, o] as const)), new Date(this.clock.now()).toISOString());
    this.projected = new Map();
    if (change.added.length || change.updated.length || change.removed.length) {
      this.publishDelta(change, (id) => this.state.get(id));
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.providerHost.start();
    this.connection.start();
    await this.connection.tick().catch(() => undefined);
    await this.timeline.refreshAvailability().catch((err: unknown) => this.log.warn('availability refresh failed', { error: errorText(err) }));

    this.timers.push(interval(() => { this.state.sweep(); }, this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_MS));
    this.timers.push(interval(() => { void this.history.sweepRetention().catch((err: unknown) => this.log.warn('retention sweep failed', { error: errorText(err) })); }, this.deps.retentionIntervalMs ?? DEFAULT_RETENTION_MS));
    this.timers.push(interval(() => { this.onTimelineTick(); }, TIMELINE_TICK_MS));
    this.log.info('runtime started', { demo: this.demoMode(), providers: this.providerHost.list().length, historyBackend: this.history.backend.kind });
  }

  private onTimelineTick(): void {
    const before = this.timeline.currentMode;
    const next = this.timeline.tick();
    if (!next) return;
    if (before !== 'LIVE' && next.mode === 'LIVE') this.resetProjection();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const off of this.detach) { try { off(); } catch { /* ignore */ } }
    this.detach = [];
    this.connection.stop();
    await this.providerHost.dispose().catch(() => undefined);
    this.events.dispose();
    this.state.dispose();
    await this.cameraRelay?.stop().catch(() => undefined);
    await this.go2rtc?.stop().catch(() => undefined);
    await this.history.close().catch((err: unknown) => this.log.warn('history close failed', { error: errorText(err) }));
    this.historyOpen = false;
    this.updater.dispose();
    this.emitter.clear();
    this.log.info('runtime stopped');
  }

  // ---- shared helpers used by the handlers ----------------------------------

  demoMode(): boolean { return this.demo || this.settings.get().demoMode; }

  policyFor(providerId: string): ProviderDataPolicy | undefined {
    return this.providerHost.manifest(providerId)?.dataPolicy;
  }

  manifests(): ProviderManifest[] { return this.providerHost.list().map((p) => p.manifest); }

  /**
   * Hosts `app.openExternal` may open: the attribution, terms and credential-help links
   * declared by the registered providers, plus the project's own pages. Derived from the
   * manifests so adding a provider never means editing an allowlist by hand.
   */
  externalHostAllowlist(): ReadonlySet<string> {
    const hosts = new Set(STATIC_EXTERNAL_HOSTS);
    for (const manifest of this.manifests()) {
      for (const url of [manifest.dataPolicy.termsUrl, manifest.attribution.url, ...manifest.credentials.map((c) => c.helpUrl)]) {
        const host = httpsHost(url);
        if (host) hosts.add(host);
      }
    }
    return hosts;
  }

  connectionSnapshot(): OfflineStatus['connection'] { return this.connection.snapshot(); }

  offlineStatus(): OfflineStatus { return this.packs.status(this.connectionSnapshot()); }

  async allLenses(): Promise<LensDefinition[]> {
    const user = await this.lenses.list();
    const builtInIds = new Set(BUILT_IN_LENSES.map((l) => l.id));
    return [...BUILT_IN_LENSES.map((l) => ({ ...l })), ...user.filter((l) => !builtInIds.has(l.id))];
  }

  async snapshotFor(clientId: string): Promise<WorldObject[]> {
    const subscription = this.subscriptions.get(clientId);
    const objects = await this.activeObjects();
    return subscription ? filterObjects(objects, subscription) : [...objects];
  }

  feedItems(limit: number, minimumSeverity?: FeedItem['severity']): FeedItem[] {
    return this.feed.recent({ limit, ...(minimumSeverity ? { minimumSeverity } : {}) });
  }

  settingsSnapshot(): ContractSettings {
    const current = this.settings.get();
    // Provider enablement is authoritative in the host, not in the file.
    const providers: ContractSettings['providers'] = { ...current.providers };
    for (const p of this.providerHost.list()) providers[p.manifest.id] = { enabled: p.enabled };
    return { ...current, providers, demoMode: this.demoMode() };
  }

  setViewport(bounds: GeoBounds | undefined): void {
    this.viewport = bounds;
    this.providerHost.setViewport(bounds);
  }

  /** Search bias: the centre of the last reported viewport, else the configured default. */
  defaultBias(): { latitude: number; longitude: number } | undefined {
    if (this.viewport) {
      return {
        latitude: (this.viewport.north + this.viewport.south) / 2,
        longitude: (this.viewport.east + this.viewport.west) / 2,
      };
    }
    return this.deps.defaultSearchBias;
  }

  /**
   * Application-level connectivity from the shell's OS monitor. The ConnectionMonitor
   * owns the final verdict (probe + source health + hysteresis); an OS "offline" signal
   * is authoritative and takes effect immediately.
   */
  setNetworkOnline(online: boolean): void {
    if (this.osOnline === online) return;
    this.osOnline = online;
    if (!online) {
      this.providerHost.setOnline(false);
      this.providerHost.health.setNetworkOnline(false);
    }
    for (const l of [...this.osListeners]) {
      try { l(online); } catch { /* ignore */ }
    }
    void this.connection.tick().catch(() => undefined);
  }


  /**
   * Reachability probe for the connection monitor: one conditional GET to a host the USGS
   * provider already allowlists, at most every 30 s, through the shared HttpClient (so it
   * obeys the same allowlist, timeout, size cap and circuit breaker as any other request).
   */
  private async probeReachability(): Promise<boolean> {
    const now = this.clock.now();
    if (now - this.lastProbeAt < PROBE_MIN_INTERVAL_MS && this.lastProbeAt !== 0) return this.providerHost.isOnline();
    this.lastProbeAt = now;
    if (!this.probeClient) {
      this.probeClient = new HttpClient({
        allowedHosts: [PROBE_HOST],
        clock: this.clock,
        logger: this.loggerHub.logger('offline'),
        defaultTimeoutMs: 5_000,
        maxRetries: 0,
        requestsPerMinute: 4,
        cacheEnabled: false,
        userAgent: `WorldView/${this.version}`,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
    }
    try {
      const res = await this.probeClient.request({ url: PROBE_URL, method: 'GET', maxBytes: 64 * 1024, timeoutMs: 5_000, allowStale: false });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  /** Persist the gateway's camera registry into the cameras-local provider settings. */
  async persistCameras(): Promise<void> {
    const entries = await this.directGateway.list();
    const cameras: JsonValue[] = entries.map((c) => ({
      cameraId: c.cameraId,
      name: c.name,
      gateway: c.gateway,
      kind: c.kind,
      ...(c.position ? { position: { latitude: c.position.latitude, longitude: c.position.longitude } } : {}),
      ...(c.headingDegrees !== undefined ? { headingDegrees: c.headingDegrees } : {}),
    }));
    await this.providerSettings.set('cameras-local', { cameras });
  }
}

export function isLiveMode(mode: string): boolean { return mode === 'LIVE' || mode === 'PAUSED'; }

export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export function defaultSettings(): ContractSettings { return { ...DEFAULT_SETTINGS }; }

function interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  const t = setInterval(fn, ms);
  if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
  return t;
}

function safeFileName(id: string): string { return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80); }

function mapSidecarStatus(state: 'ready' | 'degraded' | 'unavailable' | 'not-configured'): DiagnosticsSnapshot['sidecars'][number]['status'] {
  switch (state) {
    case 'ready': return 'running';
    case 'degraded': return 'error';
    case 'unavailable': return 'stopped';
    case 'not-configured': return 'not-configured';
  }
}

async function fileSize(file: string): Promise<number> {
  try { return (await fs.stat(file)).size; } catch { return 0; }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0 && visited < 5_000) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) stack.push(abs);
      else total += await fileSize(abs);
    }
  }
  return total;
}
