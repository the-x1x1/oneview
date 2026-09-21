import type { GeoBounds, GeoPosition, JsonValue, TimeRange, WorldEvent, WorldObject, WorldQuery, WorldQueryResult, GeoRegion, SeverityClass } from '@worldview/world-model';
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
}

export interface OfflineStatus {
  connection: ConnectionSnapshot;
  packs: WorldPackSummary[];
  /** Which local capabilities are available right now. */
  capabilities: { localMap: boolean; localSearch: boolean; history: boolean; collections: boolean; localAircraft: boolean };
}

export interface DiagnosticsSnapshot {
  app: { version: string; channel: 'stable' | 'prerelease' | 'dev'; commit: string; demoMode: boolean; startedAt: string };
  runtime: { electron: string; chrome: string; node: string; platform: string; arch: string };
  providers: SourceHealthEntry[];
  database: { status: 'ok' | 'degraded' | 'error'; backend: string; sizeBytes: number; partitions: number; message?: string };
  offline: OfflineStatus;
  renderer: { active: '2D' | '3D'; gpu?: string; webgl2: boolean; fps?: number };
  sidecars: Array<{ id: string; status: 'not-configured' | 'stopped' | 'running' | 'error'; version?: string; message?: string }>;
  updater: UpdaterState;
  disk: { dataDir: string; usedBytes: number; freeBytes?: number };
  logs: { path: string; sizeBytes: number };
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
  demoMode: boolean;
  privacy: { telemetry: false };
  providers: Record<string, { enabled: boolean }>;
}

export interface CameraSourceInput {
  name: string;
  /** rtsp://, http(s):// (MJPEG/HLS/snapshot). Credentials in the URL are moved to secure storage by main. */
  url: string;
  position?: GeoPosition;
  headingDegrees?: number;
}

export interface CameraRegistration { cameraId: string; objectId: string; gateway: 'direct' | 'go2rtc' }
export interface CameraSnapshot { cameraId: string; capturedAt: string; mimeType: string; bytes: Uint8Array }
export interface CameraStreamDescriptor { cameraId: string; kind: 'mjpeg' | 'hls' | 'webrtc' | 'snapshot-poll'; url: string; expiresAt?: string }

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
  'app.info': { request: void; response: { version: string; channel: 'stable' | 'prerelease' | 'dev'; commit: string; demoMode: boolean; platform: string } };
  'app.openExternal': { request: { url: string }; response: { opened: boolean } };
  'settings.get': { request: void; response: AppSettings };
  'settings.set': { request: Partial<AppSettings>; response: AppSettings };
  /** Basemaps and terrain this installation can actually show, with availability resolved (ADR-008). */
  'map.providers.list': { request: void; response: MapProviderList };

  'world.query': { request: WorldQuery; response: WorldQueryResult<WorldObject> };
  'world.get': { request: { objectId: string }; response: WorldObject | null };
  'world.track': { request: { objectId: string; time?: TimeRange }; response: TrackPoint[] };
  'world.events': { request: WorldQuery; response: WorldQueryResult<WorldEvent> };
  'world.event': { request: { eventId: string }; response: WorldEvent | null };
  'world.subscribe': { request: WorldSubscription; response: { snapshot: WorldObject[]; count: number } };
  'world.related': { request: { objectId?: string; eventId?: string }; response: { objects: WorldObject[]; events: WorldEvent[] } };
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
  'history.availability': { request: { objectTypes?: string[] }; response: Array<{ objectType: string; ranges: TimeRange[] }> };
  'timeline.get': { request: void; response: TimelineState };
  'timeline.set': { request: Partial<Pick<TimelineState, 'mode' | 'cursor' | 'speed' | 'range'>>; response: TimelineState };

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

  'export.objects': { request: { query: WorldQuery; format: 'geojson' | 'json' | 'csv' }; response: { path: string; skippedProviders: string[] } | { cancelled: true } };

  'camera.register': { request: CameraSourceInput; response: CameraRegistration };
  'camera.snapshot': { request: { cameraId: string }; response: CameraSnapshot };
  'camera.stream': { request: { cameraId: string }; response: CameraStreamDescriptor };
  'camera.unregister': { request: { cameraId: string }; response: void };
  'camera.list': { request: void; response: Array<{ cameraId: string; name: string; objectId: string; gateway: string }> };

  'diagnostics.get': { request: void; response: DiagnosticsSnapshot };
  'diagnostics.export': { request: void; response: { path: string; redacted: true } | { cancelled: true } };

  'updater.state': { request: void; response: UpdaterState };
  'updater.check': { request: void; response: UpdaterState };
  'updater.install': { request: void; response: UpdaterState };
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
  'notification': { id: string; title: string; body: string; severity: SeverityClass; eventId?: string; watchZoneId?: string };
  'updater.changed': UpdaterState;
  'offline.changed': OfflineStatus;
  'settings.changed': AppSettings;
  'lenses.changed': LensDefinition[];
}

export type EventChannel = keyof WorldEvents;

export const REQUEST_CHANNELS: readonly RequestChannel[] = Object.freeze([
  'app.info', 'app.openExternal', 'settings.get', 'settings.set', 'map.providers.list',
  'world.query', 'world.get', 'world.track', 'world.events', 'world.event', 'world.subscribe', 'world.related', 'world.whatChanged', 'world.viewport',
  'sources.list', 'sources.manifest', 'sources.setEnabled', 'sources.refresh', 'sources.connection', 'sources.settings.get', 'sources.settings.set',
  'credentials.has', 'credentials.set', 'credentials.delete',
  'history.query', 'history.availability', 'timeline.get', 'timeline.set',
  'search.query', 'lenses.list', 'lenses.save', 'lenses.delete',
  'collections.list', 'collections.save', 'collections.delete', 'collections.export', 'collections.import',
  'watchzones.list', 'watchzones.save', 'watchzones.delete',
  'feed.recent',
  'offline.status', 'offline.installPack', 'offline.removePack', 'offline.setPackEnabled',
  'export.objects',
  'camera.register', 'camera.snapshot', 'camera.stream', 'camera.unregister', 'camera.list',
  'diagnostics.get', 'diagnostics.export',
  'updater.state', 'updater.check', 'updater.install',
]);

export const EVENT_CHANNELS: readonly EventChannel[] = Object.freeze([
  'world.changed', 'sources.changed', 'connection.changed', 'timeline.changed', 'feed.item', 'notification', 'updater.changed', 'offline.changed', 'settings.changed', 'lenses.changed',
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
  interface Window { worldview?: WorldBridge }
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
