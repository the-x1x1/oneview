import type { WorldObject } from '@worldview/world-model';
import { BUILT_IN_LENSES } from '@worldview/render-core';
import { initialTimelineState, timelineReducer } from '@worldview/ui';
import type { RootAction, RootState, WorldSlice, UiSlice, ContextTab } from './types.js';
import { extendTrack } from '../context/track-profile.js';

/**
 * Root reducer: one pure function per slice, combined here. No middleware — side
 * effects (IPC requests) live in `actions.ts` and `sync.ts`, which dispatch results.
 */
export const DEFAULT_VIEW: WorldSlice['view'] = {
  center: { latitude: 20, longitude: 0 },
  altitudeM: 25_000_000,
  zoom: 1.5,
  headingDegrees: 0,
  pitchDegrees: -90,
  bounds: { west: -180, south: -85, east: 180, north: 85 },
};

export const MAX_FEED_ITEMS = 500;
export const MAX_NOTIFICATIONS = 5;

export function initialState(nowMs: number): RootState {
  return {
    session: {
      status: 'booting',
      appInfo: null,
      settings: null,
      error: null,
      firstRun: false,
      mapProviders: null,
      cameras: null,
      eventTypes: null,
    },
    world: {
      objects: new Map(),
      events: new Map(),
      count: 0,
      selectedId: null,
      selectedKind: null,
      selectedObject: null,
      selectedEvent: null,
      hoveredId: null,
      track: [],
      related: { objects: [], events: [] },
      view: DEFAULT_VIEW,
      subscription: {},
      lastChangeAt: null,
    },
    sources: { entries: [], connection: null, manifests: {}, credentials: {}, providerSettings: {} },
    timeline: { control: initialTimelineState(nowMs), runtime: null },
    feed: { items: [], unread: 0 },
    lenses: { lenses: BUILT_IN_LENSES, activeId: 'overview' },
    collections: { collections: [], activeId: null },
    watchzones: { zones: [] },
    offline: { status: null },
    updater: { state: null },
    ui: {
      contextTab: 'selection',
      pinnedTabs: [],
      paletteOpen: false,
      dialog: null,
      mode: 'AUTO',
      activeMode: '2D',
      supports3D: true,
      sourceDetailId: null,
      notifications: [],
      railCollapsed: false,
    },
  };
}

function session(state: RootState['session'], action: RootAction): RootState['session'] {
  switch (action.type) {
    case 'session/ready':
      return { ...state, status: 'ready', appInfo: action.appInfo, settings: action.settings, error: null };
    case 'session/settings':
      return { ...state, settings: action.settings };
    case 'session/error':
      return { ...state, status: 'error', error: action.message };
    case 'session/firstRunDone':
      return state.firstRun ? { ...state, firstRun: false } : state;
    case 'session/mapProviders':
      return { ...state, mapProviders: action.providers };
    case 'cameras/list':
      return { ...state, cameras: action.cameras };
    case 'session/eventTypes':
      return { ...state, eventTypes: action.eventTypes };
    default:
      return state;
  }
}

function world(state: WorldSlice, action: RootAction): WorldSlice {
  switch (action.type) {
    case 'world/snapshot': {
      const objects = new Map<string, WorldObject>();
      for (const o of action.objects) objects.set(o.id, o);
      // Keep the selected object visible even if the new snapshot does not include it.
      if (state.selectedObject && !objects.has(state.selectedObject.id))
        objects.set(state.selectedObject.id, state.selectedObject);
      return { ...state, objects, count: action.count, subscription: action.subscription };
    }
    case 'world/changed': {
      const { change } = action;
      if (change.objects.length === 0 && change.removed.length === 0 && change.freshness.length === 0)
        return { ...state, lastChangeAt: change.at };
      const objects = new Map(state.objects);
      for (const o of change.objects) objects.set(o.id, o);
      for (const id of change.removed) if (id !== state.selectedId) objects.delete(id);
      for (const f of change.freshness) {
        const existing = objects.get(f.id);
        if (existing && existing.freshness !== f.freshness) objects.set(f.id, { ...existing, freshness: f.freshness });
      }
      let selectedObject = state.selectedObject;
      let track = state.track;
      if (selectedObject) {
        const next = objects.get(selectedObject.id);
        if (next && next !== selectedObject) {
          selectedObject = next;
          track = extendTrack(track, next) ?? track;
        }
      }
      return {
        ...state,
        objects,
        selectedObject,
        track,
        lastChangeAt: change.at,
        count: state.count + change.added.length - change.removed.length,
      };
    }
    case 'world/events': {
      const events = new Map(state.events);
      for (const e of action.events) events.set(e.id, e);
      return { ...state, events };
    }
    case 'world/select': {
      if (action.id === null)
        return {
          ...state,
          selectedId: null,
          selectedKind: null,
          selectedObject: null,
          selectedEvent: null,
          track: [],
          related: { objects: [], events: [] },
        };
      const kind = action.kind ?? (action.id.startsWith('event:') ? 'event' : 'object');
      if (state.selectedId === action.id && state.selectedKind === kind) return state;
      const fromMirror = kind === 'object' ? (state.objects.get(action.id) ?? null) : null;
      const fromEvents = kind === 'event' ? (state.events.get(action.id) ?? null) : null;
      return {
        ...state,
        selectedId: action.id,
        selectedKind: kind,
        selectedObject: fromMirror,
        selectedEvent: fromEvents,
        track: [],
        related: { objects: [], events: [] },
      };
    }
    case 'world/selectedObject': {
      if (!action.object || action.object.id !== state.selectedId)
        return action.object ? state : { ...state, selectedObject: null };
      const objects = state.objects.has(action.object.id)
        ? state.objects
        : new Map(state.objects).set(action.object.id, action.object);
      return { ...state, selectedObject: action.object, objects };
    }
    case 'world/selectedEvent':
      if (!action.event) return { ...state, selectedEvent: null };
      return action.event.id === state.selectedId ? { ...state, selectedEvent: action.event } : state;
    case 'world/track':
      return action.objectId === state.selectedId ? { ...state, track: action.points } : state;
    case 'world/related':
      return action.forId === state.selectedId
        ? { ...state, related: { objects: action.objects, events: action.events } }
        : state;
    case 'world/hover':
      return state.hoveredId === action.id ? state : { ...state, hoveredId: action.id };
    case 'world/view':
      return { ...state, view: action.view };
    default:
      return state;
  }
}

function sources(state: RootState['sources'], action: RootAction): RootState['sources'] {
  switch (action.type) {
    case 'sources/list':
      return { ...state, entries: action.entries, connection: action.connection ?? state.connection };
    case 'sources/connection':
      return { ...state, connection: action.connection };
    case 'sources/manifest':
      return { ...state, manifests: { ...state.manifests, [action.providerId]: action.manifest } };
    case 'sources/settings':
      return { ...state, providerSettings: { ...state.providerSettings, [action.providerId]: action.settings } };
    case 'sources/credential':
      return { ...state, credentials: { ...state.credentials, [action.key]: action.present } };
    default:
      return state;
  }
}

function timeline(state: RootState['timeline'], action: RootAction): RootState['timeline'] {
  switch (action.type) {
    case 'timeline/control': {
      const control = timelineReducer(state.control, action.action);
      return control === state.control ? state : { ...state, control };
    }
    case 'timeline/runtime': {
      const s = action.state;
      const control = timelineReducer(state.control, {
        type: 'sync',
        mode: s.mode,
        cursorMs: Date.parse(s.cursor),
        speed: s.speed,
        nowMs: action.nowMs,
        range: { startMs: Date.parse(s.range.start), endMs: Date.parse(s.range.end) },
        availability: s.availability.map((a) => ({
          objectType: a.objectType,
          ranges: a.ranges.map((r) => ({ startMs: Date.parse(r.start), endMs: Date.parse(r.end) })),
        })),
      });
      return { control, runtime: s };
    }
    default:
      return state;
  }
}

function feed(state: RootState['feed'], action: RootAction): RootState['feed'] {
  switch (action.type) {
    case 'feed/recent':
      return { items: [...action.items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_FEED_ITEMS), unread: 0 };
    case 'feed/item': {
      if (state.items.some((i) => i.id === action.item.id)) return state;
      // In time order, like the initial list. Prepending put an alert issued sixteen hours ago
      // — but only now seen — above one from two hours ago, and the list read as shuffled.
      const at = state.items.findIndex((i) => i.at.localeCompare(action.item.at) < 0);
      const items =
        at === -1
          ? [...state.items, action.item]
          : [...state.items.slice(0, at), action.item, ...state.items.slice(at)];
      return { items: items.slice(0, MAX_FEED_ITEMS), unread: state.unread + 1 };
    }
    case 'feed/markRead':
      return state.unread === 0 ? state : { ...state, unread: 0 };
    default:
      return state;
  }
}

function lenses(state: RootState['lenses'], action: RootAction): RootState['lenses'] {
  switch (action.type) {
    case 'lenses/list': {
      const list = action.lenses.length ? action.lenses : BUILT_IN_LENSES;
      const activeId = list.some((l) => l.id === state.activeId) ? state.activeId : (list[0]?.id ?? 'overview');
      return { lenses: list, activeId };
    }
    case 'lenses/activate':
      return state.lenses.some((l) => l.id === action.id) && action.id !== state.activeId
        ? { ...state, activeId: action.id }
        : state;
    case 'session/ready':
    case 'session/settings': {
      const id = action.settings.activeLensId;
      return id && state.lenses.some((l) => l.id === id) ? { ...state, activeId: id } : state;
    }
    default:
      return state;
  }
}

function collections(state: RootState['collections'], action: RootAction): RootState['collections'] {
  switch (action.type) {
    case 'collections/list': {
      const activeId =
        state.activeId && action.collections.some((c) => c.id === state.activeId)
          ? state.activeId
          : (action.collections[0]?.id ?? null);
      return { collections: action.collections, activeId };
    }
    case 'collections/activate':
      return { ...state, activeId: action.id };
    default:
      return state;
  }
}

function watchzones(state: RootState['watchzones'], action: RootAction): RootState['watchzones'] {
  return action.type === 'watchzones/list' ? { zones: action.zones } : state;
}

function offline(state: RootState['offline'], action: RootAction): RootState['offline'] {
  return action.type === 'offline/status' ? { status: action.status } : state;
}

function updater(state: RootState['updater'], action: RootAction): RootState['updater'] {
  return action.type === 'updater/state' ? { state: action.state } : state;
}

function ui(state: UiSlice, action: RootAction): UiSlice {
  switch (action.type) {
    case 'ui/contextTab': {
      const pinned: ContextTab[] = state.pinnedTabs.includes(action.tab)
        ? state.pinnedTabs
        : [...state.pinnedTabs, action.tab];
      return { ...state, contextTab: action.tab, pinnedTabs: pinned };
    }
    case 'ui/palette':
      return state.paletteOpen === action.open ? state : { ...state, paletteOpen: action.open };
    case 'ui/dialog':
      return state.dialog === action.dialog ? state : { ...state, dialog: action.dialog };
    case 'ui/mode':
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case 'ui/activeMode':
      return state.activeMode === action.mode ? state : { ...state, activeMode: action.mode };
    case 'ui/hostCapabilities':
      return state.supports3D === action.supports3D ? state : { ...state, supports3D: action.supports3D };
    case 'ui/sourceDetail':
      return { ...state, sourceDetailId: action.providerId };
    case 'ui/notify':
      return { ...state, notifications: [action.notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS) };
    case 'ui/dismissNotification':
      return { ...state, notifications: state.notifications.filter((n) => n.id !== action.id) };
    case 'ui/railCollapsed':
      return { ...state, railCollapsed: action.collapsed };
    case 'session/ready':
      return { ...state, mode: action.settings.renderMode, dialog: state.dialog };
    case 'session/settings':
      return state.mode === action.settings.renderMode ? state : { ...state, mode: action.settings.renderMode };
    case 'world/select':
      return action.id !== null && state.contextTab !== 'selection' ? { ...state, contextTab: 'selection' } : state;
    default:
      return state;
  }
}

export function rootReducer(state: RootState, action: RootAction): RootState {
  const next: RootState = {
    session: session(state.session, action),
    world: world(state.world, action),
    sources: sources(state.sources, action),
    timeline: timeline(state.timeline, action),
    feed: feed(state.feed, action),
    lenses: lenses(state.lenses, action),
    collections: collections(state.collections, action),
    watchzones: watchzones(state.watchzones, action),
    offline: offline(state.offline, action),
    updater: updater(state.updater, action),
    ui: ui(state.ui, action),
  };
  for (const k of Object.keys(next) as Array<keyof RootState>) if (next[k] !== state[k]) return next;
  return state;
}
