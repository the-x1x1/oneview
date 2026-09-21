import type { WorldEvent, WorldObject } from '@worldview/world-model';
import type { AppSettings, CameraListEntry, Collection, FeedItem, OfflineStatus, ResponseOf, TimelineState, UpdaterState, WatchZone, WorldChangedEvent, WorldSubscription,
  MapProviderList,
} from '@worldview/ipc-contract';
import type { ProviderManifest } from '@worldview/provider-sdk';
import type { ConnectionSnapshot, SourceHealthEntry } from '@worldview/source-health';
import type { LensDefinition, RenderMode, ViewState } from '@worldview/render-core';
import type { TimelineAction, TimelineControlState } from '@worldview/ui';

/** Shape of `world.track` items (avoids a runtime dependency on state-engine types). */
export type TrackPoint = ResponseOf<'world.track'>[number];
export type AppInfo = ResponseOf<'app.info'>;

// ---- slices -------------------------------------------------------------------------------

export interface SessionSlice {
  status: 'booting' | 'ready' | 'error';
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  error: string | null;
  /** True until the welcome screen has been dismissed once on this machine. */
  firstRun: boolean;
  /** Basemaps and terrain the runtime says this installation can show (map.providers.list). */
  mapProviders: MapProviderList | null;
  /**
   * Cameras the gateway has registered (camera.list). Null until first loaded; the
   * interface never holds a camera URL or credential, only what the runtime returns.
   */
  cameras: CameraListEntry[] | null;
}

export interface WorldSlice {
  /** Object mirror: snapshot from world.subscribe, then world.changed deltas. */
  objects: ReadonlyMap<string, WorldObject>;
  /** Events fetched for the active lens (world.events). */
  events: ReadonlyMap<string, WorldEvent>;
  /** Total matching objects on the runtime side (may exceed the mirror when truncated). */
  count: number;
  selectedId: string | null;
  selectedKind: 'object' | 'event' | null;
  /** Full selected object (kept even when it leaves the subscription bounds). */
  selectedObject: WorldObject | null;
  selectedEvent: WorldEvent | null;
  hoveredId: string | null;
  track: TrackPoint[];
  related: { objects: WorldObject[]; events: WorldEvent[] };
  view: ViewState;
  subscription: WorldSubscription;
  lastChangeAt: string | null;
}

export interface SourcesSlice {
  entries: SourceHealthEntry[];
  connection: ConnectionSnapshot | null;
  manifests: Readonly<Record<string, ProviderManifest | null>>;
  /** credential key → present (never the value). */
  credentials: Readonly<Record<string, boolean>>;
}

export interface TimelineSlice {
  control: TimelineControlState;
  /** Last state pushed by the runtime (null before timeline.get resolves). */
  runtime: TimelineState | null;
}

export interface FeedSlice {
  items: FeedItem[];
  unread: number;
}

export interface LensesSlice {
  lenses: LensDefinition[];
  activeId: string;
}

export interface CollectionsSlice {
  collections: Collection[];
  activeId: string | null;
}

export interface WatchZonesSlice {
  zones: WatchZone[];
}

export interface OfflineSlice {
  status: OfflineStatus | null;
}

export interface UpdaterSlice {
  state: UpdaterState | null;
}

export type ContextTab = 'selection' | 'sources' | 'timeline' | 'related' | 'feed' | 'collections' | 'watchzones';
export type DialogId = 'settings' | 'diagnostics' | 'attribution' | 'welcome' | null;

export interface Notification {
  id: string;
  title: string;
  body: string;
  severity: FeedItem['severity'];
  eventId?: string;
  at: number;
}

export interface UiSlice {
  contextTab: ContextTab;
  /** Tabs the user opened explicitly even if the lens does not list them. */
  pinnedTabs: ContextTab[];
  paletteOpen: boolean;
  dialog: DialogId;
  /** Requested render mode (settings.renderMode mirrors it). */
  mode: RenderMode;
  /** What the host is actually rendering. */
  activeMode: '2D' | '3D';
  /** Whether the mounted host can render 3D at all (hides 3D controls/commands when false). */
  supports3D: boolean;
  /** Provider whose detail row is expanded in the Sources panel. */
  sourceDetailId: string | null;
  notifications: Notification[];
  /** Left rail collapsed to icons. */
  railCollapsed: boolean;
}

export interface RootState {
  session: SessionSlice;
  world: WorldSlice;
  sources: SourcesSlice;
  timeline: TimelineSlice;
  feed: FeedSlice;
  lenses: LensesSlice;
  collections: CollectionsSlice;
  watchzones: WatchZonesSlice;
  offline: OfflineSlice;
  updater: UpdaterSlice;
  ui: UiSlice;
}

// ---- actions ------------------------------------------------------------------------------

export type SessionAction =
  | { type: 'session/ready'; appInfo: AppInfo; settings: AppSettings }
  | { type: 'session/settings'; settings: AppSettings }
  | { type: 'session/error'; message: string }
  | { type: 'session/firstRunDone' }
  | { type: 'session/mapProviders'; providers: MapProviderList }
  | { type: 'cameras/list'; cameras: CameraListEntry[] };

export type WorldAction =
  | { type: 'world/snapshot'; objects: WorldObject[]; count: number; subscription: WorldSubscription }
  | { type: 'world/changed'; change: WorldChangedEvent }
  | { type: 'world/events'; events: WorldEvent[] }
  | { type: 'world/select'; id: string | null; kind?: 'object' | 'event' }
  | { type: 'world/selectedObject'; object: WorldObject | null }
  | { type: 'world/selectedEvent'; event: WorldEvent | null }
  | { type: 'world/track'; objectId: string; points: TrackPoint[] }
  | { type: 'world/related'; forId: string; objects: WorldObject[]; events: WorldEvent[] }
  | { type: 'world/hover'; id: string | null }
  | { type: 'world/view'; view: ViewState };

export type SourcesAction =
  | { type: 'sources/list'; entries: SourceHealthEntry[]; connection?: ConnectionSnapshot }
  | { type: 'sources/connection'; connection: ConnectionSnapshot }
  | { type: 'sources/manifest'; providerId: string; manifest: ProviderManifest | null }
  | { type: 'sources/credential'; key: string; present: boolean };

export type TimelineSliceAction =
  | { type: 'timeline/control'; action: TimelineAction }
  | { type: 'timeline/runtime'; state: TimelineState; nowMs: number };

export type FeedAction =
  | { type: 'feed/recent'; items: FeedItem[] }
  | { type: 'feed/item'; item: FeedItem }
  | { type: 'feed/markRead' };

export type LensesAction =
  | { type: 'lenses/list'; lenses: LensDefinition[] }
  | { type: 'lenses/activate'; id: string };

export type CollectionsAction =
  | { type: 'collections/list'; collections: Collection[] }
  | { type: 'collections/activate'; id: string | null };

export type WatchZonesAction = { type: 'watchzones/list'; zones: WatchZone[] };
export type OfflineAction = { type: 'offline/status'; status: OfflineStatus };
export type UpdaterAction = { type: 'updater/state'; state: UpdaterState };

export type UiAction =
  | { type: 'ui/contextTab'; tab: ContextTab }
  | { type: 'ui/palette'; open: boolean }
  | { type: 'ui/dialog'; dialog: DialogId }
  | { type: 'ui/mode'; mode: RenderMode }
  | { type: 'ui/activeMode'; mode: '2D' | '3D' }
  | { type: 'ui/hostCapabilities'; supports3D: boolean }
  | { type: 'ui/sourceDetail'; providerId: string | null }
  | { type: 'ui/notify'; notification: Notification }
  | { type: 'ui/dismissNotification'; id: string }
  | { type: 'ui/railCollapsed'; collapsed: boolean };

export type RootAction =
  | SessionAction | WorldAction | SourcesAction | TimelineSliceAction | FeedAction | LensesAction
  | CollectionsAction | WatchZonesAction | OfflineAction | UpdaterAction | UiAction;
