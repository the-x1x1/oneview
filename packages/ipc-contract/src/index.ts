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
  RasterOverlay,
} from '@worldview/world-model';
import type { ObjectDetailsAnswer, ProviderManifest } from '@worldview/provider-sdk';
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

/** The most keys one `history.readings` request may ask for. */
export const MAX_READING_KEYS = 32;

// ---- request/response catalogue ---------------------------------------------

/**
 * One point of `world.track`. Without `source` it is WORLDVIEW's own record (history store
 * or the live tail); with it, the object's source supplied it on request for the selected
 * object, and `source` is the label to show ("adsb.lol history"). `predicted` marks a
 * computed future position (a satellite's orbit), never an observation.
 */
export interface WorldTrackPoint extends TrackPoint {
  source?: string;
  /** The licence line the source requires, shown with `source` ("… adsb.lol contributors (ODbL 1.0)"). */
  sourceAttribution?: string;
  predicted?: boolean;
}

/**
 * One source's answer about the selected object (provider-sdk object-details.ts), with the
 * provider it came from: `label` and `attribution` are shown with it.
 */
export interface WorldObjectDetails extends ObjectDetailsAnswer {
  providerId: string;
}

/**
 * What is known of the selected aircraft's flight (`world.flight`, 2026-09-28): the airline
 * and aircraft type named from the bundled reference tables, and the planned route from a
 * route source (provider-sdk flight-route.ts). Every part is best effort and may be absent.
 */
export interface WorldFlightAirport {
  /** ICAO location indicator (`EGLL`), or the source's code when it has no ICAO one. */
  code: string;
  icao?: string;
  iata?: string;
  name?: string;
  city?: string;
  /** ISO 3166-1 alpha-2. */
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  elevationM?: number;
  /**
   * Where the name and position came from: `route` — the route source's answer;
   * `reference` — WORLDVIEW's bundled airports; absent — only the code is known.
   */
  describedBy?: 'route' | 'reference';
}

export interface WorldFlightRoute {
  /** Origin, any stops, destination — in order; at least two. */
  airports: WorldFlightAirport[];
  /** The route source's label ("adsb.lol routes"). */
  source: string;
  attribution?: string;
  /** The source's own check of the aircraft's position against the route, when it made one. */
  plausible?: boolean;
  /** What the operator must know about it: a schedule, not today's flight plan. */
  note: string;
}

export type WorldFlightRouteStatus =
  /** A route was found. */
  | 'found'
  /** The source answered and does not know this callsign. */
  | 'unknown'
  /** No source could be asked, or the lookup failed (offline, refused, timed out). */
  | 'unavailable'
  /** Not looked up: no callsign, or one shaped like a registration rather than an airline flight. */
  | 'not-applicable';

export interface WorldFlightInfo {
  objectId: string;
  /** The callsign as broadcast, normalised (upper-case, no spaces). */
  callsign?: string;
  /** From the callsign's three-letter ICAO designator, or the route source's airline code. */
  airline?: { icao: string; name?: string; iata?: string };
  /** The flight number to show: IATA style when the airline has an IATA code ("BA 123"), else the callsign's. */
  flightNumber?: string;
  /** The aircraft type designator's name from the bundled type table. */
  aircraftType?: { code: string; name: string };
  route?: WorldFlightRoute;
  routeStatus: WorldFlightRouteStatus;
  /** Credit for the bundled tables used for the airline, type and airport names, when any was. */
  referenceAttribution?: string;
}

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
  /**
   * Where the result came from (local index, live state, provider). `geocoder` (additive,
   * 2026-09-28): an online place search (`search.places`), shown with its attribution.
   */
  source: 'local-index' | 'world-state' | 'worldpack' | 'command' | 'parser' | 'geocoder';
  score: number;
}

/**
 * The answer to `search.places` (additive, 2026-09-28): places found by an online geocoder
 * (OpenStreetMap Nominatim, Photon as the fallback), asked in the main process on the
 * operator's explicit request — never per keystroke. `status` says why there are none:
 * `offline` (the gazetteer is all there is), `disabled` (switched off in Settings), `busy`
 * (the one-request-a-second budget is spoken for; try again), `unavailable` (the service
 * failed, or this build has no online search). `attribution` must be shown with the results.
 */
export interface PlaceSearchAnswer {
  status: 'ok' | 'offline' | 'disabled' | 'busy' | 'unavailable';
  /** Places only (`kind: 'place'`, `source: 'geocoder'`), best first. */
  results: SearchResult[];
  attribution: string;
  /** The service that answered. */
  service?: 'nominatim' | 'photon';
  /** For a status other than `ok`: what to tell the operator. */
  message?: string;
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
  /** When the pack was built and when its publisher says it goes out of date (manifest). */
  createdAt?: string;
  expiresAt?: string;
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
  /**
   * How the map is drawn. `graphics` is the GPU cost (render-core graphics.ts; Auto picks from
   * the GPU the app runs on). `visualStyle` is a full-screen look — night vision, thermal, a
   * CRT, noir — applied on the 3D globe as a post-process and approximated in 2D. `hud` is
   * the readout of the view centre, altitude and time in the corners. `dayNight` shades the
   * night side of the Earth from the Sun's real position. `models3d` (additive, 2026-09-28):
   * draw nearby aircraft and ships as 3D models when the globe is close in; absent means the
   * graphics quality decides (on for High and Balanced, off for Low — render-core graphics.ts).
   */
  display: {
    graphics: 'auto' | 'high' | 'balanced' | 'low';
    visualStyle: VisualStyleId;
    hud: boolean;
    dayNight: boolean;
    models3d?: boolean;
    /**
     * (additive, 2026-09-29) The one full-cover imagery layer drawn over the basemap — a
     * source's overlay that is not weather, such as NASA's daily true colour — by provider id;
     * absent, none. Chosen in the map's view bar: two such pictures over each other hid one
     * another, so only one is drawn at a time.
     */
    imagery?: string;
  };
  /**
   * (additive, 2026-09-28) Online place search (`search.places`): absent means on. Off, the
   * search box finds only objects, events and the built-in gazetteer, and nothing is sent.
   * `service` is asked first and the other only when it finds nothing or fails (default
   * Nominatim): Nominatim's policy asks that an application can be switched to another
   * service without a software update, and this is that switch.
   */
  search?: { online: boolean; service?: 'nominatim' | 'photon' };
  /**
   * (additive, 2026-09-28) The operator's home view: set from the current view in Settings,
   * flown to with Home or Shift+H, and at start when `flyOnStart` is on (asked on the
   * welcome screen). Absent until set. WorldView never looks up where the operator is.
   */
  home?: HomeSettings;
}

export interface HomeSettings {
  /** The view to return to; null until the operator sets one. */
  view: HomeView | null;
  /** Fly there once the map has drawn its first frame. Off unless the operator turns it on. */
  flyOnStart: boolean;
}

/**
 * A place and a height to look at it from: the ground in the middle of the view when it
 * was set, the camera's altitude for the globe and the map's zoom for 2D, and the tilt and
 * heading it was seen with. A home set before these were kept has neither and is seen from
 * straight above, facing north.
 */
export interface HomeView {
  latitude: number;
  longitude: number;
  /** Camera altitude, metres (the globe). */
  altitudeM: number;
  /** Web-Mercator zoom (the 2D map). */
  zoom: number;
  /** The view's pitch (−90 straight down), when it was tilted. */
  pitchDegrees?: number;
  /** Which way the view faced, degrees clockwise from north, when not north. */
  headingDegrees?: number;
}

/** The visual styles (Settings → Map → Style, and the `V` key to cycle). */
export const VISUAL_STYLE_IDS = ['standard', 'night-vision', 'thermal', 'crt', 'noir'] as const;
export type VisualStyleId = (typeof VISUAL_STYLE_IDS)[number];

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
  'air-quality': 'Unhealthy air',
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
  /**
   * `mp4`: a short recorded clip the source replaces every few minutes (TfL JamCams), not a
   * continuous stream — the renderer loops it and says so (ADR-009 amendment 2026-09-23).
   * `snapshot-poll`: there is no video at all; `url` is the latest still.
   */
  kind: 'mjpeg' | 'hls' | 'webrtc' | 'mp4' | 'snapshot-poll';
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
 * One file in a connector-definition folder (ADR-013 amendment 2026-09-23, for phase
 * `source-health-ui`): its name (`bundled/<file>` for a shipped one), the id and connector
 * when it validated, whether that source is enabled, and why it was refused.
 */
export interface DefinitionFileEntry {
  file: string;
  id?: string;
  connector?: string;
  enabled: boolean;
  /** A shipped definition; its file cannot be edited or removed from the app. */
  bundled: boolean;
  problems: string[];
  warnings: string[];
}

export interface DefinitionsListing {
  /** The operator's own folder (absolute), or null when this runtime has none (demo, tests). */
  folder: string | null;
  files: DefinitionFileEntry[];
}

/** What a reload changed: ids started, stopped, and restarted because their file changed. */
export interface DefinitionsReload extends DefinitionsListing {
  added: string[];
  removed: string[];
  restarted: string[];
}

/** A draft from one sample of a URL (the drafter `connector:add` uses), with the validator's verdict. */
export interface DefinitionDraft {
  definition: Record<string, JsonValue>;
  connector: string;
  notes: string[];
  todo: string[];
  validation: { ok: boolean; errors: string[]; warnings: string[] };
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
  /**
   * `selected` (optional, additive, 2026-09-27): the operator has this object selected, so
   * the runtime may add what its source knows of it (provider-sdk object-track.ts) — an
   * aircraft's recent adsb.lol history, a satellite's next orbit — each point labelled.
   * Without it the answer is WORLDVIEW's own track, as before.
   */
  'world.track': { request: { objectId: string; time?: TimeRange; selected?: boolean }; response: WorldTrackPoint[] };
  /**
   * Additive, 2026-09-27: what the sources of the selected object know about it beyond their
   * polls — a satellite's catalogue record, its next passes over `observer` (the point the
   * operator chose; without one, the centre of the last `world.viewport`). Asked for the
   * selected object only.
   */
  'world.details': {
    request: { objectId: string; observer?: { latitude: number; longitude: number } };
    response: WorldObjectDetails[];
  };
  /**
   * (additive, 2026-09-28) The selected aircraft's flight: airline, type, planned route. Null
   * when there is no such object or it is not an aircraft. The shell asks only for the object
   * the operator selected; the runtime asks a route source (provider-sdk flight-route.ts).
   */
  'world.flight': { request: { objectId: string }; response: WorldFlightInfo | null };
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
  /** `center`: where the view is centred (a globe-wide view's bounds are the whole world). */
  'world.viewport': {
    request: { bounds: GeoBounds; zoom: number; center?: { latitude: number; longitude: number } };
    response: void;
  };

  'sources.list': { request: void; response: SourceHealthEntry[] };
  /** Raster overlays every running provider publishes (ADR-008 amendment 2026-09-23). */
  'overlays.list': { request: void; response: RasterOverlay[] };
  'sources.manifest': { request: { providerId: string }; response: ProviderManifest | null };
  'sources.setEnabled': { request: { providerId: string; enabled: boolean }; response: void };
  'sources.refresh': { request: { providerId: string }; response: void };
  'sources.connection': { request: void; response: ConnectionSnapshot };
  'sources.settings.get': { request: { providerId: string }; response: Record<string, JsonValue> };
  'sources.settings.set': { request: { providerId: string; settings: Record<string, JsonValue> }; response: void };
  /** The operator's definition folder and every definition file, accepted or refused (ADR-013). */
  'sources.definitions.list': { request: void; response: DefinitionsListing };
  /** Re-read the folders while providers run: removed files stop, new ones start, changed ones restart. */
  'sources.definitions.reload': { request: void; response: DefinitionsReload };
  /** Enable or disable the source a definition file declares (persisted like `sources.setEnabled`). */
  'sources.definitions.setEnabled': { request: { file: string; enabled: boolean }; response: DefinitionsListing };
  /** Open the operator's folder in the OS file manager (created if missing). */
  'sources.definitions.openFolder': { request: void; response: { opened: boolean; folder: string | null } };
  /** Fetch one sample of `url` (https, a public host) in the main process and draft a definition from it. */
  'sources.definitions.draft': { request: { url: string }; response: DefinitionDraft };
  /** Write a definition into the operator's folder, disabled; refuses an existing file or a taken id. */
  'sources.definitions.save': {
    request: { id: string; definition: Record<string, JsonValue> };
    response: { file: string; listing: DefinitionsReload };
  };

  'credentials.has': { request: { key: string }; response: { present: boolean } };
  'credentials.set': { request: { key: string; value: string }; response: void };
  'credentials.delete': { request: { key: string }; response: void };

  'history.query': { request: WorldQuery; response: WorldQueryResult<WorldObject> };
  'history.availability': {
    request: { objectTypes?: string[] };
    response: Array<{ objectType: string; ranges: TimeRange[] }>;
  };
  'history.usage': { request: void; response: HistoryUsage };
  /**
   * Every stored reading of up to `MAX_READING_KEYS` numeric payload keys of one object in
   * `time`, oldest first (the Readings section; telemetry R3). At most 20,000 rows, the newest;
   * `truncated` says when more were stored.
   */
  'history.readings': {
    request: { objectId: string; keys: string[]; time: TimeRange };
    response: { readings: Array<{ observedAt: string; values: Record<string, number> }>; truncated: boolean };
  };
  'timeline.get': { request: void; response: TimelineState };
  'timeline.set': {
    request: Partial<Pick<TimelineState, 'mode' | 'cursor' | 'speed' | 'range'>>;
    response: TimelineState;
  };

  'search.query': { request: { text: string; bias?: GeoPosition; limit?: number }; response: SearchResult[] };
  /** Places from an online geocoder (additive, 2026-09-28): see PlaceSearchAnswer. */
  'search.places': { request: { text: string; bias?: GeoPosition; limit?: number }; response: PlaceSearchAnswer };
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
  /** The full overlay list whenever a provider's overlays appear, change or go away. */
  'overlays.changed': { overlays: RasterOverlay[] };
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
  'world.details',
  'world.flight',
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
  'sources.definitions.list',
  'sources.definitions.reload',
  'sources.definitions.setEnabled',
  'sources.definitions.openFolder',
  'sources.definitions.draft',
  'sources.definitions.save',
  'overlays.list',
  'credentials.has',
  'credentials.set',
  'credentials.delete',
  'history.query',
  'history.availability',
  'history.usage',
  'history.readings',
  'timeline.get',
  'timeline.set',
  'search.query',
  'search.places',
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
  'overlays.changed',
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
