import type {
  GeoBounds,
  GeoPosition,
  JsonValue,
  TimeRange,
  WorldEvent,
  WorldObject,
  WorldQuery,
  WorldQueryResult,
  GeoRegion,
  SeverityClass,
} from '@worldview/world-model';
import type { ProviderManifest } from '@worldview/provider-sdk';
import type { SourceHealthEntry, ConnectionSnapshot } from '@worldview/source-health';
import type { StateChange, TrackPoint } from '@worldview/state-engine';
import type { LensDefinition, ResolvedMapProvider } from '@worldview/render-core';

/**
 * @worldview/ipc-contract — the typed bridge between the WORLDVIEW runtime (Electron
 * main process) and the React shell (renderer). Frozen with architecture-contract-v1.
 *
 * Rules (directive §76): every action is an allowlisted, typed request. There is no
 * generic execute/readFile/request. The renderer never receives raw secrets; it
 * receives capability results. The same interface is implemented in-process for
 * browser development and demo mode.
 */
export const IPC_CONTRACT_VERSION = 1;

// ---- request/response catalogue ---------------------------------------------

export interface WorldChangedEvent extends StateChange {
  /** Full objects for added/updated ids that match the client's subscription. */
  objects: WorldObject[];
  /** Freshness updates for refreshed ids. */
  freshness: Array<{ id: string; freshness: WorldObject['freshness'] }>;
}

export interface WorldSubscription {
  objectTypes?: string[];
  bounds?: GeoBounds;
  /** Include objects outside bounds that are selected/pinned. */
  pinnedIds?: string[];
}

/**
 * `world.subscribe` with an optional page size. A whole-world snapshot is tens of thousands
 * of objects — ~30 MB of JSON — and received in one message it is one long task on the page
 * (~180 ms measured: the IPC copy and one parse). With `pageSize`, the answer carries at
 * most that many objects and a token; the rest are fetched a page at a time through
 * `world.subscribe.more`, so the page draws frames in between.
 */
export interface WorldSubscribeRequest extends WorldSubscription {
  pageSize?: number;
}

export interface WorldSubscribeResponse {
  snapshot: WorldObject[];
  /** Objects in the whole snapshot, all pages together. */
  count: number;
  /** Present when more pages follow. */
  more?: { token: string; remaining: number };
}

/** One further page of a paged snapshot. `done` on the last. */
export interface WorldSnapshotPage {
  snapshot: WorldObject[];
  done: boolean;
}

/** Observation history on disk, per object type (history-store `usage`). */
export interface HistoryUsage {
  bytes: number;
  partitions: number;
  /** The operator's cap (Settings → History), when there is one. */
  maxBytes?: number;
  byType: Array<{ objectType: string; bytes: number; rows: number; partitions: number }>;
  /** Observations not written since start because they repeated their object's last one. */
  skippedUnchanged: number;
}

export interface MapProviderList {
  basemaps: ResolvedMapProvider[];
  terrains: ResolvedMapProvider[];
  activeBasemapId: string;
  activeTerrainId: string;
}

export type TimelineMode = 'LIVE' | 'PAUSED' | 'REPLAY' | 'HISTORICAL';

export interface TimelineState {
  mode: TimelineMode;
  /** Current time cursor (UTC ISO). In LIVE mode equals now. */
  cursor: string;
  speed: 0.25 | 1 | 5 | 20 | 60;
  /** Visible range of the timeline control. */
  range: TimeRange;
  /** Data availability windows per object type, from history. */
  availability: Array<{ objectType: string; ranges: TimeRange[] }>;
}

export interface SearchResult {
  kind: 'place' | 'object' | 'event' | 'command' | 'query';
  id: string;
  title: string;
  subtitle?: string;
  position?: GeoPosition;
  bounds?: GeoBounds;
  /**
   * For a place known only by its point: the map zoom that shows it whole (a country ~4, a
   * state ~6, a city ~10). Without it every such place was framed at city zoom.
   */
  zoom?: number;
  /** For 'query' results: the deterministic WorldQuery the text parsed into. */
  query?: WorldQuery;
  /** Where the result came from (local index, live state, provider). */
  source: 'local-index' | 'world-state' | 'worldpack' | 'command' | 'parser';
  score: number;
}

export interface CollectionItem {
  id: string;
  kind: 'location' | 'object' | 'event' | 'watchzone' | 'note' | 'lens';
  title: string;
  createdAt: string;
  updatedAt: string;
  position?: GeoPosition;
  objectId?: string;
  eventId?: string;
  watchZoneId?: string;
  lensId?: string;
  note?: string;
  tags?: string[];
}

export interface Collection {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: CollectionItem[];
}

export interface WatchZone {
  id: string;
  name: string;
  geometry: GeoRegion;
  eventTypes: string[];
  minimumSeverity?: SeverityClass;
  notifications: { inApp: boolean; desktop: boolean };
  /**
   * Escalation: desktop notifications only from this severity up (in-app follows
   * `minimumSeverity`). A zone can list every advisory and still only reach the desktop for
   * warnings. Absent: the desktop gets what the zone raises.
   */
  desktopMinimumSeverity?: SeverityClass;
  /**
   * Local hours ("HH:MM", this machine's time zone) during which the zone does not interrupt:
   * no toast and no desktop notification for anything below SEVERE. Events are still raised
   * and listed in the feed. `start` after `end` spans midnight (22:00–07:00).
   */
  quietHours?: { start: string; end: string };
  enabled: boolean;
  createdAt: string;
}

export interface FeedItem {
  id: string;
  at: string;
  eventId?: string;
  objectId?: string;
  title: string;
  subtitle?: string;
  severity: SeverityClass;
  position?: GeoPosition;
  type: string;
  /** Recorded (demo) data is always labelled. */
  recorded?: boolean;
}

export interface WorldPackSummary {
  id: string;
  name: string;
  version: string;
  installedAt: string;
  sizeBytes: number;
  bounds: GeoBounds;
  contents: string[];
  status: 'active' | 'disabled' | 'invalid';
  message?: string;
  /** Who signed the pack's manifest (ADR-007 signing); absent from older hosts. */
  signature?: WorldPackSignatureSummary;
}

/**
 * A pack's signature as the page shows it. `signed` verifies but the key is not one of the
 * operator's publishers; `trusted` is one of them; `unchecked` could not be verified by this
 * runtime; `invalid` was refused. The public key itself stays in the main process.
 */
export interface WorldPackSignatureSummary {
  status: 'unsigned' | 'signed' | 'trusted' | 'unchecked' | 'invalid';
  /** First 16 hex digits of the key's SHA-256. */
  keyId?: string;
  publisher?: string;
  reason?: string;
}

export interface WorldPackTrustSummary {
  /** Only packs signed by one of `publishers` are installed or used. */
  requireTrusted: boolean;
  publishers: Array<{ keyId: string; name: string; addedAt: string }>;
}

export interface OfflineStatus {
  connection: ConnectionSnapshot;
  packs: WorldPackSummary[];
  /** The operator's pack publishers (ADR-007 signing); absent from older hosts. */
  trust?: WorldPackTrustSummary;
  /** Which local capabilities are available right now. */
  capabilities: {
    localMap: boolean;
    localSearch: boolean;
    history: boolean;
    collections: boolean;
    localAircraft: boolean;
  };
}

export interface DiagnosticsSnapshot {
  app: {
    version: string;
    channel: 'stable' | 'prerelease' | 'dev';
    commit: string;
    demoMode: boolean;
    startedAt: string;
  };
  runtime: { electron: string; chrome: string; node: string; platform: string; arch: string };
  providers: SourceHealthEntry[];
  database: {
    status: 'ok' | 'degraded' | 'error';
    backend: string;
    sizeBytes: number;
    partitions: number;
    message?: string;
  };
  offline: OfflineStatus;
  /**
   * What the page last reported (`diagnostics.renderer`). Before any report — the page has
   * not drawn yet, or this is a headless runtime — it says unknown rather than guessing.
   */
  renderer: { active: '2D' | '3D' | 'unknown'; gpu?: string; webgl2?: boolean; fps?: number };
  sidecars: Array<{
    id: string;
    status: 'not-configured' | 'stopped' | 'running' | 'error';
    version?: string;
    message?: string;
  }>;
  updater: UpdaterState;
  disk: { dataDir: string; usedBytes: number; freeBytes?: number };
  logs: { path: string; sizeBytes: number };
  /** Memory by process kind and its recent trend; absent where it is not measured (headless runtime). */
  memory?: MemorySnapshot;
}

/**
 * What the app's processes hold, as the operating system counts it (working set), and how
 * the total has moved: flat over hours is healthy, a steady climb is a leak.
 */
export interface MemorySnapshot {
  sampledAt: string;
  /** Megabytes per process kind (`Browser` is the main process, `Tab` the page, `GPU`…). */
  processes: Array<{ type: string; count: number; workingSetMB: number }>;
  totalMB: number;
  /** The main process's JavaScript heap in use. */
  mainHeapMB: number;
  /** Totals of the recent samples, oldest first (one every ten minutes). */
  history: Array<{ at: string; totalMB: number }>;
}

export interface UpdaterState {
  channel: 'stable' | 'prerelease';
  automatic: boolean;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'disabled';
  currentVersion: string;
  availableVersion?: string;
  signed: boolean;
  message?: string;
  lastCheckedAt?: string;
}

export interface AppSettings {
  renderMode: '2D' | '3D' | 'AUTO';
  /** Set once the first-run welcome has been dismissed; persisted with the other settings. */
  firstRunCompleted: boolean;
  basemapId: string;
  terrainId: string;
  activeLensId: string;
  reducedMotion: boolean;
  textScale: number;
  updater: { automatic: boolean; prerelease: boolean };
  /**
   * Optional local services the operator supplies themselves. `go2rtcPath` is the
   * absolute path to a go2rtc binary the operator installed and verified; empty means
   * not configured, and RTSP cameras then fail with UNSUPPORTED_SCHEME rather than
   * anything being downloaded or started on their behalf (ADR-009).
   */
  cameras: { go2rtcPath: string };
  demoMode: boolean;
  privacy: { telemetry: false };
  providers: Record<string, { enabled: boolean }>;
  /**
   * Overview layers switched off in the lens rail, by the id of the category lens that
   * defines them (`aviation`, `space`, …). Stored as what is hidden, not what is shown, so a
   * category added in a later build is visible by default.
   */
  hiddenLayers: string[];
  /**
   * Map tiles kept on disk by the main process. `maxMB` caps it (least recently used tiles
   * go first); `preloadWorld` fetches the whole globe down to zoom 7 in the background —
   * off by default, because whether a basemap's terms allow bulk download is the operator's
   * decision, not the app's.
   */
  tileCache: { maxMB: number; preloadWorld: boolean };
  /**
   * Observation history on disk. Over `maxMB` the oldest partitions of anything not kept
   * indefinitely are deleted first — movement tracks and satellite passes, never
   * earthquakes, infrastructure or the operator's own records.
   */
  history: { maxMB: number };
  /**
   * The reference layer: faint country and state borders and their names (Natural Earth,
   * bundled). Both on by default; either can be switched off in Settings → Map.
   */
  reference: { borders: boolean; labels: boolean };
}

/**
 * One event type a watch zone can subscribe to, with whether this installation can
 * actually produce it. An unavailable type is still listed — with the reason — rather
 * than hidden, so a zone that would never fire cannot be created by accident and the
 * absence is explained instead of silent.
 */
export interface EventTypeInfo {
  type: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
  /** Object types the producing rule consumes (empty for engine-internal events). */
  objectTypes: string[];
}

/** Human wording for each event type, used wherever one is offered or shown. */
export const EVENT_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  earthquake: 'Earthquakes',
  'wildfire-cluster': 'Wildfire clusters',
  'weather-alert': 'Weather alerts',
  storm: 'Tropical cyclones',
  launch: 'Launches',
  'satellite-decay': 'Satellite decay',
  'watch-zone-entry': 'Something enters the zone',
  'source-status-change': 'A source changes state',
});

export interface CameraSourceInput {
  name: string;
  /** rtsp://, http(s):// (MJPEG/HLS/snapshot). Credentials in the URL are moved to secure storage by main. */
  url: string;
  position?: GeoPosition;
  headingDegrees?: number;
}

export interface CameraRegistration {
  cameraId: string;
  objectId: string;
  gateway: 'direct' | 'go2rtc';
}
/** One row of `camera.list`: what the interface may know about a registered camera — never its URL. */
export interface CameraListEntry {
  cameraId: string;
  name: string;
  objectId: string;
  gateway: string;
}
export interface CameraSnapshot {
  cameraId: string;
  /** When the image was taken, as far as it is known — see `capturedAtSource`. */
  capturedAt: string;
  /**
   * Where `capturedAt` comes from. `upstream`: the image host's own Last-Modified for this
   * image. `fetched`: the host published no capture time, so this is when WORLDVIEW
   * fetched it, and the image may be older. Absent: a camera that produces the image on
   * request (a user's own camera), where the two are the same moment.
   */
  capturedAtSource?: 'upstream' | 'fetched';
  mimeType: string;
  bytes: Uint8Array;
}
export interface CameraStreamDescriptor {
  cameraId: string;
  kind: 'mjpeg' | 'hls' | 'webrtc' | 'snapshot-poll';
  url: string;
  expiresAt?: string;
}

export interface WhatChangedResult {
  region: GeoRegion;
  time: TimeRange;
  newEvents: WorldEvent[];
  endedEvents: WorldEvent[];
  statusChanges: Array<{ objectId: string; from: string; to: string; at: string }>;
  countChanges: Array<{ objectType: string; before: number; after: number }>;
  newAlerts: WorldEvent[];
}

/**
 * The full request catalogue: channel → { request, response }.
 * Channel names are the allowlist enforced by the preload/main IPC layer.
 */
export interface WorldRequests {
  'app.info': {
    request: void;
    response: {
      version: string;
      channel: 'stable' | 'prerelease' | 'dev';
      commit: string;
      demoMode: boolean;
      platform: string;
    };
  };
  'app.openExternal': { request: { url: string }; response: { opened: boolean } };
  'settings.get': { request: void; response: AppSettings };
  'settings.set': { request: Partial<AppSettings>; response: AppSettings };
  /** Basemaps and terrain this installation can actually show, with availability resolved (ADR-008). */
  'map.providers.list': { request: void; response: MapProviderList };
  'events.types.list': { request: void; response: EventTypeInfo[] };

  'world.query': { request: WorldQuery; response: WorldQueryResult<WorldObject> };
  'world.get': { request: { objectId: string }; response: WorldObject | null };
  'world.track': { request: { objectId: string; time?: TimeRange }; response: TrackPoint[] };
  'world.events': { request: WorldQuery; response: WorldQueryResult<WorldEvent> };
  'world.event': { request: { eventId: string }; response: WorldEvent | null };
  'world.subscribe': { request: WorldSubscribeRequest; response: WorldSubscribeResponse };
  /** The next page of the snapshot `token` names; NOT_FOUND once it has expired or been replaced. */
  'world.subscribe.more': { request: { token: string }; response: WorldSnapshotPage };
  'world.related': {
    request: { objectId?: string; eventId?: string };
    response: { objects: WorldObject[]; events: WorldEvent[] };
  };
  'world.whatChanged': { request: { region: GeoRegion; time: TimeRange }; response: WhatChangedResult };
  'world.viewport': { request: { bounds: GeoBounds; zoom: number }; response: void };

  'sources.list': { request: void; response: SourceHealthEntry[] };
  'sources.manifest': { request: { providerId: string }; response: ProviderManifest | null };
  'sources.setEnabled': { request: { providerId: string; enabled: boolean }; response: void };
  'sources.refresh': { request: { providerId: string }; response: void };
  'sources.connection': { request: void; response: ConnectionSnapshot };
  'sources.settings.get': { request: { providerId: string }; response: Record<string, JsonValue> };
  'sources.settings.set': { request: { providerId: string; settings: Record<string, JsonValue> }; response: void };

  'credentials.has': { request: { key: string }; response: { present: boolean } };
  'credentials.set': { request: { key: string; value: string }; response: void };
  'credentials.delete': { request: { key: string }; response: void };

  'history.query': { request: WorldQuery; response: WorldQueryResult<WorldObject> };
  'history.availability': {
    request: { objectTypes?: string[] };
    response: Array<{ objectType: string; ranges: TimeRange[] }>;
  };
  'history.usage': { request: void; response: HistoryUsage };
  'timeline.get': { request: void; response: TimelineState };
  'timeline.set': {
    request: Partial<Pick<TimelineState, 'mode' | 'cursor' | 'speed' | 'range'>>;
    response: TimelineState;
  };

  'search.query': { request: { text: string; bias?: GeoPosition; limit?: number }; response: SearchResult[] };
  'lenses.list': { request: void; response: LensDefinition[] };
  'lenses.save': { request: LensDefinition; response: LensDefinition[] };
  'lenses.delete': { request: { id: string }; response: LensDefinition[] };

  'collections.list': { request: void; response: Collection[] };
  'collections.save': { request: Collection; response: Collection[] };
  'collections.delete': { request: { id: string }; response: Collection[] };
  'collections.export': { request: { id: string }; response: { path: string } | { cancelled: true } };
  'collections.import': { request: void; response: { imported: Collection | null; issues: string[] } };

  'watchzones.list': { request: void; response: WatchZone[] };
  'watchzones.save': { request: WatchZone; response: WatchZone[] };
  'watchzones.delete': { request: { id: string }; response: WatchZone[] };

  'feed.recent': { request: { limit?: number; minimumSeverity?: SeverityClass }; response: FeedItem[] };

  'offline.status': { request: void; response: OfflineStatus };
  'offline.installPack': { request: void; response: { installed: WorldPackSummary | null; issues: string[] } };
  'offline.removePack': { request: { id: string }; response: OfflineStatus };
  'offline.setPackEnabled': { request: { id: string; enabled: boolean }; response: OfflineStatus };
  /** Trust whoever signed an installed pack. */
  'offline.trustPublisher': { request: { packId: string; name: string }; response: OfflineStatus };
  /** Add a publisher from the `.worldpack-pub` key file they handed out (a file picker). */
  'offline.importPublisher': {
    request: void;
    response: { status: OfflineStatus; added: string | null; issues: string[] };
  };
  'offline.removePublisher': { request: { keyId: string }; response: OfflineStatus };
  'offline.setRequireTrusted': { request: { required: boolean }; response: OfflineStatus };

  'export.objects': {
    request: { query: WorldQuery; format: 'geojson' | 'json' | 'csv' };
    response: { path: string; skippedProviders: string[] } | { cancelled: true };
  };

  'camera.register': { request: CameraSourceInput; response: CameraRegistration };
  'camera.snapshot': { request: { cameraId: string }; response: CameraSnapshot };
  'camera.stream': { request: { cameraId: string }; response: CameraStreamDescriptor };
  'camera.unregister': { request: { cameraId: string }; response: void };
  'camera.list': { request: void; response: CameraListEntry[] };

  'diagnostics.get': { request: void; response: DiagnosticsSnapshot };
  'diagnostics.export': { request: void; response: { path: string; redacted: true } | { cancelled: true } };
  /** The page telling the runtime what it draws with, for Diagnostics and the exported bundle. */
  'diagnostics.renderer': {
    request: { active: '2D' | '3D'; webgl2: boolean; gpu?: string; fps?: number };
    response: void;
  };

  'updater.state': { request: void; response: UpdaterState };
  'updater.check': { request: void; response: UpdaterState };
  'updater.install': { request: void; response: UpdaterState };

  /** The desktop's disk tile cache (apps/desktop/src/main/tile-cache.ts). */
  'tiles.status': { request: void; response: TileCacheStatus };
  'tiles.clear': { request: void; response: TileCacheStatus };
  /** The camera settled here: fetch the next levels of this source's tiles for it. */
  'tiles.prefetch': { request: { sourceId: string; bounds: GeoBounds; zoom: number }; response: void };
}

/**
 * The disk tile cache, as Settings shows it. `available` is false where there is none — the
 * browser demo, or a development build served over http.
 */
export interface TileCacheStatus {
  available: boolean;
  bytes: number;
  tiles: number;
  maxBytes: number;
  preload: { state: 'off' | 'running' | 'done' | 'stopped'; done: number; total: number; message?: string };
}

export type RequestChannel = keyof WorldRequests;
export type RequestOf<C extends RequestChannel> = WorldRequests[C]['request'];
export type ResponseOf<C extends RequestChannel> = WorldRequests[C]['response'];

/** Events pushed from the runtime to the shell. */
export interface WorldEvents {
  'world.changed': WorldChangedEvent;
  'sources.changed': { entries: SourceHealthEntry[]; connection: ConnectionSnapshot };
  'connection.changed': ConnectionSnapshot;
  'timeline.changed': TimelineState;
  'feed.item': FeedItem;
  notification: {
    id: string;
    title: string;
    body: string;
    severity: SeverityClass;
    eventId?: string;
    watchZoneId?: string;
  };
  'updater.changed': UpdaterState;
  'offline.changed': OfflineStatus;
  'settings.changed': AppSettings;
  'lenses.changed': LensDefinition[];
}

export type EventChannel = keyof WorldEvents;

export const REQUEST_CHANNELS: readonly RequestChannel[] = Object.freeze([
  'app.info',
  'app.openExternal',
  'settings.get',
  'settings.set',
  'map.providers.list',
  'events.types.list',
  'world.query',
  'world.get',
  'world.track',
  'world.events',
  'world.event',
  'world.subscribe',
  'world.subscribe.more',
  'world.related',
  'world.whatChanged',
  'world.viewport',
  'sources.list',
  'sources.manifest',
  'sources.setEnabled',
  'sources.refresh',
  'sources.connection',
  'sources.settings.get',
  'sources.settings.set',
  'credentials.has',
  'credentials.set',
  'credentials.delete',
  'history.query',
  'history.availability',
  'history.usage',
  'timeline.get',
  'timeline.set',
  'search.query',
  'lenses.list',
  'lenses.save',
  'lenses.delete',
  'collections.list',
  'collections.save',
  'collections.delete',
  'collections.export',
  'collections.import',
  'watchzones.list',
  'watchzones.save',
  'watchzones.delete',
  'feed.recent',
  'offline.status',
  'offline.installPack',
  'offline.removePack',
  'offline.setPackEnabled',
  'offline.trustPublisher',
  'offline.importPublisher',
  'offline.removePublisher',
  'offline.setRequireTrusted',
  'export.objects',
  'camera.register',
  'camera.snapshot',
  'camera.stream',
  'camera.unregister',
  'camera.list',
  'diagnostics.get',
  'diagnostics.export',
  'diagnostics.renderer',
  'updater.state',
  'updater.check',
  'updater.install',
  'tiles.status',
  'tiles.clear',
  'tiles.prefetch',
]);

export const EVENT_CHANNELS: readonly EventChannel[] = Object.freeze([
  'world.changed',
  'sources.changed',
  'connection.changed',
  'timeline.changed',
  'feed.item',
  'notification',
  'updater.changed',
  'offline.changed',
  'settings.changed',
  'lenses.changed',
]);

/** Channel names as they appear on the wire (namespaced to avoid collisions with Electron internals). */
export const IPC_PREFIX = 'worldview:';
export function wireChannel(channel: RequestChannel | EventChannel): string {
  return `${IPC_PREFIX}${channel}`;
}

/**
 * WorldClient — what the shell consumes. Implemented by the preload bridge
 * (Electron) and by an in-process runtime client (browser dev, demo, tests).
 */
export interface WorldClient {
  readonly contractVersion: number;
  request<C extends RequestChannel>(channel: C, request: RequestOf<C>): Promise<ResponseOf<C>>;
  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E]) => void): () => void;
}

/** Bridge shape exposed on `window.worldview` by the preload script. */
export interface WorldBridge extends WorldClient {
  readonly platform: string;
}

declare global {
  interface Window {
    worldview?: WorldBridge;
  }
}

/** Structured IPC error transferred to the renderer (never includes stack traces or secrets). */
export interface IpcError {
  code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'DENIED' | 'UNAVAILABLE' | 'INTERNAL' | 'CANCELLED';
  message: string;
  channel: string;
}

export function isIpcError(v: unknown): v is IpcError {
  return typeof v === 'object' && v !== null && 'code' in v && 'channel' in v && 'message' in v;
}
