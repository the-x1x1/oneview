import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { systemClock, type Clock, type GeoBounds, type JsonValue, type WorldObject } from '@worldview/world-model';
import { HttpClient, LoggerHub, RingBufferSink, type Logger } from '@worldview/core';
import { type ProviderDataPolicy, type ProviderManifest, type WorldProvider } from '@worldview/provider-sdk';
import { ProviderHost, type ObservationBatch } from '@worldview/provider-runtime';
import { WorldState } from '@worldview/state-engine';
import {
  HistoryStore,
  TimelineController,
  createHistoryBackend,
  type HistoryBackendKind,
} from '@worldview/history-store';
import { EventEngine, FeedBuilder, WatchZoneEvaluator, mayInterrupt, severityAtLeast } from '@worldview/event-engine';
import {
  BuiltinGazetteer,
  CompositeGazetteer,
  isReferenceLabelsFile,
  referenceGazetteer,
  type Gazetteer,
  type HistoryReader,
} from '@worldview/query-engine';
import { ConnectionMonitor, WorldPackRegistry } from '@worldview/offline';
import {
  CameraHub,
  CameraRelay,
  DirectGateway,
  Go2rtcGateway,
  Go2rtcSidecar,
  PublicFrameRegistry,
  createFetchByteFetcher,
  createFetchUpstreamOpener,
  type RegisteredCamera,
  type SecretStore,
  type SpawnFn,
} from '@worldview/camera-gateway';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  SettingsStore,
  dataDirs,
  ensureDataDirs,
  type DataDirs,
} from '@worldview/config';
import { DiagnosticsCollector } from '@worldview/diagnostics';
import { UpdaterController, createInertAutoUpdater, policyInputFromSettings } from '@worldview/updater';
import { BUILT_IN_LENSES, type LensDefinition } from '@worldview/render-core';
import type {
  AppSettings as ContractSettings,
  Collection,
  DiagnosticsSnapshot,
  FeedItem,
  OfflineStatus,
  WatchZone,
} from '@worldview/ipc-contract';
import {
  createAllProviders,
  createSatelliteReprojector,
  loadConnectorDefinitions,
  providerIds as bundledProviderIds,
} from '@worldview/providers';
import type { HostBridge, RuntimeCredentialStore, WorldRuntimeDeps } from './deps.js';
import { inProcessHostBridge } from './deps.js';
import { RuntimeEmitter } from './support/emitter.js';
import { JsonDocStore } from './support/json-doc-store.js';
import {
  FileProviderCache,
  ProviderSettingsStore,
  createLocalAccess,
  deniedProviderCache,
  isLoopbackHost,
} from './support/provider-storage.js';
import { createMqtt } from './support/mqtt-client.js';
import { createLocalListener } from './support/local-listener.js';
import { LateGazetteer, PlaceIndexGazetteer } from './support/gazetteer.js';
import { SubscriptionRegistry, deltaFor, diffObjectSets, filterObjects } from './support/subscriptions.js';
import { SnapshotPages } from './support/snapshot-pages.js';
import { createDemoProviders } from './demo/index.js';
import {
  validateCollection,
  validateLens,
  validateStoredCamera,
  validateWatchZone,
  type StoredCamera,
} from './validate.js';

const DEFAULT_SWEEP_MS = 15_000;
const DEFAULT_FLUSH_MS = 250;
// Tiers start at 5 and 30 minutes (history-store TRACK_DOWNSAMPLE_TIERS); a sweep every six
// hours meant an hour of aircraft sat at full resolution for up to six.
const DEFAULT_RETENTION_MS = 15 * 60_000;
const FIRST_RETENTION_DELAY_MS = 2 * 60_000;
const SOURCES_UPDATE_THROTTLE_MS = 5_000;
const SIZE_CAP_CHECK_MS = 10 * 60_000;
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
  } catch {
    return undefined;
  }
}

/** In-memory credentials for browser/demo composition — nothing is ever written to disk. */
class MemoryCredentialStore implements RuntimeCredentialStore {
  private readonly values = new Map<string, string>();
  private readonly listeners = new Set<(key: string) => void>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    this.fire(key);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.fire(key);
  }
  onChange(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private fire(key: string): void {
    for (const l of [...this.listeners]) l(key);
  }
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
const defaultSpawn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, shell: false, stdio: 'ignore', windowsHide: true });

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
  /** The unfetched rest of paged world.subscribe snapshots (support/snapshot-pages.ts). */
  readonly snapshotPages = new SnapshotPages(() => this.clock.now());

  settings!: SettingsStore;
  providerHost!: ProviderHost;
  private sourcesTimer: ReturnType<typeof setInterval> | undefined;
  /** What the page last said it draws with (`diagnostics.renderer`). */
  rendererReport: { active: '2D' | '3D'; webgl2: boolean; gpu?: string; fps?: number } | undefined;
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
  /** Registered cameras on disk (URLs and credential keys, never secrets). */
  cameraStore!: JsonDocStore<StoredCamera>;
  directGateway!: DirectGateway;
  publicFrames!: PublicFrameRegistry;
  /** Providers that have sent camera observations (see onBatch). */
  private readonly cameraProviders = new Set<string>();
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
  /** Countries, states and provinces from the map's label file, once read (search by name). */
  readonly referencePlaces = new LateGazetteer();
  historyReader!: HistoryReader;

  /** Most recent failed history read, surfaced in Diagnostics until the next success. */
  lastHistoryReadError: { at: string; message: string } | undefined;

  /** Record or clear the history-read failure Diagnostics reports. */
  noteHistoryRead(error: string | undefined): void {
    this.lastHistoryReadError =
      error === undefined ? undefined : { at: new Date(this.clock.now()).toISOString(), message: error };
  }

  /** Last viewport the shell reported; biases search and bounds-query providers. */
  viewport: GeoBounds | undefined;
  /** What the shell's OS network monitor last reported through `setNetworkOnline`. */
  osOnline = true;
  private osListeners = new Set<(online: boolean) => void>();
  private historyOpen = false;
  private lastProbeAt = 0;
  private probeClient: HttpClient | undefined;
  private projected = new Map<string, WorldObject>();
  /** Whether `projected` is what the shell holds (a projection has run since leaving live). */
  private projectedActive = false;
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

    this.settings =
      this.deps.settings ??
      (
        await SettingsStore.open({
          file: this.dirs.settingsFile,
          // The version the startup migrations brought the file to. A literal 1 here meant
          // every save wrote the document back as version 1, and each start re-ran every
          // migration after it.
          schemaVersion: CURRENT_SCHEMA_VERSION,
          logger: this.loggerHub.logger('app'),
          now: () => this.clock.now(),
        })
      ).store;
    this.providerSettings = new ProviderSettingsStore(
      path.join(this.dirs.root, 'provider-settings.json'),
      this.loggerHub.logger('provider'),
    );
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
      cacheStore: (providerId, cacheAllowed) =>
        cacheAllowed
          ? new FileProviderCache(
              path.join(this.dirs.cacheDir, `${safeFileName(providerId)}.json`),
              this.clock,
              true,
              this.loggerHub.logger('provider'),
            )
          : deniedProviderCache,
      settingsStore: (providerId) => this.providerSettings.view(providerId),
      localAccess: (providerId, allowedHosts, trustedHosts, grantedFolder, grantedFolderDeclared) =>
        createLocalAccess({
          allowedHosts,
          trustedHosts,
          // A provider that declares a granted-folder setting reads only the folder the user
          // named (nothing while it is empty) and may convert with the user's ogr2ogr; the
          // others read the bundled resources, or a per-provider grant the app injected.
          grantDir: grantedFolderDeclared ? grantedFolder : () => this.grantDirFor(providerId),
          ogr2ogr: grantedFolderDeclared,
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        }),
      // The one listener (ADR-003 amendment): HTTP on 127.0.0.1 for local-process sources,
      // the bearer token compared here against the credential store.
      listen: (_providerId, resolveSecret) => createLocalListener({ resolveSecret }),
      // MQTT (ADR-003 amendment): the runtime's own 3.1.1 subscriber, to loopback hosts the
      // manifest names or the one the user named, with the provider's own credential keys.
      mqtt: (_providerId, allowedHosts, trustedHosts, resolveSecret) =>
        createMqtt({
          allowed: (host) => {
            const named = trustedHosts().some((t) => t.toLowerCase() === host);
            return named || (isLoopbackHost(host) && allowedHosts.some((a) => a.toLowerCase() === host));
          },
          resolveSecret,
          ...(this.deps.mqttConnect ? { connect: this.deps.mqttConnect } : {}),
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
        const enabled = disabled.has(id) ? false : (configured ?? provider.manifest.enabledByDefault);
        this.providerHost.register(provider, { enabled });
      } catch (err) {
        // A provider with an invalid manifest must never stop the application from starting.
        this.log.error('provider not registered', {
          providerId: provider.manifest?.id ?? 'unknown',
          error: errorText(err),
        });
      }
    }
  }

  private providerList(): WorldProvider[] {
    if (this.deps.providerInstances) return [...this.deps.providerInstances];
    if (this.demo) return createDemoProviders(this.deps.resourcesDir);
    return createAllProviders({ ...(this.deps.providers ?? {}), connectorDefinitions: this.connectorDefinitions() });
  }

  /**
   * Sources configured as data (ADR-013): `connectors/enabled/*.json` under the resources
   * directory (reviewed, shipped) and `connectors/*.json` under the data directory (the
   * operator's own). A file that does not validate is logged and skipped; the id of a
   * hand-written provider cannot be reused.
   */
  private connectorDefinitions(): ReturnType<typeof loadConnectorDefinitions>['definitions'] {
    const explicit = this.deps.providers?.connectorDefinitions;
    if (explicit) return [...explicit];
    const loaded = loadConnectorDefinitions(
      {
        ...(this.deps.resourcesDir ? { bundledDir: path.join(this.deps.resourcesDir, 'connectors', 'enabled') } : {}),
        userDir: path.join(this.dirs.root, 'connectors'),
      },
      bundledProviderIds(),
    );
    for (const p of loaded.problems)
      this.log.warn('connector definition rejected', { file: p.file, errors: p.errors.slice(0, 5) });
    for (const w of loaded.warnings)
      this.log.info('connector definition notes', { file: w.file, warnings: w.warnings.slice(0, 5) });
    if (loaded.definitions.length)
      this.log.info('connector definitions loaded', {
        count: loaded.definitions.length,
        ids: loaded.definitions.map((d) => `${d.id} (${d.connector})`),
      });
    return loaded.definitions;
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
    // Replay puts satellites where their element sets say they were at the cursor, not where
    // the first propagation of each set happened to leave them (provider-celestrak reproject.ts).
    const satellites = createSatelliteReprojector();
    void satellites
      .prepare()
      .catch((err: unknown) =>
        this.loggerHub
          .logger('history')
          .warn('satellite replay uses stored positions: propagator unavailable', { error: errorText(err) }),
      );
    this.history = new HistoryStore({
      dataDir: this.dirs.historyDir,
      backend: created.backend,
      clock: this.clock,
      logger: this.loggerHub.logger('history'),
      reprojectors: [satellites],
      policies: (providerId) => this.policyFor(providerId),
      providerInfo: (providerId) => {
        const m = this.providerHost.manifest(providerId);
        return m
          ? { sourceName: m.name, ...(m.attribution.text ? { attribution: m.attribution.text } : {}) }
          : undefined;
      },
      requestedBackend: created.requestedBackend,
      ...(created.fallbackReason !== undefined ? { fallbackReason: created.fallbackReason } : {}),
    });
    await this.history.open();
    this.history.setMaxBytes(this.settings.get().history.maxMB * 1024 * 1024);
    this.historyOpen = true;

    this.timeline = new TimelineController({ history: this.history, clock: this.clock });
    // The adapter that lets query-engine read history without knowing the store.
    this.historyReader = {
      objectsAt: (cursor, opts) =>
        this.history.snapshotAt(cursor, {
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
    const builtin = new BuiltinGazetteer();
    this.gazetteer = new CompositeGazetteer([
      new PlaceIndexGazetteer(() => this.packs.placeIndex()),
      builtin,
      this.referencePlaces,
    ]);
    void this.loadReferencePlaces(builtin);

    // The OS signal is the injected one AND whatever the shell last told us through
    // `setNetworkOnline`; either saying "offline" is authoritative.
    const injected = this.deps.network;
    const network = {
      isOnline: () => this.osOnline && (injected?.isOnline() ?? true),
      subscribe: (listener: (online: boolean) => void) => {
        this.osListeners.add(listener);
        const off = injected?.subscribe?.((online) => listener(online && this.osOnline));
        return () => {
          this.osListeners.delete(listener);
          off?.();
        };
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
    // Camera credentials go to the same OS-protected store as provider keys (DPAPI on
    // Windows), under the reserved `camera.<id>.credential` key space — not to memory,
    // which would lose them on every restart and contradict what the operator guide
    // promises. `credentials` is `MemoryCredentialStore` only in tests and browser dev.
    this.cameraSecrets = {
      get: (key) => this.credentials.get(key),
      set: (key, value) => this.credentials.set(key, value),
      delete: (key) => this.credentials.delete(key),
    };
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
      openUpstream: createFetchUpstreamOpener(fetchImpl),
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
    if (started)
      await this.go2rtcGateway
        .syncStreams()
        .catch((err: unknown) => this.log.warn('go2rtc stream sync failed', { error: errorText(err) }));
    else this.log.warn('go2rtc sidecar did not start', { status: this.go2rtc.status().status });
    return started;
  }

  /** Apply a changed `cameras.go2rtcPath`; a running sidecar is stopped before the swap. */
  async applyGo2rtcSetting(): Promise<void> {
    await this.go2rtc.setBinaryPath(this.settings.get().cameras.go2rtcPath);
  }

  /**
   * Re-register the cameras from `cameras.json` into their gateways. Without this a
   * camera survived a restart as a marker on the map (the provider draws it from its
   * own settings) but had no registration behind it, so every snapshot and stream
   * request failed with NOT_FOUND — visible, and broken.
   */
  /** Read the map's label file and make its places searchable; search works without it meanwhile. */
  private async loadReferencePlaces(builtin: BuiltinGazetteer): Promise<void> {
    const file = this.deps.referenceLabelsPath;
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!isReferenceLabelsFile(parsed)) {
        this.log.warn('reference places not loaded', { reason: 'not a reference labels file' });
        return;
      }
      // What the built-in gazetteer already has (it carries bounds) is left to it.
      const known = (name: string, kind: import('@worldview/query-engine').PlaceKind) =>
        builtin.lookup(name, { kinds: [kind], limit: 1 }).some((h) => h.score >= 1 && h.name === name);
      const gazetteer = referenceGazetteer(parsed, known);
      this.referencePlaces.set(gazetteer);
      this.log.info('reference places loaded', { countries: parsed.countries.length, regions: parsed.states.length });
    } catch (err) {
      this.log.warn('reference places not loaded', {
        reason: err instanceof Error ? err.message.slice(0, 160) : 'error',
      });
    }
  }

  private async restoreCameras(): Promise<void> {
    const stored = await this.cameraStore.list();
    if (stored.length === 0) return;
    const direct: RegisteredCamera[] = [];
    const viaSidecar: RegisteredCamera[] = [];
    for (const c of stored) {
      const { id: _id, ...record } = c;
      (record.kind === 'rtsp' ? viaSidecar : direct).push(record as RegisteredCamera);
    }
    this.directGateway.restore(direct);
    this.go2rtcGateway.restore(viaSidecar);
    this.log.info('cameras restored', { direct: direct.length, go2rtc: viaSidecar.length });
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
    this.cameraStore = new JsonDocStore<StoredCamera>(this.dirs.camerasFile, validateStoredCamera, log);
    await this.collections.load();
    await this.restoreCameras();
    await this.lenses.load();
    const zones = await this.watchZoneStore.load();
    this.watchZones.setZones(zones);
  }

  private buildUpdater(): void {
    this.updater = new UpdaterController({
      updater: this.deps.updater ?? createInertAutoUpdater(),
      currentVersion: this.version,
      policy: () =>
        policyInputFromSettings(this.settings.get().updater, this.deps.build ?? { signed: false, packaged: false }),
      logger: this.loggerHub.logger('updater'),
      now: () => this.clock.now(),
    });
  }

  private buildDiagnostics(): void {
    this.diagnostics = new DiagnosticsCollector(
      {
        app: () => ({
          version: this.version,
          channel: this.channel,
          commit: this.commit,
          demoMode: this.demoMode(),
          startedAt: this.startedAt,
        }),
        runtime: () =>
          this.deps.runtimeInfo?.() ?? {
            electron: 'n/a',
            chrome: 'n/a',
            node: process.version,
            platform: this.platform,
            arch: process.arch,
          },
        providers: () => this.providerHost.health.list(),
        memory: () => this.deps.memoryInfo?.(),
        database: async () => {
          const d = await this.history.diagnostics();
          // A read that failed is reported even when the store itself looks healthy: a
          // truncated track is otherwise indistinguishable from an object with no history.
          const failure = this.lastHistoryReadError;
          const message = failure
            ? `${d.message ? `${d.message}; ` : ''}last read failed at ${failure.at}: ${failure.message}`
            : d.message;
          return {
            status: failure && d.status === 'ok' ? 'degraded' : d.status,
            backend: d.kind,
            sizeBytes: d.sizeBytes,
            partitions: d.partitions,
            ...(message ? { message } : {}),
          };
        },
        offline: () => this.offlineStatus(),
        renderer: () => this.deps.rendererInfo?.() ?? this.rendererReport ?? { active: 'unknown' },
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
      },
      { logger: this.loggerHub.logger('diagnostics'), now: () => this.clock.now() },
    );
  }

  // ---- wiring ---------------------------------------------------------------

  private wire(): void {
    this.detach.push(this.providerHost.onObservations((batch) => this.onBatch(batch)));
    this.detach.push(this.providerHost.onOverlays((overlays) => this.emitter.emit('overlays.changed', { overlays })));
    this.detach.push(
      this.state.onChange((change) => {
        void this.onStateChange(change);
      }),
    );
    this.detach.push(this.events.attach(this.state));
    this.detach.push(this.events.on('event', ({ event }) => this.onEvent(event)));
    const emitSources = () => {
      if (this.sourcesTimer) clearTimeout(this.sourcesTimer);
      this.sourcesTimer = undefined;
      this.emitter.emit('sources.changed', {
        entries: this.providerHost.health.list(),
        connection: this.connectionSnapshot(),
      });
    };
    this.detach.push(
      this.providerHost.health.on('change', () => {
        // A provider coming up or going down is a real connectivity observation, so the
        // monitor re-evaluates: together with its own SourceHealthRegistry subscription
        // this gives the two agreeing evaluations its hysteresis asks for, and the
        // indicator follows the sources instead of waiting for the next 30 s probe.
        void this.connection.tick().catch(() => undefined);
        emitSources();
      }),
    );
    // A successful poll changes a source's lastSuccess without a status transition. The
    // shell was told only about transitions, so Sources read "updated 28m ago" for feeds
    // polling every 15 s. Those updates go out too, at most every few seconds.
    this.detach.push(
      this.providerHost.health.on('update', () => {
        this.sourcesTimer ??= later(emitSources, this.deps.sourcesUpdateThrottleMs ?? SOURCES_UPDATE_THROTTLE_MS);
      }),
    );
    this.detach.push(() => {
      if (this.sourcesTimer) clearTimeout(this.sourcesTimer);
    });
    this.detach.push(
      this.connection.on('change', (snapshot) => {
        this.providerHost.setOnline(snapshot.state !== 'OFFLINE');
        this.emitter.emit('connection.changed', snapshot);
        this.emitter.emit('offline.changed', this.offlineStatus());
      }),
    );
    this.detach.push(
      this.packs.on('changed', () => {
        this.emitter.emit('offline.changed', this.offlineStatus());
      }),
    );
    this.detach.push(
      this.timeline.onChange((state) => {
        this.emitter.emit('timeline.changed', state);
        if (!isLiveMode(state.mode)) void this.projectHistorical();
      }),
    );
    this.detach.push(
      this.settings.onChange((settings) => {
        this.emitter.emit('settings.changed', settings as ContractSettings);
        this.updater.applyPolicy();
        this.history.setMaxBytes(settings.history.maxMB * 1024 * 1024);
      }),
    );
    this.detach.push(
      this.updater.onChange((state) => {
        this.emitter.emit('updater.changed', state);
      }),
    );
    this.detach.push(
      this.feed.on('item', (item) => {
        this.emitter.emit('feed.item', item);
      }),
    );
  }

  private onBatch(batch: ObservationBatch): void {
    this.state.ingest(batch.observations, {
      snapshot: batch.snapshot,
      providerId: batch.providerId,
      ...(batch.freshness ? { freshness: batch.freshness } : {}),
    });
    this.history.writeBatch(batch);
    // Camera objects are the only source of public frame refs the gateway will resolve.
    // Re-derived only when cameras can have changed: a batch that carries some, or one from
    // a provider that has carried some (its snapshot may have dropped them). Aircraft and
    // ship batches arrive every few seconds and would otherwise re-parse ~10k frame URLs each.
    const carriesCameras = batch.observations.some((o) => o.objectType === 'camera');
    if (carriesCameras) this.cameraProviders.add(batch.providerId);
    if (carriesCameras || this.cameraProviders.has(batch.providerId)) this.syncPublicFrames();
  }

  private syncPublicFrames(): void {
    this.publicFrames.syncFromObjects(this.state.ofType('camera'));
  }

  private async onStateChange(change: import('@worldview/state-engine').StateChange): Promise<void> {
    for (const id of change.removed) this.watchZones.forgetObject(id);
    // A camera that left the world (its provider switched off, say) stops being fetchable now.
    if (change.removed.some((id) => id.startsWith('camera:'))) this.syncPublicFrames();

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
    // The zone's own switches, and its quiet hours (local time), decide what interrupts. The
    // in-app switch used to be ignored: switched off, a zone still raised a toast.
    const local = new Date(this.clock.now());
    if (!mayInterrupt(hit.zone, hit.notification.severity, local.getHours() * 60 + local.getMinutes())) return;
    if (hit.zone.notifications.inApp) this.emitter.emit('notification', hit.notification);
    if (
      hit.zone.notifications.desktop &&
      severityAtLeast(hit.notification.severity, hit.zone.desktopMinimumSeverity ?? 'INFO')
    ) {
      try {
        this.hostBridge.showNotification({ title: hit.notification.title, body: hit.notification.body });
      } catch {
        /* the shell may not support it */
      }
    }
  }

  private publishDelta(
    change: import('@worldview/state-engine').StateChange,
    lookup: (id: string) => WorldObject | undefined,
  ): void {
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

  isLive(): boolean {
    return isLiveMode(this.timeline.currentMode);
  }

  /** Recompute the historical projection and push the difference to subscribers. */
  async projectHistorical(): Promise<void> {
    if (this.projecting || this.stopped) return;
    this.projecting = true;
    try {
      const objects = await this.timeline.snapshotAt(this.timeline.cursor);
      const next = new Map(objects.map((o) => [o.id, o] as const));
      // The first projection after leaving live is diffed against what the shell holds —
      // live state — not against an empty set: diffed against nothing it only added, and every
      // live object with no history at the cursor stayed on the map, a live aircraft or a
      // satellite's live position shown as if it were the past.
      const previous = this.projectedActive
        ? this.projected
        : new Map([...this.state.all()].map((o) => [o.id, o] as const));
      const change = diffObjectSets(previous, next, this.timeline.cursor);
      this.projectedActive = true;
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
    const wasActive = this.projectedActive;
    this.projectedActive = false;
    if (!wasActive) return;
    const change = diffObjectSets(
      this.projected,
      new Map([...this.state.all()].map((o) => [o.id, o] as const)),
      new Date(this.clock.now()).toISOString(),
    );
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
    await this.timeline
      .refreshAvailability()
      .catch((err: unknown) => this.log.warn('availability refresh failed', { error: errorText(err) }));

    this.timers.push(
      interval(() => {
        this.state.sweep();
      }, this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_MS),
    );
    const sweep = () =>
      void this.history
        .sweepRetention()
        .catch((err: unknown) => this.log.warn('retention sweep failed', { error: errorText(err) }));
    this.timers.push(interval(sweep, this.deps.retentionIntervalMs ?? DEFAULT_RETENTION_MS));
    // The first sweep does not wait a full interval: history written before write-time dedupe,
    // and anything over the size cap, is dealt with shortly after start.
    this.timers.push(later(sweep, this.deps.firstRetentionDelayMs ?? FIRST_RETENTION_DELAY_MS));
    // The size cap is checked more often than the full sweep; it only reads the index.
    this.timers.push(
      interval(() => {
        void this.history
          .enforceSizeCap()
          .catch((err: unknown) => this.log.warn('history size cap failed', { error: errorText(err) }));
      }, SIZE_CAP_CHECK_MS),
    );
    this.timers.push(
      interval(() => {
        this.onTimelineTick();
      }, TIMELINE_TICK_MS),
    );
    this.log.info('runtime started', {
      demo: this.demoMode(),
      providers: this.providerHost.list().length,
      historyBackend: this.history.backend.kind,
    });
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
    for (const off of this.detach) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.detach = [];
    this.connection.stop();
    await this.providerHost.dispose().catch(() => undefined);
    this.events.dispose();
    this.state.dispose();
    await this.cameraRelay?.stop().catch(() => undefined);
    await this.go2rtc?.stop().catch(() => undefined);
    await this.history
      .close()
      .catch((err: unknown) => this.log.warn('history close failed', { error: errorText(err) }));
    this.historyOpen = false;
    this.updater.dispose();
    this.emitter.clear();
    this.log.info('runtime stopped');
  }

  // ---- shared helpers used by the handlers ----------------------------------

  demoMode(): boolean {
    return this.demo || this.settings.get().demoMode;
  }

  /** Tile sources with something in the desktop's disk cache; none when there is no cache or it cannot say. */
  async cachedTileSources(): Promise<readonly string[]> {
    try {
      return (await this.deps.cachedTileSources?.()) ?? [];
    } catch {
      return [];
    }
  }

  policyFor(providerId: string): ProviderDataPolicy | undefined {
    return this.providerHost.manifest(providerId)?.dataPolicy;
  }

  manifests(): ProviderManifest[] {
    return this.providerHost.list().map((p) => p.manifest);
  }

  /**
   * Hosts `app.openExternal` may open: the attribution, terms and credential-help links
   * declared by the registered providers, plus the project's own pages. Derived from the
   * manifests so adding a provider never means editing an allowlist by hand.
   */
  externalHostAllowlist(): ReadonlySet<string> {
    const hosts = new Set(STATIC_EXTERNAL_HOSTS);
    for (const manifest of this.manifests()) {
      for (const url of [
        manifest.dataPolicy.termsUrl,
        manifest.attribution.url,
        ...manifest.credentials.map((c) => c.helpUrl),
      ]) {
        const host = httpsHost(url);
        if (host) hosts.add(host);
      }
    }
    return hosts;
  }

  connectionSnapshot(): OfflineStatus['connection'] {
    return this.connection.snapshot();
  }

  offlineStatus(): OfflineStatus {
    return this.packs.status(this.connectionSnapshot());
  }

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

  setViewport(bounds: GeoBounds | undefined, center?: { latitude: number; longitude: number }): void {
    this.viewport = bounds;
    this.providerHost.setViewport(bounds, center);
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
      try {
        l(online);
      } catch {
        /* ignore */
      }
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
      const res = await this.probeClient.request({
        url: PROBE_URL,
        method: 'GET',
        maxBytes: 64 * 1024,
        timeoutMs: 5_000,
        allowStale: false,
      });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  /**
   * Persist the camera registry, to two places with two different jobs:
   *
   *  - `cameras.json` holds what the *gateway* needs to serve frames again after a
   *    restart: the URL and, when the URL carried a login, the key under which the OS
   *    credential store holds it. Never the credential itself.
   *  - the `cameras-local` provider settings hold what the *provider* needs to draw a
   *    marker: id, name, position, heading. No URL, as documented — a camera's address
   *    is not something a provider settings file should carry.
   */
  async persistCameras(): Promise<void> {
    const records = [...this.directGateway.export(), ...this.go2rtcGateway.export()];
    await this.cameraStore.replaceAll(records.map((c) => ({ ...c, id: c.cameraId })));

    const cameras: JsonValue[] = records.map((c) => ({
      cameraId: c.cameraId,
      name: c.name,
      gateway: c.kind === 'rtsp' ? 'go2rtc' : 'direct',
      kind: c.kind,
      ...(c.position ? { position: { latitude: c.position.latitude, longitude: c.position.longitude } } : {}),
      ...(c.headingDegrees !== undefined ? { headingDegrees: c.headingDegrees } : {}),
    }));
    await this.providerSettings.set('cameras-local', { cameras });
  }
}

export function isLiveMode(mode: string): boolean {
  return mode === 'LIVE' || mode === 'PAUSED';
}

export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export function defaultSettings(): ContractSettings {
  return { ...DEFAULT_SETTINGS };
}

/** A one-shot timer that does not keep the process alive; cleared like the intervals on stop. */
function later(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  const t = setTimeout(fn, ms);
  if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
  return t as unknown as ReturnType<typeof setInterval>;
}

function interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  const t = setInterval(fn, ms);
  if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
  return t;
}

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function mapSidecarStatus(
  state: 'ready' | 'degraded' | 'unavailable' | 'not-configured',
): DiagnosticsSnapshot['sidecars'][number]['status'] {
  switch (state) {
    case 'ready':
      return 'running';
    case 'degraded':
      return 'error';
    case 'unavailable':
      return 'stopped';
    case 'not-configured':
      return 'not-configured';
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0 && visited < 5_000) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      visited++;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) stack.push(abs);
      else total += await fileSize(abs);
    }
  }
  return total;
}
