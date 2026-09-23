import type {
  GeoBounds,
  GeoPosition,
  TimeRange,
  WorldEvent,
  WorldObject,
  WorldQuery,
  WorldQueryResult,
  SeverityClass,
} from '@worldview/world-model';
import { SEVERITY_ORDER, boundsContain, regionContains } from '@worldview/world-model';
import type {
  AppSettings,
  CameraListEntry,
  Collection,
  EventChannel,
  FeedItem,
  RequestChannel,
  RequestOf,
  ResponseOf,
  SearchResult,
  TimelineState,
  UpdaterState,
  WatchZone,
  WorldClient,
  WorldEvents,
  WorldSubscription,
  DiagnosticsSnapshot,
  OfflineStatus,
} from '@worldview/ipc-contract';
import { EVENT_TYPE_LABELS, IPC_CONTRACT_VERSION } from '@worldview/ipc-contract';
import type { LensDefinition } from '@worldview/render-core';
import { BUILT_IN_LENSES, resolveMapProviders } from '@worldview/render-core';
import type { SourceHealthEntry } from '@worldview/source-health';
import type { ProviderStatus } from '@worldview/provider-sdk';
import {
  buildAircraft,
  buildCamera,
  buildEarthquakes,
  buildFireDetection,
  buildSatellite,
  buildVessels,
  buildWeatherAlert,
  demoSnapshotSvg,
  DEMO_PROVIDERS,
} from './world.js';
import { buildDemoSources, connectionFrom } from './sources.js';
import { DEMO_PLACES } from './places.js';

/**
 * DemoClient — an in-process WorldClient built from fixtures. Used by the browser dev
 * build (`dev:browser`), screenshot/CI runs and the shell's static-markup tests.
 * Everything it serves is RECORDED DATA: app.info.demoMode is true, provenance.origin
 * is 'recorded', feed items carry `recorded: true`. No network, no filesystem.
 *
 * Time is injectable (`now`) and the movers are pure functions of elapsed time, so a
 * test can call `tick(ms)` and observe deterministic world.changed events.
 */
export interface DemoClientOptions {
  now?: (() => number) | undefined;
  /** Browser hook for app.openExternal (DemoClient itself never touches the DOM). */
  openExternal?: ((url: string) => boolean) | undefined;
  /** Browser hook for exports: returns a path/label when the download was handed to the user. */
  download?: ((name: string, mimeType: string, bytes: Uint8Array) => string | null) | undefined;
  /** Start the 1 s mover clock immediately (browser); tests call tick() themselves. */
  autoTick?: boolean | undefined;
}

type Listener<E extends EventChannel> = (payload: WorldEvents[E]) => void;

export class DemoClient implements WorldClient {
  readonly contractVersion = IPC_CONTRACT_VERSION;
  private readonly now: () => number;
  private readonly startMs: number;
  private readonly openExternalHook: ((url: string) => boolean) | undefined;
  private readonly downloadHook: DemoClientOptions['download'];
  private readonly listeners = new Map<EventChannel, Set<Listener<EventChannel>>>();
  private readonly staticObjects = new Map<string, WorldObject>();
  private readonly events = new Map<string, WorldEvent>();
  private movers = new Map<string, WorldObject>();
  private sources: SourceHealthEntry[];
  /** Cameras "registered" during a demo session; discarded when the session ends. */
  private userCameras: CameraListEntry[] = [];
  private settings: AppSettings;
  private timeline: TimelineState;
  private subscription: WorldSubscription = {};
  private collections: Collection[] = [];
  private watchzones: WatchZone[] = [];
  private customLenses: LensDefinition[] = [];
  private readonly credentials = new Set<string>();
  private readonly providerSettings = new Map<string, Record<string, import('@worldview/world-model').JsonValue>>();
  private feed: FeedItem[] = [];
  private updater: UpdaterState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTickMs: number;

  constructor(options: DemoClientOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startMs = this.now();
    this.lastTickMs = this.startMs;
    this.openExternalHook = options.openExternal;
    this.downloadHook = options.download;
    const nowMs = this.startMs;
    const eq = buildEarthquakes(nowMs);
    for (const o of eq.objects) this.staticObjects.set(o.id, o);
    for (const e of eq.events) this.events.set(e.id, e);
    for (const o of [buildFireDetection(nowMs), buildWeatherAlert(nowMs), buildCamera(nowMs)])
      this.staticObjects.set(o.id, o);
    this.rebuildMovers(nowMs);
    this.sources = buildDemoSources(nowMs);
    this.settings = {
      renderMode: 'AUTO',
      firstRunCompleted: false,
      basemapId: 'natural-earth',
      terrainId: 'ellipsoid',
      activeLensId: 'overview',
      reducedMotion: false,
      textScale: 1,
      updater: { automatic: false, prerelease: false },
      cameras: { go2rtcPath: '' },
      demoMode: true,
      privacy: { telemetry: false },
      providers: Object.fromEntries(this.sources.map((s) => [s.providerId, { enabled: s.enabled }])),
      hiddenLayers: [],
      tileCache: { maxMB: 2048, preloadWorld: false },
    };
    const iso = (ms: number) => new Date(ms).toISOString();
    this.timeline = {
      mode: 'LIVE',
      cursor: iso(nowMs),
      speed: 1,
      range: { start: iso(nowMs - 24 * 3600_000), end: iso(nowMs) },
      availability: this.availability(nowMs),
    };
    this.updater = {
      channel: 'stable',
      automatic: false,
      status: 'disabled',
      currentVersion: '0.1.0-demo',
      signed: false,
      message: 'Updates are disabled in demo mode (recorded data build).',
    };
    this.feed = this.buildFeed(nowMs);
    if (options.autoTick) this.start();
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(this.now()), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Advance movers to `nowMs` and emit a world.changed delta for subscribed movers. */
  tick(nowMs: number): void {
    if (nowMs <= this.lastTickMs) return;
    this.lastTickMs = nowMs;
    this.rebuildMovers(nowMs);
    if (this.timeline.mode !== 'LIVE') return;
    const updated = [...this.movers.values()].filter((o) => this.matchesSubscription(o));
    this.emit('world.changed', {
      added: [],
      updated: updated.map((o) => o.id),
      removed: [],
      refreshed: [],
      at: new Date(nowMs).toISOString(),
      objectCount: this.allObjects().length,
      objects: updated,
      freshness: [],
    });
    if (Math.floor((nowMs - this.startMs) / 1000) % 30 === 0) this.emit('timeline.changed', this.timelineNow(nowMs));
  }

  // ---- WorldClient ---------------------------------------------------------------------------

  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<EventChannel>);
    return () => {
      set?.delete(listener as Listener<EventChannel>);
    };
  }

  private emit<E extends EventChannel>(event: E, payload: WorldEvents[E]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) (l as Listener<E>)(payload);
  }

  async request<C extends RequestChannel>(channel: C, request: RequestOf<C>): Promise<ResponseOf<C>> {
    const r = this.handle(channel, request);
    return r as ResponseOf<C>;
  }

  private handle<C extends RequestChannel>(channel: C, request: RequestOf<C>): ResponseOf<RequestChannel> {
    const nowMs = this.now();
    const iso = new Date(nowMs).toISOString();
    switch (channel) {
      case 'app.info':
        return { version: '0.1.0-demo', channel: 'dev', commit: 'demo', demoMode: true, platform: 'browser' };
      case 'app.openExternal': {
        const { url } = request as RequestOf<'app.openExternal'>;
        return { opened: this.openExternalHook ? this.openExternalHook(url) : false };
      }
      case 'settings.get':
        return this.settings;
      case 'settings.set': {
        const partial = request as RequestOf<'settings.set'>;
        this.settings = { ...this.settings, ...partial, demoMode: true, privacy: { telemetry: false } };
        if (partial.providers)
          for (const [id, v] of Object.entries(partial.providers)) this.setEnabled(id, v.enabled, nowMs);
        this.emit('settings.changed', this.settings);
        return this.settings;
      }

      case 'map.providers.list': {
        // Demo mode has no credentials and no installed packs: the catalog resolves to the
        // zero-credential entries, exactly as a fresh install would.
        const resolved = resolveMapProviders({ credentials: [], offlineBasemapAvailable: false, online: true });
        return {
          basemaps: resolved.filter((e) => e.kind === 'basemap'),
          terrains: resolved.filter((e) => e.kind === 'terrain'),
          activeBasemapId: this.settings.basemapId,
          activeTerrainId: this.settings.terrainId,
        };
      }

      case 'world.query':
        return this.queryObjects(request as WorldQuery, nowMs);
      case 'world.get': {
        const { objectId } = request as RequestOf<'world.get'>;
        return this.findObject(objectId) ?? null;
      }
      case 'world.track': {
        const { objectId } = request as RequestOf<'world.track'>;
        return this.track(objectId, nowMs);
      }
      case 'world.events': {
        const q = request as WorldQuery;
        const items = [...this.events.values()]
          .filter((e) => !q.eventTypes || q.eventTypes.includes(e.type))
          .slice(0, q.limit ?? 500);
        return {
          items,
          total: items.length,
          truncated: false,
          basis: 'live',
          evaluatedAt: iso,
        } satisfies WorldQueryResult<WorldEvent>;
      }
      case 'world.event': {
        const { eventId } = request as RequestOf<'world.event'>;
        return this.events.get(eventId) ?? null;
      }
      case 'world.subscribe': {
        this.subscription = request as WorldSubscription;
        const snapshot = this.visibleObjects(nowMs).filter((o) => this.matchesSubscription(o));
        return { snapshot, count: snapshot.length };
      }
      case 'world.related': {
        const { objectId, eventId } = request as RequestOf<'world.related'>;
        if (eventId) {
          const ev = this.events.get(eventId);
          return {
            objects: ev ? ev.objectIds.map((id) => this.findObject(id)).filter((o): o is WorldObject => !!o) : [],
            events: [],
          };
        }
        return {
          objects: [],
          events: objectId ? [...this.events.values()].filter((e) => e.objectIds.includes(objectId)) : [],
        };
      }
      case 'world.whatChanged': {
        const { region, time } = request as RequestOf<'world.whatChanged'>;
        const within = (e: WorldEvent) =>
          e.geometry?.type === 'Point' &&
          regionContains(region, { latitude: e.geometry.coordinates[1], longitude: e.geometry.coordinates[0] }) &&
          e.startAt >= time.start &&
          e.startAt <= time.end;
        const newEvents = [...this.events.values()].filter(within);
        return {
          region,
          time,
          newEvents,
          endedEvents: [],
          statusChanges: [],
          countChanges: [{ objectType: 'earthquake', before: 0, after: newEvents.length }],
          newAlerts: newEvents.filter((e) => (e.severity ? SEVERITY_ORDER[e.severity] : 0) >= SEVERITY_ORDER.MODERATE),
        };
      }
      case 'world.viewport':
        return undefined;

      case 'sources.list':
        return this.sources;
      case 'sources.manifest':
        return null; // demo has no provider manifests loaded; the panel falls back to health meta
      case 'sources.setEnabled': {
        const { providerId, enabled } = request as RequestOf<'sources.setEnabled'>;
        this.setEnabled(providerId, enabled, nowMs);
        return undefined;
      }
      case 'sources.refresh': {
        const { providerId } = request as RequestOf<'sources.refresh'>;
        this.refresh(providerId, nowMs);
        return undefined;
      }
      case 'sources.connection':
        return connectionFrom(this.sources, nowMs);
      case 'sources.settings.get': {
        const { providerId } = request as RequestOf<'sources.settings.get'>;
        return this.providerSettings.get(providerId) ?? {};
      }
      case 'sources.settings.set': {
        const { providerId, settings } = request as RequestOf<'sources.settings.set'>;
        this.providerSettings.set(providerId, settings);
        return undefined;
      }

      case 'credentials.has': {
        const { key } = request as RequestOf<'credentials.has'>;
        return { present: this.credentials.has(key) };
      }
      case 'credentials.set': {
        const { key } = request as RequestOf<'credentials.set'>;
        this.credentials.add(key);
        /* value intentionally discarded: the demo never stores secrets */ return undefined;
      }
      case 'credentials.delete': {
        const { key } = request as RequestOf<'credentials.delete'>;
        this.credentials.delete(key);
        return undefined;
      }

      case 'history.query':
        return this.queryObjects({ ...(request as WorldQuery) }, nowMs, true);
      case 'history.availability':
        return this.availability(nowMs);
      case 'timeline.get':
        return this.timelineNow(nowMs);
      case 'timeline.set': {
        const patch = request as RequestOf<'timeline.set'>;
        const next: TimelineState = { ...this.timelineNow(nowMs), ...patch };
        if (Date.parse(next.cursor) > nowMs) next.cursor = iso;
        if (next.mode === 'LIVE') next.cursor = iso;
        this.timeline = next;
        this.emit('timeline.changed', this.timeline);
        return this.timeline;
      }

      case 'search.query':
        return this.search(request as RequestOf<'search.query'>);
      case 'lenses.list':
        return [...BUILT_IN_LENSES, ...this.customLenses];
      case 'lenses.save': {
        const lens = request as LensDefinition;
        this.customLenses = [...this.customLenses.filter((l) => l.id !== lens.id), { ...lens, builtIn: false }];
        const all = [...BUILT_IN_LENSES, ...this.customLenses];
        this.emit('lenses.changed', all);
        return all;
      }
      case 'lenses.delete': {
        const { id } = request as RequestOf<'lenses.delete'>;
        this.customLenses = this.customLenses.filter((l) => l.id !== id);
        const all = [...BUILT_IN_LENSES, ...this.customLenses];
        this.emit('lenses.changed', all);
        return all;
      }

      case 'collections.list':
        return this.collections;
      case 'collections.save': {
        const c = request as Collection;
        this.collections = [...this.collections.filter((x) => x.id !== c.id), c].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return this.collections;
      }
      case 'collections.delete': {
        const { id } = request as RequestOf<'collections.delete'>;
        this.collections = this.collections.filter((c) => c.id !== id);
        return this.collections;
      }
      case 'collections.export': {
        const { id } = request as RequestOf<'collections.export'>;
        const c = this.collections.find((x) => x.id === id);
        if (!c || !this.downloadHook) return { cancelled: true };
        const path = this.downloadHook(
          `${c.name.replace(/[^a-z0-9-]+/gi, '_')}.worldview-collection.json`,
          'application/json',
          new TextEncoder().encode(JSON.stringify({ format: 'worldview-collection/1', collection: c }, null, 2)),
        );
        return path ? { path } : { cancelled: true };
      }
      case 'collections.import':
        return { imported: null, issues: ['Import needs a file picker; not available in the browser demo'] };

      case 'watchzones.list':
        return this.watchzones;
      case 'watchzones.save': {
        const z = request as WatchZone;
        this.watchzones = [...this.watchzones.filter((x) => x.id !== z.id), z];
        return this.watchzones;
      }
      case 'watchzones.delete': {
        const { id } = request as RequestOf<'watchzones.delete'>;
        this.watchzones = this.watchzones.filter((z) => z.id !== id);
        return this.watchzones;
      }

      case 'feed.recent': {
        const { limit, minimumSeverity } = request as RequestOf<'feed.recent'>;
        const min = minimumSeverity ? SEVERITY_ORDER[minimumSeverity] : 0;
        return this.feed.filter((f) => SEVERITY_ORDER[f.severity] >= min).slice(0, limit ?? 100);
      }

      case 'offline.status':
        return this.offlineStatus(nowMs);
      case 'offline.installPack':
        return {
          installed: null,
          issues: ['Worldpack installation needs a file picker; not available in the browser demo'],
        };
      case 'offline.removePack':
      case 'offline.setPackEnabled':
        return this.offlineStatus(nowMs);

      case 'export.objects': {
        const { query, format } = request as RequestOf<'export.objects'>;
        const result = this.queryObjects(query, nowMs);
        if (!this.downloadHook) return { cancelled: true };
        const body =
          format === 'csv'
            ? [
                'id,type,latitude,longitude,observedAt,freshness',
                ...result.items.map(
                  (o) =>
                    `${o.id},${o.type},${o.position?.latitude ?? ''},${o.position?.longitude ?? ''},${o.observedAt},${o.freshness}`,
                ),
              ].join('\n')
            : format === 'geojson'
              ? JSON.stringify({
                  type: 'FeatureCollection',
                  features: result.items
                    .filter((o) => o.position)
                    .map((o) => ({
                      type: 'Feature',
                      id: o.id,
                      geometry: { type: 'Point', coordinates: [o.position!.longitude, o.position!.latitude] },
                      properties: {
                        ...o.properties,
                        type: o.type,
                        observedAt: o.observedAt,
                        freshness: o.freshness,
                        attribution: o.provenance.attribution,
                      },
                    })),
                })
              : JSON.stringify({ recorded: true, exportedAt: iso, objects: result.items }, null, 2);
        const path = this.downloadHook(
          `worldview-export.${format}`,
          format === 'csv' ? 'text/csv' : 'application/json',
          new TextEncoder().encode(body),
        );
        return path ? { path, skippedProviders: [] } : { cancelled: true };
      }

      // Demo mode keeps a synthetic registry so add/remove behave coherently. It is a
      // recording, not a gateway: no URL is contacted and no credential is stored.
      // Demo mode runs the same four rules; launches and satellite decay have no
      // producer here either, and the demo says so rather than offering them.
      case 'events.types.list':
        return [
          { type: 'earthquake', label: EVENT_TYPE_LABELS['earthquake']!, available: true, objectTypes: ['earthquake'] },
          {
            type: 'wildfire-cluster',
            label: EVENT_TYPE_LABELS['wildfire-cluster']!,
            available: true,
            objectTypes: ['fire-detection'],
          },
          {
            type: 'weather-alert',
            label: EVENT_TYPE_LABELS['weather-alert']!,
            available: true,
            objectTypes: ['weather-alert'],
          },
          {
            type: 'launch',
            label: EVENT_TYPE_LABELS['launch']!,
            available: false,
            unavailableReason: 'No enabled source provides launch',
            objectTypes: ['launch'],
          },
          {
            type: 'satellite-decay',
            label: EVENT_TYPE_LABELS['satellite-decay']!,
            available: false,
            unavailableReason: 'No rule in this build produces this event',
            objectTypes: [],
          },
          { type: 'watch-zone-entry', label: EVENT_TYPE_LABELS['watch-zone-entry']!, available: true, objectTypes: [] },
          {
            type: 'source-status-change',
            label: EVENT_TYPE_LABELS['source-status-change']!,
            available: true,
            objectTypes: [],
          },
        ];

      case 'camera.register': {
        const source = request as RequestOf<'camera.register'>;
        const cameraId = demoCameraId(source.url);
        const rtsp = /^rtsps?:/i.test(source.url);
        const entry = {
          cameraId,
          name: source.name.trim().slice(0, 120),
          objectId: `camera:cameras-local:${cameraId}`,
          gateway: rtsp ? 'go2rtc' : 'direct',
        };
        this.userCameras = [...this.userCameras.filter((c) => c.cameraId !== cameraId), entry];
        return { cameraId, objectId: entry.objectId, gateway: entry.gateway as 'direct' | 'go2rtc' };
      }
      case 'camera.snapshot': {
        const capturedAt = iso;
        return {
          cameraId: (request as RequestOf<'camera.snapshot'>).cameraId,
          capturedAt,
          mimeType: 'image/svg+xml',
          bytes: new TextEncoder().encode(demoSnapshotSvg(capturedAt)),
        };
      }
      case 'camera.stream':
        return {
          cameraId: (request as RequestOf<'camera.stream'>).cameraId,
          kind: 'snapshot-poll',
          url: 'demo://cameras/synthetic-frame',
        };
      case 'camera.unregister': {
        const { cameraId } = request as RequestOf<'camera.unregister'>;
        this.userCameras = this.userCameras.filter((c) => c.cameraId !== cameraId);
        return undefined;
      }
      case 'camera.list':
        return [
          {
            cameraId: 'demo-hnl-h1-01',
            name: 'H-1 Freeway — Kalihi (demo)',
            objectId: 'camera:cctv-public:demo-hnl-h1-01',
            gateway: 'direct',
          },
          ...this.userCameras,
        ];

      case 'diagnostics.get':
        return this.diagnostics(nowMs);
      case 'diagnostics.export': {
        if (!this.downloadHook) return { cancelled: true };
        const path = this.downloadHook(
          'worldview-diagnostics.json',
          'application/json',
          new TextEncoder().encode(JSON.stringify({ redacted: true, ...this.diagnostics(nowMs) }, null, 2)),
        );
        return path ? { path, redacted: true } : { cancelled: true };
      }

      case 'updater.state':
        return this.updater;
      case 'updater.check':
        this.updater = { ...this.updater, lastCheckedAt: iso };
        this.emit('updater.changed', this.updater);
        return this.updater;
      case 'updater.install':
        return this.updater;

      // The browser demo has no disk to keep tiles on.
      case 'tiles.status':
      case 'tiles.clear':
        return { available: false, bytes: 0, tiles: 0, maxBytes: 0, preload: { state: 'off', done: 0, total: 0 } };
      case 'tiles.prefetch':
        return undefined;
    }
    throw new Error(`unknown channel ${String(channel)}`);
  }

  // ---- internals -------------------------------------------------------------------------------

  private rebuildMovers(nowMs: number): void {
    const next = new Map<string, WorldObject>();
    for (const o of [
      ...buildAircraft(nowMs, this.startMs),
      ...buildVessels(nowMs, this.startMs),
      buildSatellite(nowMs, this.startMs),
    ])
      next.set(o.id, o);
    this.movers = next;
  }

  private allObjects(): WorldObject[] {
    return [...this.staticObjects.values(), ...this.movers.values()];
  }

  private findObject(id: string): WorldObject | undefined {
    return this.staticObjects.get(id) ?? this.movers.get(id);
  }

  /** Objects for the current timeline: LIVE serves everything; a historical cursor serves only recorded earthquakes up to that time, marked HISTORICAL. */
  private visibleObjects(nowMs: number): WorldObject[] {
    const t = this.timelineNow(nowMs);
    if (t.mode === 'LIVE') return this.allObjects().filter((o) => this.enabledProvider(o.provenance.providerId));
    const cursor = t.cursor;
    return [...this.staticObjects.values()]
      .filter((o) => o.type === 'earthquake' && o.observedAt <= cursor && this.enabledProvider(o.provenance.providerId))
      .map((o) => ({ ...o, freshness: 'HISTORICAL' as const }));
  }

  private enabledProvider(providerId: string): boolean {
    return this.sources.find((s) => s.providerId === providerId)?.enabled ?? true;
  }

  private matchesSubscription(o: WorldObject): boolean {
    const s = this.subscription;
    if (s.pinnedIds?.includes(o.id)) return true;
    if (s.objectTypes && !s.objectTypes.includes(o.type)) return false;
    if (s.bounds && o.position && !boundsContain(s.bounds, o.position)) return false;
    return this.enabledProvider(o.provenance.providerId);
  }

  private queryObjects(q: WorldQuery, nowMs: number, historical = false): WorldQueryResult<WorldObject> {
    let items = historical
      ? this.visibleObjects(nowMs).filter((o) => o.type === 'earthquake')
      : this.visibleObjects(nowMs);
    if (q.objectTypes) items = items.filter((o) => q.objectTypes!.includes(o.type));
    if (q.providerIds) items = items.filter((o) => q.providerIds!.includes(o.provenance.providerId));
    if (q.region) items = items.filter((o) => o.position && regionContains(q.region!, o.position));
    if (q.time) items = items.filter((o) => o.observedAt >= q.time!.start && o.observedAt <= q.time!.end);
    if (q.text) {
      const t = q.text.toLowerCase();
      items = items.filter(
        (o) => o.id.toLowerCase().includes(t) || Object.values(o.labels).some((l) => l.toLowerCase().includes(t)),
      );
    }
    const total = items.length;
    const limit = q.limit ?? 1000;
    return {
      items: items.slice(0, limit),
      total,
      truncated: total > limit,
      basis: historical ? 'historical' : 'live',
      evaluatedAt: new Date(nowMs).toISOString(),
    };
  }

  private track(objectId: string, nowMs: number): ResponseOf<'world.track'> {
    const o = this.movers.get(objectId);
    if (!o) return [];
    const points: ResponseOf<'world.track'> = [];
    const stepMs = 10_000;
    const from = Math.max(this.startMs, nowMs - 240 * stepMs);
    for (let t = from; t <= nowMs; t += stepMs) {
      const at =
        o.type === 'aircraft'
          ? buildAircraft(t, this.startMs).find((a) => a.id === objectId)
          : o.type === 'vessel'
            ? buildVessels(t, this.startMs).find((v) => v.id === objectId)
            : buildSatellite(t, this.startMs);
      if (at?.position)
        points.push({
          observedAt: new Date(t).toISOString(),
          latitude: at.position.latitude,
          longitude: at.position.longitude,
          ...(at.position.altitudeM !== undefined ? { altitudeM: at.position.altitudeM } : {}),
        });
    }
    return points;
  }

  private availability(nowMs: number): TimelineState['availability'] {
    const eq = [...this.staticObjects.values()]
      .filter((o) => o.type === 'earthquake')
      .map((o) => Date.parse(o.observedAt));
    if (eq.length === 0) return [];
    return [
      {
        objectType: 'earthquake',
        ranges: [{ start: new Date(Math.min(...eq)).toISOString(), end: new Date(nowMs).toISOString() }],
      },
    ];
  }

  private timelineNow(nowMs: number): TimelineState {
    const iso = new Date(nowMs).toISOString();
    const t = this.timeline;
    const range: TimeRange =
      t.mode === 'LIVE'
        ? { start: new Date(nowMs - (Date.parse(t.range.end) - Date.parse(t.range.start))).toISOString(), end: iso }
        : t.range;
    return { ...t, cursor: t.mode === 'LIVE' ? iso : t.cursor, range, availability: this.availability(nowMs) };
  }

  private setEnabled(providerId: string, enabled: boolean, nowMs: number): void {
    const e = this.sources.find((s) => s.providerId === providerId);
    if (!e || e.enabled === enabled) return;
    const from = e.health.status;
    const to: ProviderStatus = enabled
      ? e.meta.credentialsRequired.some((k) => !this.credentials.has(k))
        ? 'AUTH_REQUIRED'
        : 'LIVE'
      : 'DISABLED';
    e.enabled = enabled;
    e.health = { ...e.health, status: to, ...(enabled ? { lastAttempt: new Date(nowMs).toISOString() } : {}) };
    e.transitions = [{ from, to, at: new Date(nowMs).toISOString() }, ...e.transitions].slice(0, 20);
    this.settings = { ...this.settings, providers: { ...this.settings.providers, [providerId]: { enabled } } };
    this.emit('sources.changed', { entries: this.sources, connection: connectionFrom(this.sources, nowMs) });
    this.emit('connection.changed', connectionFrom(this.sources, nowMs));
    this.emit('settings.changed', this.settings);
  }

  private refresh(providerId: string, nowMs: number): void {
    const e = this.sources.find((s) => s.providerId === providerId);
    if (!e || !e.enabled) return;
    const iso = new Date(nowMs).toISOString();
    const from = e.health.status;
    const missing = e.meta.credentialsRequired.filter((k) => !this.credentials.has(k));
    // Recorded demo: a refresh with credentials present brings AUTH_REQUIRED sources up; other states are re-attempted but keep their recorded outcome.
    const to: ProviderStatus = from === 'AUTH_REQUIRED' && missing.length === 0 ? 'LIVE' : from;
    const { message: _dropped, ...rest } = e.health;
    e.health =
      to === 'LIVE' && from !== to
        ? { ...rest, status: to, lastAttempt: iso, lastSuccess: iso, credentialState: 'present' }
        : { ...e.health, status: to, lastAttempt: iso };
    if (to !== from) e.transitions = [{ from, to, at: iso }, ...e.transitions].slice(0, 20);
    this.emit('sources.changed', { entries: this.sources, connection: connectionFrom(this.sources, nowMs) });
    this.emit('connection.changed', connectionFrom(this.sources, nowMs));
  }

  private search({ text, limit = 12 }: RequestOf<'search.query'>): SearchResult[] {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const out: SearchResult[] = [];
    for (const p of DEMO_PLACES) {
      const score = p.name.toLowerCase().startsWith(q) ? 90 : p.name.toLowerCase().includes(q) ? 60 : 0;
      if (score)
        out.push({
          kind: 'place',
          id: `place:${p.id}`,
          title: p.name,
          subtitle: `${p.region} · recorded place index`,
          position: p.position,
          bounds: p.bounds,
          source: 'local-index',
          score,
        });
    }
    for (const o of this.allObjects()) {
      const hay = [o.id, ...Object.values(o.labels)].join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
      const title = o.labels['callsign'] ?? o.labels['name'] ?? o.labels['title'] ?? o.id;
      const r: SearchResult = {
        kind: 'object',
        id: o.id,
        title,
        subtitle: `${o.type} · ${o.provenance.sourceName}`,
        source: 'world-state',
        score: title.toLowerCase().startsWith(q) ? 80 : 50,
      };
      if (o.position) r.position = o.position;
      out.push(r);
    }
    for (const e of this.events.values()) {
      if (!e.title.toLowerCase().includes(q)) continue;
      const r: SearchResult = {
        kind: 'event',
        id: e.id,
        title: e.title,
        subtitle: `${e.type} · recorded`,
        source: 'world-state',
        score: 55,
      };
      if (e.geometry?.type === 'Point')
        r.position = { latitude: e.geometry.coordinates[1], longitude: e.geometry.coordinates[0] };
      out.push(r);
    }
    return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  private buildFeed(nowMs: number): FeedItem[] {
    const items: FeedItem[] = [];
    for (const e of this.events.values()) {
      const pos: GeoPosition | undefined =
        e.geometry?.type === 'Point'
          ? { latitude: e.geometry.coordinates[1], longitude: e.geometry.coordinates[0] }
          : undefined;
      const item: FeedItem = {
        id: `feed:${e.id}`,
        at: e.startAt,
        eventId: e.id,
        title: e.title,
        subtitle: e.summary,
        severity: e.severity ?? 'INFO',
        type: e.type,
        recorded: true,
      };
      if (pos) item.position = pos;
      if (e.objectIds[0]) item.objectId = e.objectIds[0];
      items.push(item);
    }
    const alert = this.staticObjects.get('weather-alert:nws:urn-oid-2-49-0-1-840-0-demo-hawaii-hsw');
    if (alert?.position)
      items.push({
        id: 'feed:alert:hsw',
        at: alert.observedAt,
        objectId: alert.id,
        title: 'High Surf Warning — Oahu north shores',
        subtitle: 'NWS Honolulu · until this evening',
        severity: 'MODERATE',
        type: 'weather-alert',
        position: alert.position,
        recorded: true,
      });
    const fire = this.staticObjects.get('fire-detection:firms:viirs-noaa20-20260921-0530-3412');
    if (fire?.position)
      items.push({
        id: 'feed:fire:viirs',
        at: fire.observedAt,
        objectId: fire.id,
        title: 'VIIRS fire detection near Chatsworth, CA',
        subtitle: 'NOAA-20 · brightness 341 K · FRP 18 MW',
        severity: 'MINOR',
        type: 'wildfire-cluster',
        position: fire.position,
        recorded: true,
      });
    items.push({
      id: 'feed:source:aisstream',
      at: new Date(nowMs - 25 * 60_000).toISOString(),
      title: 'AISStream went OFFLINE',
      subtitle: 'websocket closed; reconnecting with backoff',
      severity: 'MINOR',
      type: 'source-status-change',
      recorded: true,
    });
    items.push({
      id: 'feed:source:celestrak',
      at: new Date(nowMs - 2 * 3600_000).toISOString(),
      title: 'CelesTrak is STALE',
      subtitle: 'serving cached elements (3 h old)',
      severity: 'INFO',
      type: 'source-status-change',
      recorded: true,
    });
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }

  private offlineStatus(nowMs: number): OfflineStatus {
    return {
      connection: connectionFrom(this.sources, nowMs),
      packs: [],
      capabilities: {
        localMap: false,
        localSearch: true,
        history: true,
        collections: true,
        localAircraft: this.enabledProvider(DEMO_PROVIDERS.aircraft.id),
      },
    };
  }

  private diagnostics(nowMs: number): DiagnosticsSnapshot {
    return {
      app: {
        version: '0.1.0-demo',
        channel: 'dev',
        commit: 'demo',
        demoMode: true,
        startedAt: new Date(this.startMs).toISOString(),
      },
      runtime: {
        electron: 'not running (browser demo)',
        chrome: 'browser',
        node: 'not available in renderer',
        platform: 'browser',
        arch: 'unknown',
      },
      providers: this.sources,
      database: {
        status: 'ok',
        backend: 'in-memory (demo)',
        sizeBytes: 0,
        partitions: 1,
        message: 'History is served from recorded fixtures',
      },
      offline: this.offlineStatus(nowMs),
      renderer: { active: this.settings.renderMode === '3D' ? '3D' : '2D', webgl2: false, gpu: 'canvas (demo host)' },
      sidecars: [
        { id: 'go2rtc', status: 'not-configured' },
        { id: 'readsb', status: 'not-configured', message: 'Demo aircraft are a recorded track' },
      ],
      updater: this.updater,
      disk: { dataDir: 'in-memory (demo)', usedBytes: 0 },
      logs: { path: 'console (demo)', sizeBytes: 0 },
    };
  }

  /** Test helper: current severity-filtered feed size. */
  feedSize(minimum?: SeverityClass): number {
    return this.feed.filter((f) => SEVERITY_ORDER[f.severity] >= (minimum ? SEVERITY_ORDER[minimum] : 0)).length;
  }
}

export function createDemoClient(options: DemoClientOptions = {}): DemoClient {
  return new DemoClient(options);
}

export type { GeoBounds };

/** A stable 12-hex id derived from the URL, the same shape the real gateway assigns. */
function demoCameraId(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    h1 = Math.imul(h1 ^ url.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + url.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}
