import type { Dispatch } from 'react';
import type {
  GeoBounds,
  GeoPosition,
  JsonValue,
  SeverityClass,
  WorldGeometry,
  WorldQuery,
} from '@worldview/world-model';
import { geometryCentroid, regionBounds } from '@worldview/world-model';
import type {
  AppSettings,
  CameraListEntry,
  CameraRegistration,
  CameraSnapshot,
  CameraSourceInput,
  CameraStreamDescriptor,
  Collection,
  CollectionItem,
  DiagnosticsSnapshot,
  SearchResult,
  WatchZone,
  WhatChangedResult,
} from '@worldview/ipc-contract';
import { lensById, zoomToAltitudeM, type RenderMode } from '@worldview/render-core';
import { timelineReducer, type TimelineAction, type TimelineControlState, type TimelineSpeed } from '@worldview/ui';
import type { WorldClient } from '@worldview/ipc-contract';
import type { ContextTab, DialogId, RootAction, RootState } from './types.js';
import { describeError } from './sync.js';
import type { HostRegistry } from './store.js';
import { OVERVIEW_LAYERS, OVERVIEW_LENS_ID, withLayer } from '../overview-layers.js';

export interface FlyTarget {
  position: GeoPosition;
  altitudeM?: number;
  zoom?: number;
  bounds?: GeoBounds;
}

export interface ActionDeps {
  client: WorldClient;
  dispatch: Dispatch<RootAction>;
  getState: () => RootState;
  hosts: HostRegistry;
  now: () => number;
}

/**
 * Where to fly for something with a shape and no point: its bounds, or — when the shape
 * spans the antimeridian (the Aleutians, the Bering Sea) and plain min/max would wrap the
 * world — its centre. A feed item for a weather alert selected the alert and left the camera
 * where it was: select() flew only to points.
 */
export function flyTargetForGeometry(g: WorldGeometry): { position: GeoPosition; bounds?: GeoBounds } | undefined {
  const centre = geometryCentroid(g);
  if (!centre) return undefined;
  if (g.type === 'Point') return { position: centre };
  const lons: number[] = [];
  const lats: number[] = [];
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      lons.push(c[0]);
      lats.push(c[1]);
    } else if (Array.isArray(c)) for (const x of c) visit(x);
  };
  visit((g as { coordinates: unknown }).coordinates);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  if (east - west > 180) return { position: centre };
  return { position: centre, bounds: { west, south: Math.min(...lats), east, north: Math.max(...lats) } };
}

/** Zoom used when flying to an object of a given type (aircraft close, earthquakes regional). */
export function zoomForType(type: string): number {
  switch (type) {
    case 'aircraft':
    case 'vessel':
    case 'transit-vehicle':
    case 'camera':
      return 10;
    case 'satellite':
      return 3;
    case 'earthquake':
    case 'fire-detection':
    case 'weather-alert':
    case 'storm':
      return 6;
    default:
      return 8;
  }
}

const SYNCED_TIMELINE_ACTIONS: ReadonlySet<TimelineAction['type']> = new Set([
  'play',
  'pause',
  'togglePlay',
  'setSpeed',
  'jumpToLive',
  'scrubEnd',
  'step',
  'setRange',
]);

/**
 * Every user-facing action the shell can perform. Each is a real WorldClient request
 * (or a pure store update); nothing here is a stub. The command palette, keyboard map and
 * panels all call these — the UI never talks to the client directly.
 */
export function createActions({ client, dispatch, getState, hosts, now }: ActionDeps) {
  const notify = (title: string, body: string, severity: SeverityClass = 'INFO') =>
    dispatch({
      type: 'ui/notify',
      notification: { id: `n-${now()}-${Math.random().toString(36).slice(2, 7)}`, title, body, severity, at: now() },
    });

  const fail = (what: string, err: unknown) => {
    notify(what, describeError(err), 'MINOR');
  };

  async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings | null> {
    try {
      const settings = await client.request('settings.set', partial);
      dispatch({ type: 'session/settings', settings });
      return settings;
    } catch (err) {
      fail('Settings not saved', err);
      return null;
    }
  }

  async function setHiddenLayers(hiddenLayers: string[]): Promise<void> {
    const s = getState();
    const current = s.session.settings;
    if (current) dispatch({ type: 'session/settings', settings: { ...current, hiddenLayers } });
    if (s.lenses.activeId !== OVERVIEW_LENS_ID) {
      const overview = lensById(OVERVIEW_LENS_ID, s.lenses.lenses);
      if (overview) {
        dispatch({ type: 'lenses/activate', id: OVERVIEW_LENS_ID });
        hosts.get()?.setLens(overview);
      }
      await updateSettings({ hiddenLayers, activeLensId: OVERVIEW_LENS_ID });
      return;
    }
    await updateSettings({ hiddenLayers });
  }

  async function flyTo(target: FlyTarget, opts?: { durationMs?: number }): Promise<void> {
    const host = hosts.get();
    if (!host) return;
    await host.flyTo(target, opts);
  }

  async function loadSelection(id: string, kind: 'object' | 'event'): Promise<void> {
    if (kind === 'event') {
      try {
        const event = await client.request('world.event', { eventId: id });
        dispatch({ type: 'world/selectedEvent', event });
        const related = await client.request('world.related', { eventId: id });
        dispatch({ type: 'world/related', forId: id, objects: related.objects, events: related.events });
      } catch (err) {
        fail('Event details unavailable', err);
      }
      return;
    }
    try {
      const object = await client.request('world.get', { objectId: id });
      dispatch({ type: 'world/selectedObject', object });
      const [track, related] = await Promise.all([
        client.request('world.track', { objectId: id }),
        client.request('world.related', { objectId: id }),
      ]);
      dispatch({ type: 'world/track', objectId: id, points: track });
      dispatch({ type: 'world/related', forId: id, objects: related.objects, events: related.events });
    } catch (err) {
      fail('Object details unavailable', err);
    }
  }

  /** Fly to an object or event: its point, or the bounds of its shape. False when it has neither. */
  function flyToSelection(
    obj: { position?: GeoPosition; geometry?: WorldGeometry; type: string } | null | undefined,
    ev: { geometry?: WorldGeometry } | null | undefined,
  ): boolean {
    const shape = obj?.geometry ?? ev?.geometry;
    const area = !obj?.position && shape ? flyTargetForGeometry(shape) : undefined;
    if (area?.bounds) {
      void flyTo({ position: area.position, bounds: area.bounds });
      return true;
    }
    const pos = obj?.position ?? area?.position;
    if (!pos) return false;
    const zoom = zoomForType(obj?.type ?? 'event');
    void flyTo({ position: pos, zoom, altitudeM: zoomToAltitudeM(zoom, pos.latitude) });
    return true;
  }

  async function select(id: string | null, opts: { kind?: 'object' | 'event'; fly?: boolean } = {}): Promise<void> {
    const kind = opts.kind ?? (id?.startsWith('event:') ? 'event' : 'object');
    dispatch({ type: 'world/select', id, ...(id ? { kind } : {}) });
    hosts.get()?.select(id ? (kind === 'event' ? `event:${id}` : `obj:${id}`) : null);
    if (!id) return;
    let flown = false;
    if (opts.fly) {
      const s = getState();
      flown = flyToSelection(
        kind === 'object' ? s.world.objects.get(id) : undefined,
        kind === 'event' ? s.world.events.get(id) : undefined,
      );
    }
    await loadSelection(id, kind);
    if (opts.fly && !flown) {
      // Not held by the current subscription — a satellite on the far side of the world, a
      // feed item's alert in Alaska while looking at Africa — so there was nothing to fly to
      // until the details loaded. Selecting "ISS" or a feed item left the camera where it was.
      const s = getState();
      if (s.world.selectedId === id)
        flyToSelection(
          kind === 'object' ? s.world.selectedObject : undefined,
          kind === 'event' ? s.world.selectedEvent : undefined,
        );
    }
  }

  async function goTo(result: SearchResult): Promise<void> {
    if (result.kind === 'object' || result.kind === 'event') {
      await select(result.id, { kind: result.kind, fly: true });
      const s = getState();
      const found = result.kind === 'event' ? s.world.selectedEvent : s.world.selectedObject;
      if (!found && result.position) {
        // Not even the details had a place: the search result's own position, if it has one.
        const zoom = zoomForType(result.kind === 'event' ? 'event' : (result.id.split(':')[0] ?? ''));
        void flyTo({ position: result.position, zoom, altitudeM: zoomToAltitudeM(zoom, result.position.latitude) });
      }
      return;
    }
    if (result.kind === 'command') {
      await runCommand(result.id.replace(/^command:/, ''));
      return;
    }
    if (result.kind === 'query' && result.query) {
      await runQuery(result.query, result.title);
      return;
    }
    if (result.bounds) {
      void flyTo({
        position: result.position ?? {
          latitude: (result.bounds.north + result.bounds.south) / 2,
          longitude: (result.bounds.east + result.bounds.west) / 2,
        },
        bounds: result.bounds,
      });
      return;
    }
    if (result.position) {
      void flyTo({ position: result.position, zoom: 9, altitudeM: zoomToAltitudeM(9, result.position.latitude) });
    }
  }

  /**
   * Commands the search grammar can produce (DEFAULT_COMMANDS in query-engine). Every id
   * it can emit is handled here; `commandsAreWired` in the shell tests holds the two
   * lists together, so adding a command to the vocabulary without an outcome fails the
   * build rather than shipping a result that looks clickable and does nothing.
   */
  async function runCommand(command: string): Promise<void> {
    switch (command) {
      case 'go-live':
        timeline({ type: 'jumpToLive' });
        return;
      case 'switch-2d':
        await actions.setMode('2D');
        return;
      case 'switch-3d':
        await actions.setMode('3D');
        return;
      case 'open-source-health':
        actions.setContextTab('sources');
        return;
      case 'open-diagnostics':
        actions.openDialog('diagnostics');
        return;
      case 'manage-providers':
        actions.openDialog('settings');
        return;
      case 'download-offline-pack':
        await actions.installOfflinePack();
        return;
      case 'lens-aviation':
        await actions.showOnlyLayer('aviation');
        return;
      case 'lens-disasters':
        await actions.showOnlyLayer('disasters');
        return;
      case 'lens-maritime':
        await actions.showOnlyLayer('maritime');
        return;
      case 'lens-space':
        await actions.showOnlyLayer('space');
        return;
      case 'lens-weather':
        await actions.showOnlyLayer('weather');
        return;
      case 'goto-location':
        // "fly"/"jump" with nothing to fly to: the place is what carries the position.
        actions.focusSearch();
        notify('Where to?', 'Add a place name, an airport code or coordinates — for example "fly to Honolulu".');
        return;
      default:
        notify('Command unavailable', `This build has no action for "${command}".`, 'MINOR');
    }
  }

  /**
   * A parsed query ("M5+ earthquakes last 24 hours"). Running it is the point: one match
   * is selected, several frame their own extent, none says so. The count in the result
   * title is what the runtime actually returned, not an estimate.
   */
  async function runQuery(query: WorldQuery, title: string): Promise<void> {
    let result;
    try {
      result = await client.request('world.query', { ...query, limit: Math.min(query.limit ?? 500, 500) });
    } catch (err) {
      fail('Search failed', err);
      return;
    }
    const items = result.items.filter((o) => o.position);
    if (items.length === 0) {
      notify('No matches', `${title} matched nothing in the current world state.`);
      return;
    }
    if (items.length === 1) {
      const only = items[0]!;
      dispatch({ type: 'world/selectedObject', object: only });
      await select(only.id, { kind: 'object', fly: true });
      return;
    }
    const lats = items.map((o) => o.position!.latitude);
    const lons = items.map((o) => o.position!.longitude);
    const bounds = {
      south: Math.min(...lats),
      north: Math.max(...lats),
      west: Math.min(...lons),
      east: Math.max(...lons),
    };
    const centre = { latitude: (bounds.north + bounds.south) / 2, longitude: (bounds.east + bounds.west) / 2 };
    void flyTo({ position: centre, bounds });
    notify(
      'Search',
      `${result.total} match${result.total === 1 ? '' : 'es'} for ${title}${result.total > items.length ? ` — framing the ${items.length} with a position` : ''}.`,
    );
  }

  // The store's state only catches up on the next render, so several timeline actions in
  // one tick (a pointer-down's scrubStart + scrubTo; a replay's seek, speed and play) would
  // each be reduced from the same stale state — `play` from LIVE is a no-op, so a replay
  // sent mode LIVE. The last computed state is kept and used while the store has not moved.
  let timelineShadow: { basis: TimelineControlState; state: TimelineControlState } | undefined;

  function timeline(action: TimelineAction, opts: { send?: boolean } = {}): void {
    const current = getState().timeline.control;
    const before = timelineShadow && timelineShadow.basis === current ? timelineShadow.state : current;
    timelineShadow = { basis: current, state: timelineReducer(before, action) };
    dispatch({ type: 'timeline/control', action });
    // A drag sends one request when it ends (scrubEnd). A `scrubTo` outside a drag is a
    // jump — the Home key, "Earliest recorded", a point on a track — and nothing else will
    // tell the runtime about it: unsent, the bar showed HISTORICAL over a world still live.
    const jump = action.type === 'scrubTo' && !before.scrubbing;
    if (opts.send === false || (!SYNCED_TIMELINE_ACTIONS.has(action.type) && !jump)) return;
    const next = timelineShadow.state;
    void client
      .request('timeline.set', {
        mode: next.mode,
        cursor: new Date(next.cursorMs).toISOString(),
        speed: next.speed,
        range: { start: new Date(next.range.startMs).toISOString(), end: new Date(next.range.endMs).toISOString() },
      })
      .then((state) => dispatch({ type: 'timeline/runtime', state, nowMs: now() }))
      .catch((err: unknown) => fail('Timeline not applied', err));
  }

  const actions = {
    notify,
    select,
    hover(id: string | null) {
      dispatch({ type: 'world/hover', id });
    },
    clearSelection() {
      void select(null);
    },
    flyTo,
    goTo,
    async search(text: string, limit = 12): Promise<SearchResult[]> {
      const center = getState().world.view.center;
      try {
        return await client.request('search.query', { text, bias: center, limit });
      } catch (err) {
        fail('Search unavailable', err);
        return [];
      }
    },

    async setMode(mode: RenderMode): Promise<void> {
      dispatch({ type: 'ui/mode', mode });
      // `ui/activeMode` is NOT set here. setMode starts an asynchronous activation — the
      // renderer has to be imported, constructed and mounted — so reading activeMode()
      // on the next line returns the mode being left. That stale value used to be
      // dispatched straight back into the store, so the toggle showed the old mode
      // however well the switch went. MapHost listens for the host's `modeChanged` and
      // records the mode that actually arrived.
      hosts.get()?.setMode(mode);
      await updateSettings({ renderMode: mode });
    },
    toggleMode(): void {
      void actions.setMode(getState().ui.activeMode === '2D' ? '3D' : '2D');
    },

    async setLens(id: string): Promise<void> {
      const s = getState();
      const lens = lensById(id, s.lenses.lenses);
      if (!lens) return;
      dispatch({ type: 'lenses/activate', id });
      hosts.get()?.setLens(lens);
      await updateSettings({ activeLensId: id });
      if (lens.eventTypes.length) {
        try {
          const events = await client.request('world.events', { eventTypes: lens.eventTypes, limit: 500 });
          dispatch({ type: 'world/events', events: events.items });
        } catch (err) {
          console.warn('[worldview] events for lens failed:', describeError(err));
        }
      }
    },

    /**
     * Switch one Overview layer (overview-layers.ts). Shown at once — the settings object is
     * updated locally before it is saved, and the map needs nothing fetched — and a switch
     * pressed while another lens is active brings the Overview back, since that is what the
     * switches belong to.
     */
    async setLayerVisible(id: string, visible: boolean): Promise<void> {
      await setHiddenLayers(withLayer(getState().session.settings?.hiddenLayers ?? [], id, visible));
    },
    async setAllLayersVisible(visible: boolean): Promise<void> {
      await setHiddenLayers(visible ? [] : OVERVIEW_LAYERS.map((l) => l.id));
    },
    /** Only this layer on: what a category lens used to show. */
    async showOnlyLayer(id: string): Promise<void> {
      await setHiddenLayers(OVERVIEW_LAYERS.filter((l) => l.id !== id).map((l) => l.id));
    },

    timeline,
    updateSettings,

    /** The selected object's track over the last `windowMs` (history plus the live tail). */
    async loadTrack(objectId: string, windowMs: number): Promise<void> {
      const end = now();
      try {
        const points = await client.request('world.track', {
          objectId,
          time: { start: new Date(end - windowMs).toISOString(), end: new Date(end).toISOString() },
        });
        dispatch({ type: 'world/track', objectId, points });
      } catch (err) {
        fail('Track unavailable', err);
      }
    },

    /** Put the replay cursor at `ms` (paused there): the map shows the world as it was. */
    seekTo(ms: number): void {
      timeline({ type: 'scrubTo', ms });
    },

    /** Play the world back from `startMs` at `speed` — a track's replay. */
    replayFrom(startMs: number, speed: TimelineSpeed): void {
      // One request for the three steps: the runtime projects the world once, not three times.
      timeline({ type: 'scrubTo', ms: startMs }, { send: false });
      timeline({ type: 'setSpeed', speed }, { send: false });
      timeline({ type: 'play' });
    },

    // ---- sources ----
    async setSourceEnabled(providerId: string, enabled: boolean): Promise<void> {
      try {
        await client.request('sources.setEnabled', { providerId, enabled });
      } catch (err) {
        fail('Source not updated', err);
      }
    },
    async refreshSource(providerId: string): Promise<void> {
      try {
        await client.request('sources.refresh', { providerId });
      } catch (err) {
        fail('Refresh failed', err);
      }
    },
    /**
     * Read a provider's own settings. They are loaded on demand (opening a source's
     * detail), not at boot: most sessions never open one.
     */
    async loadProviderSettings(providerId: string): Promise<void> {
      try {
        const settings = await client.request('sources.settings.get', { providerId });
        dispatch({ type: 'sources/settings', providerId, settings });
      } catch (err) {
        fail('Source settings unavailable', err);
      }
    },
    /**
     * Change one declared setting. `sources.settings.set` replaces the whole object, so
     * the current values are merged here; a dotted key (`packs.nsw`) writes into a nested
     * object, which is how a provider that groups its settings receives them.
     */
    async setProviderSetting(providerId: string, key: string, value: JsonValue | undefined): Promise<void> {
      const current = getState().sources.providerSettings[providerId] ?? {};
      const next = setByPath(current as Record<string, JsonValue>, key, value);
      try {
        await client.request('sources.settings.set', { providerId, settings: next });
        dispatch({ type: 'sources/settings', providerId, settings: next });
        notify('Source updated', 'The change takes effect on the next refresh.');
      } catch (err) {
        fail('Source settings not saved', err);
      }
    },
    async loadManifest(providerId: string): Promise<void> {
      if (providerId in getState().sources.manifests) return;
      try {
        dispatch({
          type: 'sources/manifest',
          providerId,
          manifest: await client.request('sources.manifest', { providerId }),
        });
      } catch (err) {
        fail('Manifest unavailable', err);
      }
    },
    async checkCredential(key: string): Promise<void> {
      try {
        dispatch({
          type: 'sources/credential',
          key,
          present: (await client.request('credentials.has', { key })).present,
        });
      } catch (err) {
        fail('Credential state unavailable', err);
      }
    },
    async setCredential(key: string, value: string, providerId?: string): Promise<boolean> {
      try {
        await client.request('credentials.set', { key, value });
        dispatch({ type: 'sources/credential', key, present: true });
        if (providerId) await client.request('sources.refresh', { providerId });
        notify('Credential stored', 'Saved to the operating system secure store.');
        return true;
      } catch (err) {
        fail('Credential not stored', err);
        return false;
      }
    },
    async deleteCredential(key: string): Promise<void> {
      try {
        await client.request('credentials.delete', { key });
        dispatch({ type: 'sources/credential', key, present: false });
      } catch (err) {
        fail('Credential not removed', err);
      }
    },
    openSource(providerId: string | null) {
      dispatch({ type: 'ui/sourceDetail', providerId });
      if (providerId) {
        dispatch({ type: 'ui/contextTab', tab: 'sources' });
        void actions.loadManifest(providerId);
      }
    },

    // ---- collections ----
    async saveCollection(collection: Collection): Promise<void> {
      try {
        dispatch({
          type: 'collections/list',
          collections: await client.request('collections.save', {
            ...collection,
            updatedAt: new Date(now()).toISOString(),
          }),
        });
      } catch (err) {
        fail('Collection not saved', err);
      }
    },
    async createCollection(name: string): Promise<string> {
      const id = `col-${now().toString(36)}`;
      const iso = new Date(now()).toISOString();
      await actions.saveCollection({
        id,
        name: name.trim() || 'Untitled collection',
        createdAt: iso,
        updatedAt: iso,
        items: [],
      });
      dispatch({ type: 'collections/activate', id });
      return id;
    },
    setActiveCollection(id: string | null) {
      dispatch({ type: 'collections/activate', id });
    },
    async renameCollection(id: string, name: string): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === id);
      if (c) await actions.saveCollection({ ...c, name: name.trim() || c.name });
    },
    async deleteCollection(id: string): Promise<void> {
      try {
        dispatch({ type: 'collections/list', collections: await client.request('collections.delete', { id }) });
      } catch (err) {
        fail('Collection not deleted', err);
      }
    },
    async addToCollection(
      collectionId: string,
      item: Omit<CollectionItem, 'id' | 'createdAt' | 'updatedAt'>,
    ): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === collectionId);
      if (!c) return;
      const iso = new Date(now()).toISOString();
      await actions.saveCollection({
        ...c,
        items: [
          ...c.items,
          { ...item, id: `item-${now().toString(36)}-${c.items.length}`, createdAt: iso, updatedAt: iso },
        ],
      });
    },
    async removeFromCollection(collectionId: string, itemId: string): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === collectionId);
      if (c) await actions.saveCollection({ ...c, items: c.items.filter((i) => i.id !== itemId) });
    },
    async setItemNote(collectionId: string, itemId: string, note: string): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === collectionId);
      if (!c) return;
      const iso = new Date(now()).toISOString();
      await actions.saveCollection({
        ...c,
        items: c.items.map((i) => (i.id === itemId ? { ...i, note, updatedAt: iso } : i)),
      });
    },
    async addSelectionToCollection(collectionId: string): Promise<void> {
      const w = getState().world;
      if (w.selectedKind === 'object' && w.selectedObject) {
        const o = w.selectedObject;
        await actions.addToCollection(collectionId, {
          kind: 'object',
          title: o.labels['callsign'] ?? o.labels['name'] ?? o.labels['title'] ?? o.id,
          objectId: o.id,
          ...(o.position ? { position: o.position } : {}),
        });
      } else if (w.selectedKind === 'event' && w.selectedEvent) {
        await actions.addToCollection(collectionId, {
          kind: 'event',
          title: w.selectedEvent.title,
          eventId: w.selectedEvent.id,
        });
      }
    },
    async addLocationToCollection(collectionId: string, title?: string): Promise<void> {
      const view = getState().world.view;
      await actions.addToCollection(collectionId, {
        kind: 'location',
        title: title ?? `${view.center.latitude.toFixed(3)}, ${view.center.longitude.toFixed(3)}`,
        position: view.center,
      });
    },
    async exportCollection(id: string): Promise<void> {
      try {
        const r = await client.request('collections.export', { id });
        if ('path' in r) notify('Collection exported', r.path);
      } catch (err) {
        fail('Export failed', err);
      }
    },
    async importCollection(): Promise<void> {
      try {
        const r = await client.request('collections.import', undefined);
        if (r.imported) {
          dispatch({ type: 'collections/list', collections: await client.request('collections.list', undefined) });
          notify('Collection imported', r.imported.name);
        }
        if (r.issues.length) notify('Import issues', r.issues.slice(0, 3).join('; '), 'MINOR');
      } catch (err) {
        fail('Import failed', err);
      }
    },

    // ---- watch zones ----
    async saveWatchZone(zone: WatchZone): Promise<void> {
      try {
        dispatch({ type: 'watchzones/list', zones: await client.request('watchzones.save', zone) });
      } catch (err) {
        fail('Watch zone not saved', err);
      }
    },
    async deleteWatchZone(id: string): Promise<void> {
      try {
        dispatch({ type: 'watchzones/list', zones: await client.request('watchzones.delete', { id }) });
      } catch (err) {
        fail('Watch zone not deleted', err);
      }
    },
    async createCircleZoneAtCenter(radiusM = 50_000, name?: string): Promise<void> {
      const view = getState().world.view;
      const lens = lensById(getState().lenses.activeId, getState().lenses.lenses);
      await actions.saveWatchZone({
        id: `zone-${now().toString(36)}`,
        name: name ?? `Zone near ${view.center.latitude.toFixed(2)}, ${view.center.longitude.toFixed(2)}`,
        geometry: {
          kind: 'circle',
          center: { latitude: view.center.latitude, longitude: view.center.longitude },
          radiusM,
        },
        eventTypes: lens?.eventTypes.length ? lens.eventTypes : ['earthquake', 'wildfire-cluster', 'weather-alert'],
        notifications: { inApp: true, desktop: false },
        enabled: true,
        createdAt: new Date(now()).toISOString(),
      });
      dispatch({ type: 'ui/contextTab', tab: 'watchzones' });
    },
    flyToZone(zone: WatchZone): void {
      const b = regionBounds(zone.geometry);
      if (b)
        void flyTo({ position: { latitude: (b.north + b.south) / 2, longitude: (b.east + b.west) / 2 }, bounds: b });
    },

    // ---- ui ----
    openDialog(dialog: DialogId) {
      dispatch({ type: 'ui/dialog', dialog });
    },
    closeDialog() {
      dispatch({ type: 'ui/dialog', dialog: null });
    },
    openPalette() {
      dispatch({ type: 'ui/palette', open: true });
    },
    closePalette() {
      dispatch({ type: 'ui/palette', open: false });
    },
    setRailCollapsed(collapsed: boolean) {
      dispatch({ type: 'ui/railCollapsed', collapsed });
    },
    setContextTab(tab: ContextTab) {
      dispatch({ type: 'ui/contextTab', tab });
      if (tab === 'feed') dispatch({ type: 'feed/markRead' });
    },
    focusSearch() {
      if (typeof document !== 'undefined') document.querySelector<HTMLInputElement>('#wv-global-search input')?.focus();
    },
    dismissNotification(id: string) {
      dispatch({ type: 'ui/dismissNotification', id });
    },
    finishWelcome() {
      dispatch({ type: 'session/firstRunDone' });
      dispatch({ type: 'ui/dialog', dialog: null });
      // Persisted through settings so it survives a reinstall of the renderer bundle and
      // is visible to the runtime; a failure here only means the welcome shows again.
      void client.request('settings.set', { firstRunCompleted: true }).catch(() => {});
    },

    // ---- app / diagnostics / updater / offline ----
    async openExternal(url: string): Promise<void> {
      try {
        const r = await client.request('app.openExternal', { url });
        if (!r.opened) notify('Link not opened', url, 'INFO');
      } catch (err) {
        fail('Link not opened', err);
      }
    },
    async getDiagnostics(): Promise<DiagnosticsSnapshot | null> {
      try {
        return await client.request('diagnostics.get', undefined);
      } catch (err) {
        fail('Diagnostics unavailable', err);
        return null;
      }
    },
    async exportDiagnostics(): Promise<void> {
      try {
        const r = await client.request('diagnostics.export', undefined);
        if ('path' in r) notify('Diagnostics exported (redacted)', r.path);
      } catch (err) {
        fail('Export failed', err);
      }
    },
    async checkForUpdates(): Promise<void> {
      try {
        dispatch({ type: 'updater/state', state: await client.request('updater.check', undefined) });
      } catch (err) {
        fail('Update check failed', err);
      }
    },
    async installUpdate(): Promise<void> {
      try {
        dispatch({ type: 'updater/state', state: await client.request('updater.install', undefined) });
      } catch (err) {
        fail('Update not installed', err);
      }
    },
    async installOfflinePack(): Promise<void> {
      try {
        const r = await client.request('offline.installPack', undefined);
        if (r.installed) notify('Offline pack installed', r.installed.name);
        if (r.issues.length) notify('Pack issues', r.issues.slice(0, 3).join('; '), 'MINOR');
        dispatch({ type: 'offline/status', status: await client.request('offline.status', undefined) });
      } catch (err) {
        fail('Pack not installed', err);
      }
    },
    async removePack(id: string): Promise<void> {
      try {
        dispatch({ type: 'offline/status', status: await client.request('offline.removePack', { id }) });
      } catch (err) {
        fail('Pack not removed', err);
      }
    },
    async setPackEnabled(id: string, enabled: boolean): Promise<void> {
      try {
        dispatch({ type: 'offline/status', status: await client.request('offline.setPackEnabled', { id, enabled }) });
      } catch (err) {
        fail('Pack not updated', err);
      }
    },
    async cameraSnapshot(cameraId: string): Promise<CameraSnapshot | null> {
      try {
        return await client.request('camera.snapshot', { cameraId });
      } catch (err) {
        fail('Snapshot unavailable', err);
        return null;
      }
    },
    /**
     * Ask the runtime for a playable stream. The URL that comes back points at the
     * loopback relay with a per-camera token; the camera's own address and any login
     * stay in the main process and never reach this layer.
     */
    async cameraStream(cameraId: string): Promise<CameraStreamDescriptor | null> {
      try {
        return await client.request('camera.stream', { cameraId });
      } catch (err) {
        fail('Stream unavailable', err);
        return null;
      }
    },
    async listCameras(): Promise<CameraListEntry[]> {
      try {
        const cameras = await client.request('camera.list', undefined);
        dispatch({ type: 'cameras/list', cameras });
        return cameras;
      } catch (err) {
        fail('Cameras unavailable', err);
        return [];
      }
    },
    /**
     * Register a camera. The URL may carry a login; it goes straight to the main
     * process, which strips it into OS-protected storage before anything is stored.
     */
    async registerCamera(source: CameraSourceInput): Promise<CameraRegistration | null> {
      try {
        const registration = await client.request('camera.register', source);
        await this.listCameras();
        notify(
          'Camera added',
          `${source.name} — ${registration.gateway === 'go2rtc' ? 'via the go2rtc sidecar' : 'fetched directly'}`,
        );
        return registration;
      } catch (err) {
        fail('Camera not added', err);
        return null;
      }
    },
    async unregisterCamera(cameraId: string, name?: string): Promise<void> {
      try {
        await client.request('camera.unregister', { cameraId });
        await this.listCameras();
        notify('Camera removed', name ? `${name} and its stored credential` : 'the camera and its stored credential');
      } catch (err) {
        fail('Camera not removed', err);
      }
    },
    async whatChangedHere(hours = 24): Promise<WhatChangedResult | null> {
      const view = getState().world.view;
      const bounds = view.bounds ?? {
        west: view.center.longitude - 5,
        east: view.center.longitude + 5,
        south: view.center.latitude - 5,
        north: view.center.latitude + 5,
      };
      const end = new Date(now()).toISOString(),
        start = new Date(now() - hours * 3600_000).toISOString();
      try {
        return await client.request('world.whatChanged', { region: { kind: 'bounds', bounds }, time: { start, end } });
      } catch (err) {
        fail('What changed unavailable', err);
        return null;
      }
    },
    async exportVisible(format: 'geojson' | 'json' | 'csv'): Promise<void> {
      const s = getState();
      const lens = lensById(s.lenses.activeId, s.lenses.lenses);
      const query: WorldQuery = {
        ...(lens ? { objectTypes: lens.objectTypes } : {}),
        ...(s.world.view.bounds ? { region: { kind: 'bounds', bounds: s.world.view.bounds } } : {}),
      };
      try {
        const r = await client.request('export.objects', { query, format });
        if ('path' in r)
          notify(
            'Export written',
            r.skippedProviders.length ? `${r.path} (skipped by policy: ${r.skippedProviders.join(', ')})` : r.path,
          );
      } catch (err) {
        fail('Export failed', err);
      }
    },
  };
  return actions;
}

export type ShellActions = ReturnType<typeof createActions>;

/**
 * Immutable set/delete along a dotted path. `undefined` removes the key, so clearing a
 * field returns the provider to its own default rather than storing an empty value that
 * would read as a deliberate choice.
 */
export function setByPath(
  source: Record<string, JsonValue>,
  path: string,
  value: JsonValue | undefined,
): Record<string, JsonValue> {
  const [head, ...rest] = path.split('.');
  if (!head) return source;
  const out: Record<string, JsonValue> = { ...source };
  if (rest.length === 0) {
    if (value === undefined) delete out[head];
    else out[head] = value;
    return out;
  }
  const child = out[head];
  const nested =
    child && typeof child === 'object' && !Array.isArray(child) ? (child as Record<string, JsonValue>) : {};
  const updated = setByPath(nested, rest.join('.'), value);
  if (Object.keys(updated).length === 0) delete out[head];
  else out[head] = updated;
  return out;
}

/** Read a dotted path out of a settings object; undefined when unset. */
export function getByPath(source: Readonly<Record<string, JsonValue>>, path: string): JsonValue | undefined {
  let cursor: JsonValue | undefined = source as JsonValue;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, JsonValue>)[part];
  }
  return cursor;
}
