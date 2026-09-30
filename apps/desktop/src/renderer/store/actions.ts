import type { Dispatch } from 'react';
import type {
  GeoBounds,
  GeoPosition,
  JsonValue,
  SeverityClass,
  WorldGeometry,
  WorldObject,
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
  PlaceSearchAnswer,
  SearchResult,
  WatchZone,
  WhatChangedResult,
  WorldObjectDetails,
} from '@worldview/ipc-contract';
import {
  defaultSplit,
  lensById,
  nextVisualStyle,
  splitCandidates,
  zoomToAltitudeM,
  type ImagerySplit,
  type RenderMode,
  type VisualStyleId,
} from '@worldview/render-core';
import { timelineReducer, type TimelineAction, type TimelineControlState, type TimelineSpeed } from '@worldview/ui';
import type { WorldClient } from '@worldview/ipc-contract';
import type { ContextTab, DialogId, RootAction, RootState } from './types.js';
import { describeError } from './sync.js';
import { isCollected } from './collections.js';
import { zoneEventTypes } from './watch-zones.js';
import type { HostRegistry } from './store.js';
import { overlaysToDraw } from '../map-providers.js';
import { OVERVIEW_LENS_ID, withLayer } from '../overview-layers.js';
import { allLayersHidden, onlyLayerHidden } from '../layer-tree.js';
import { WEATHER_GROUP_ID, withWeatherImagery } from '../weather-imagery.js';
import { stormsTarget, stormsViewHidden } from '../storms-view.js';
import { displaySettings } from './display.js';
import { NO_HOME, describeHome, homeFlyOptions, homeFlyTarget, homeFromView } from './home.js';

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

/**
 * The pitch a flight to a selected point arrives at on the globe: looking at it from the side
 * with the ground round it in view, rather than straight down onto a dot. Areas (bounds) are
 * still framed from above, and the 2D map stays flat.
 */
export const SELECTION_PITCH_DEGREES = -35;

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

  /**
   * Change the display settings at once — locally, so a key pressed twice in quick succession
   * builds on the first press — and save them.
   */
  async function setDisplay(patch: Partial<AppSettings['display']>): Promise<void> {
    const current = getState().session.settings;
    if (!current) return;
    const display = { ...displaySettings(current), ...patch };
    dispatch({ type: 'session/settings', settings: { ...current, display } });
    await updateSettings({ display });
  }

  async function flyTo(
    target: FlyTarget,
    opts?: { durationMs?: number; pitchDegrees?: number; headingDegrees?: number },
  ): Promise<void> {
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
      // An aircraft's flight (airline, type, planned route) — asked for beside the track and
      // never waited on: a route lookup can take seconds, the rest of the panel cannot.
      if (object?.type === 'aircraft') void loadFlight(id);
      const [track, related] = await Promise.all([
        // `selected`: the runtime may fill the track from the object's source (an aircraft's
        // adsb.lol history, a satellite's next orbit) — for the selected object only.
        client.request('world.track', { objectId: id, selected: true }),
        client.request('world.related', { objectId: id }),
      ]);
      dispatch({ type: 'world/track', objectId: id, points: track });
      dispatch({ type: 'world/related', forId: id, objects: related.objects, events: related.events });
    } catch (err) {
      fail('Object details unavailable', err);
    }
  }

  /**
   * The selected aircraft's flight (`world.flight`). What was known stays shown while it is
   * asked again (a callsign that changed); a failure leaves nothing, and the panel says the
   * flight is unknown.
   */
  async function loadFlight(objectId: string): Promise<void> {
    const had = getState().world.flight;
    dispatch({
      type: 'world/flight',
      objectId,
      loading: true,
      info: had?.objectId === objectId ? had.info : null,
    });
    try {
      const info = await client.request('world.flight', { objectId });
      dispatch({ type: 'world/flight', objectId, loading: false, info });
    } catch {
      dispatch({ type: 'world/flight', objectId, loading: false, info: null });
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
    const oblique = getState().ui.activeMode === '3D' ? { pitchDegrees: SELECTION_PITCH_DEGREES } : undefined;
    void flyTo({ position: pos, zoom, altitudeM: zoomToAltitudeM(zoom, pos.latitude) }, oblique);
    return true;
  }

  async function select(
    id: string | null,
    opts: { kind?: 'object' | 'event'; fly?: boolean; fallback?: FlyTarget } = {},
  ): Promise<void> {
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
      if (s.world.selectedId === id) {
        const again = flyToSelection(
          kind === 'object' ? s.world.selectedObject : undefined,
          kind === 'event' ? s.world.selectedEvent : undefined,
        );
        if (!again && opts.fallback) void flyTo(opts.fallback);
      }
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
      const zoom = result.zoom ?? 9;
      void flyTo({ position: result.position, zoom, altitudeM: zoomToAltitudeM(zoom, result.position.latitude) });
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
    if (result.total > 0) dispatch({ type: 'ui/lastQuery', query, title, total: result.total });
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

    /**
     * Places from the online geocoder (main/place-search.ts) — one request, asked for by the
     * operator. A failure is an answer too (`unavailable`), shown in the list, not a toast.
     * No bias is sent: the text is all that leaves the machine, not where the operator is
     * looking, and the same text is the same cached answer wherever the map is.
     */
    async searchPlaces(text: string, limit = 6): Promise<PlaceSearchAnswer> {
      try {
        return await client.request('search.places', { text, limit });
      } catch (err) {
        return { status: 'unavailable', results: [], attribution: '', message: describeError(err) };
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
    /**
     * One weather imagery switch (weather-imagery.ts): radar and precipitation are one choice,
     * so one going on takes the other off; and turning one on turns Weather on, as a switch
     * under a category that is off would otherwise do nothing visible.
     */
    async setWeatherImagery(id: string, on: boolean): Promise<void> {
      let hidden = withWeatherImagery(getState().session.settings?.hiddenLayers ?? [], id, on);
      if (on) hidden = hidden.filter((h) => h !== WEATHER_GROUP_ID);
      await setHiddenLayers(hidden);
    },
    /** The one full-cover imagery view (weather-imagery.ts `isImageryView`), or none. */
    async setImageryView(providerId: string | undefined): Promise<void> {
      const current = getState().session.settings;
      if (!current) return;
      const { imagery: _previous, ...rest } = displaySettings(current);
      const display: AppSettings['display'] = providerId ? { ...rest, imagery: providerId } : rest;
      dispatch({ type: 'session/settings', settings: { ...current, display } });
      await updateSettings({ display });
    },
    /** Every category and type on or off; the opt-in children (layer-tree.ts) keep their state. */
    async setAllLayersVisible(visible: boolean): Promise<void> {
      await setHiddenLayers(allLayersHidden(getState().session.settings?.hiddenLayers ?? [], visible));
    },
    /** Only this layer on: what a category lens used to show. */
    async showOnlyLayer(id: string): Promise<void> {
      await setHiddenLayers(onlyLayerHidden(getState().session.settings?.hiddenLayers ?? [], id));
    },

    /**
     * The Storms quick view (storms-view.ts): only the Weather and Disasters layers on, then
     * the most severe item selected and flown to — a Category 3+ cyclone, else a tornado
     * warning, else the worst alert. The Overview's objects are bounded by the view when
     * zoomed in, so the runtime is asked as well, world-wide, for what could be chosen:
     * storms, GDACS cyclones, tornado warnings and severe or extreme alerts. A failed ask
     * leaves the choice to what is on hand.
     */
    async showStorms(): Promise<void> {
      await setHiddenLayers(stormsViewHidden(getState().session.settings?.hiddenLayers ?? []));
      const asks: WorldQuery[] = [
        { objectTypes: ['storm'], limit: 100 },
        {
          objectTypes: ['weather-alert'],
          filters: [{ field: 'properties.gdacsEventType', op: 'eq', value: 'TC' }],
          limit: 100,
        },
        {
          objectTypes: ['weather-alert'],
          filters: [
            { field: 'properties.alertKind', op: 'in', value: ['tornado-emergency', 'tornado-pds', 'tornado-warning'] },
          ],
          limit: 200,
        },
        {
          objectTypes: ['weather-alert'],
          filters: [{ field: 'properties.severity', op: 'in', value: ['EXTREME', 'SEVERE'] }],
          limit: 500,
        },
      ];
      const answers = await Promise.allSettled(asks.map((q) => client.request('world.query', q)));
      const candidates = new Map<string, WorldObject>(getState().world.objects);
      for (const a of answers) if (a.status === 'fulfilled') for (const o of a.value.items) candidates.set(o.id, o);
      const target = stormsTarget(candidates.values());
      if (!target) {
        notify('Storms', 'No tropical cyclone, tornado warning or weather alert is active in the sources that are on.');
        return;
      }
      await select(target.object.id, { kind: 'object', fly: true });
    },

    timeline,
    updateSettings,

    loadFlight,

    /** The selected object's track over the last `windowMs` (history plus the live tail). */
    async loadTrack(objectId: string, windowMs: number): Promise<void> {
      const end = now();
      try {
        const points = await client.request('world.track', {
          objectId,
          time: { start: new Date(end - windowMs).toISOString(), end: new Date(end).toISOString() },
          selected: true,
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
      const target = getState().collections.collections.find((c) => c.id === collectionId);
      // Once is enough: the palette command and the panel button can both be pressed twice.
      if (target && isCollected(target.items, w.selectedId)) {
        notify('Already collected', `This is already in “${target.name}”.`);
        return;
      }
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
        eventTypes: zoneEventTypes(lens?.eventTypes, getState().session.eventTypes),
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

    // ---- display: HUD, visual style, day/night (saved), clean view, orbit, follow (session) ----
    async toggleHud(): Promise<void> {
      await setDisplay({ hud: !displaySettings(getState().session.settings).hud });
    },
    async setVisualStyle(id: VisualStyleId): Promise<void> {
      await setDisplay({ visualStyle: id });
    },
    /** V: the next style; Shift+V: the one before. */
    async cycleVisualStyle(step: 1 | -1 = 1): Promise<void> {
      await setDisplay({
        visualStyle: nextVisualStyle(displaySettings(getState().session.settings).visualStyle, step),
      });
    },
    async toggleDayNight(): Promise<void> {
      await setDisplay({ dayNight: !displaySettings(getState().session.settings).dayNight });
    },
    setCleanView(on: boolean) {
      dispatch({ type: 'ui/cleanView', on });
    },
    /**
     * Compare imagery: a divider across the map with one overlay source on each side
     * (render-core imagery-split.ts), starting from the last two drawn — or the one drawn
     * against the map. Nothing to compare is said rather than an empty divider shown.
     */
    toggleImageryCompare() {
      const s = getState();
      if (s.ui.imageryCompare) {
        dispatch({ type: 'ui/imageryCompare', split: null });
        return;
      }
      const split = defaultSplit(splitCandidates(overlaysToDraw(s.sources.overlays, s.session.settings?.basemapId)));
      if (!split) {
        notify(
          'No imagery to compare',
          'Turn on an imagery source first — for example the NASA GIBS true-colour layers in Sources — then compare it with the map or with another.',
        );
        return;
      }
      dispatch({ type: 'ui/imageryCompare', split });
    },
    /** The comparison's sides or divider changed (the divider commits here when a drag ends). */
    setImageryCompare(split: ImagerySplit | null) {
      dispatch({ type: 'ui/imageryCompare', split });
    },
    /** Orbit on or off. Not with reduced motion on: nothing turns by itself then. */
    setOrbit(on: boolean) {
      const s = getState();
      if (on && s.session.settings?.reducedMotion) {
        notify('Orbit is off', 'Reduced motion is on (Settings), so the view does not turn by itself.');
        return;
      }
      dispatch({ type: 'ui/cameraMode', orbit: on, followId: on ? null : s.ui.followId });
    },
    /** Follow the selected object, or let go. Only an object can be followed, not an event. */
    setFollow(on: boolean) {
      const s = getState();
      const id = on && s.world.selectedKind === 'object' ? s.world.selectedId : null;
      if (on && !id) return;
      dispatch({ type: 'ui/cameraMode', orbit: false, followId: id });
    },
    // ---- home view (store/home.ts): set from the map, never looked up ----
    /** Make what is on screen the home view. */
    async setHomeFromView(): Promise<void> {
      const host = hosts.get();
      const current = getState().session.settings;
      if (!host || !current) return;
      const view = homeFromView(host.getView());
      await updateSettings({ home: { ...(current.home ?? NO_HOME), view } });
      notify('Home view set', `${describeHome(view)}. Home or Shift+H returns here.`);
    },
    async clearHome(): Promise<void> {
      await updateSettings({ home: { view: null, flyOnStart: false } });
    },
    /** Fly to the home view once the map is up, at every start (asked on the welcome screen and in Settings). */
    async setHomeFlyOnStart(on: boolean): Promise<void> {
      const current = getState().session.settings;
      if (!current) return;
      await updateSettings({ home: { ...(current.home ?? NO_HOME), flyOnStart: on } });
    },
    /** Home, Shift+H: fly to the home view, or say how to set one. */
    goHome(): void {
      const s = getState();
      const home = s.session.settings?.home?.view;
      if (!home) {
        notify('No home view yet', 'Set one from the view you want in Settings → Home view.');
        return;
      }
      // The camera is taken over: orbit and follow end, as they do when the operator drags.
      if (s.ui.orbit || s.ui.followId) dispatch({ type: 'ui/cameraMode', orbit: false, followId: null });
      void flyTo(homeFlyTarget(home), {
        durationMs: s.session.settings?.reducedMotion ? 0 : 2500,
        ...homeFlyOptions(home),
      });
    },
    /** What the renderer reports the camera is doing after it stopped a mode by itself. */
    cameraModeEnded(state: { orbit: boolean; followId: string | null }) {
      dispatch({ type: 'ui/cameraMode', ...state });
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
    /** Install a pack through the open dialog; the result is also returned, for the Settings line. */
    async installOfflinePack(): Promise<{ installed: string | null; issues: string[] }> {
      try {
        const r = await client.request('offline.installPack', undefined);
        const issues = r.issues.filter((i) => i !== 'cancelled');
        // One notice either way: what was installed (and what it replaced), or why not.
        if (r.installed) notify('Offline pack installed', [r.installed.name, ...issues.slice(0, 2)].join(' — '));
        else if (issues.length) notify('Pack not installed', issues.slice(0, 3).join('; '), 'MINOR');
        dispatch({ type: 'offline/status', status: await client.request('offline.status', undefined) });
        return { installed: r.installed?.name ?? null, issues };
      } catch (err) {
        fail('Pack not installed', err);
        return { installed: null, issues: [err instanceof Error ? err.message : String(err)] };
      }
    },
    /** Trust whoever signed an installed pack, under a name the operator chose. */
    async trustPackPublisher(packId: string, name: string): Promise<void> {
      try {
        dispatch({ type: 'offline/status', status: await client.request('offline.trustPublisher', { packId, name }) });
        notify('Publisher trusted', name || 'Packs signed with this key now read as trusted');
      } catch (err) {
        fail('Publisher not trusted', err);
      }
    },
    /** Add a publisher from the .worldpack-pub key file they handed out. */
    async importPackPublisher(): Promise<void> {
      try {
        const r = await client.request('offline.importPublisher', undefined);
        dispatch({ type: 'offline/status', status: r.status });
        if (r.added) notify('Publisher added', r.added);
        else if (r.issues.length && r.issues[0] !== 'cancelled')
          notify('Publisher not added', r.issues.slice(0, 2).join('; '), 'MINOR');
      } catch (err) {
        fail('Publisher not added', err);
      }
    },
    async removePackPublisher(keyId: string): Promise<void> {
      try {
        dispatch({ type: 'offline/status', status: await client.request('offline.removePublisher', { keyId }) });
      } catch (err) {
        fail('Publisher not removed', err);
      }
    },
    async setRequireTrustedPacks(required: boolean): Promise<void> {
      try {
        dispatch({ type: 'offline/status', status: await client.request('offline.setRequireTrusted', { required }) });
      } catch (err) {
        fail('Pack setting not changed', err);
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
    /**
     * What the selected object's sources know beyond their polls (`world.details`): a
     * satellite's catalogue record and its next passes. The passes are over the ground in the
     * middle of the view — `focus` when the globe is tilted, else the centre — at the moment
     * of asking; the answer says which point it used. Null (and quiet: the panel says it) on a
     * failure, since a missing catalogue record is not worth a notification.
     */
    /** An object's details; a satellite's passes over `over` (the home view), else the middle of the view. */
    async objectDetails(
      objectId: string,
      over?: { latitude: number; longitude: number },
    ): Promise<{ details: WorldObjectDetails[]; observer: { latitude: number; longitude: number } } | null> {
      const view = getState().world.view;
      const at = over ?? view.focus ?? view.center;
      const observer = {
        latitude: Math.max(-90, Math.min(90, at.latitude)),
        longitude: ((((at.longitude + 180) % 360) + 360) % 360) - 180,
      };
      try {
        return { details: await client.request('world.details', { objectId, observer }), observer };
      } catch (err) {
        console.warn('[worldview] world.details failed:', describeError(err));
        return null;
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
    /**
     * Export what the last search matched (roadmap 0.3: historical queries). A query with a
     * time window ("last 7 days") is answered from history as well as live state, and each
     * object is exported only where every source behind it allows export.
     */
    async exportLastQuery(format: 'geojson' | 'json' | 'csv'): Promise<void> {
      const last = getState().ui.lastQuery;
      if (!last) {
        notify('Nothing to export yet', 'Run a search such as "M5+ earthquakes last 7 days" first.');
        return;
      }
      const { limit: _limit, ...query } = last.query;
      try {
        const r = await client.request('export.objects', { query, format });
        if ('path' in r)
          notify(
            'Export written',
            `${last.title}: ${r.path}${r.skippedProviders.length ? ` (skipped by policy: ${r.skippedProviders.join(', ')})` : ''}`,
          );
      } catch (err) {
        fail('Export failed', err);
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
