import type { Dispatch } from 'react';
import type { GeoBounds, GeoPosition, SeverityClass, WorldQuery } from '@worldview/world-model';
import { regionBounds } from '@worldview/world-model';
import type { AppSettings, CameraSnapshot, Collection, CollectionItem, DiagnosticsSnapshot, SearchResult, WatchZone, WhatChangedResult } from '@worldview/ipc-contract';
import { lensById, zoomToAltitudeM, type RenderMode } from '@worldview/render-core';
import { timelineReducer, type TimelineAction } from '@worldview/ui';
import type { WorldClient } from '@worldview/ipc-contract';
import type { ContextTab, DialogId, RootAction, RootState } from './types.js';
import { describeError } from './sync.js';
import type { HostRegistry } from './store.js';

export interface FlyTarget { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds }

export interface ActionDeps {
  client: WorldClient;
  dispatch: Dispatch<RootAction>;
  getState: () => RootState;
  hosts: HostRegistry;
  now: () => number;
}

/** Zoom used when flying to an object of a given type (aircraft close, earthquakes regional). */
export function zoomForType(type: string): number {
  switch (type) {
    case 'aircraft': case 'vessel': case 'transit-vehicle': case 'camera': return 10;
    case 'satellite': return 3;
    case 'earthquake': case 'fire-detection': case 'weather-alert': case 'storm': return 6;
    default: return 8;
  }
}

const SYNCED_TIMELINE_ACTIONS: ReadonlySet<TimelineAction['type']> = new Set(['play', 'pause', 'togglePlay', 'setSpeed', 'jumpToLive', 'scrubEnd', 'step', 'setRange']);

/**
 * Every user-facing action the shell can perform. Each is a real WorldClient request
 * (or a pure store update); nothing here is a stub. The command palette, keyboard map and
 * panels all call these — the UI never talks to the client directly.
 */
export function createActions({ client, dispatch, getState, hosts, now }: ActionDeps) {
  const notify = (title: string, body: string, severity: SeverityClass = 'INFO') =>
    dispatch({ type: 'ui/notify', notification: { id: `n-${now()}-${Math.random().toString(36).slice(2, 7)}`, title, body, severity, at: now() } });

  const fail = (what: string, err: unknown) => { notify(what, describeError(err), 'MINOR'); };

  async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings | null> {
    try {
      const settings = await client.request('settings.set', partial);
      dispatch({ type: 'session/settings', settings });
      return settings;
    } catch (err) { fail('Settings not saved', err); return null; }
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
      } catch (err) { fail('Event details unavailable', err); }
      return;
    }
    try {
      const object = await client.request('world.get', { objectId: id });
      dispatch({ type: 'world/selectedObject', object });
      const [track, related] = await Promise.all([client.request('world.track', { objectId: id }), client.request('world.related', { objectId: id })]);
      dispatch({ type: 'world/track', objectId: id, points: track });
      dispatch({ type: 'world/related', forId: id, objects: related.objects, events: related.events });
    } catch (err) { fail('Object details unavailable', err); }
  }

  async function select(id: string | null, opts: { kind?: 'object' | 'event'; fly?: boolean } = {}): Promise<void> {
    const kind = opts.kind ?? (id?.startsWith('event:') ? 'event' : 'object');
    dispatch({ type: 'world/select', id, ...(id ? { kind } : {}) });
    hosts.get()?.select(id ? (kind === 'event' ? `event:${id}` : `obj:${id}`) : null);
    if (!id) return;
    if (opts.fly) {
      const s = getState();
      const obj = kind === 'object' ? s.world.objects.get(id) : undefined;
      const ev = kind === 'event' ? s.world.events.get(id) : undefined;
      const pos = obj?.position ?? (ev?.geometry && ev.geometry.type === 'Point' ? { latitude: ev.geometry.coordinates[1], longitude: ev.geometry.coordinates[0] } : undefined);
      if (pos) { const zoom = zoomForType(obj?.type ?? 'event'); void flyTo({ position: pos, zoom, altitudeM: zoomToAltitudeM(zoom, pos.latitude) }); }
    }
    await loadSelection(id, kind);
  }

  async function goTo(result: SearchResult): Promise<void> {
    if (result.kind === 'object' || result.kind === 'event') {
      await select(result.id, { kind: result.kind, fly: true });
      if (result.position && !getState().world.objects.has(result.id)) {
        const zoom = zoomForType(result.kind === 'event' ? 'event' : result.id.split(':')[0] ?? '');
        void flyTo({ position: result.position, zoom, altitudeM: zoomToAltitudeM(zoom, result.position.latitude) });
      }
      return;
    }
    if (result.bounds) { void flyTo({ position: result.position ?? { latitude: (result.bounds.north + result.bounds.south) / 2, longitude: (result.bounds.east + result.bounds.west) / 2 }, bounds: result.bounds }); return; }
    if (result.position) { void flyTo({ position: result.position, zoom: 9, altitudeM: zoomToAltitudeM(9, result.position.latitude) }); }
  }

  function timeline(action: TimelineAction): void {
    const before = getState().timeline.control;
    dispatch({ type: 'timeline/control', action });
    if (!SYNCED_TIMELINE_ACTIONS.has(action.type)) return;
    const next = timelineReducer(before, action);
    const mode = next.mode;
    void client.request('timeline.set', { mode, cursor: new Date(next.cursorMs).toISOString(), speed: next.speed, range: { start: new Date(next.range.startMs).toISOString(), end: new Date(next.range.endMs).toISOString() } })
      .then((state) => dispatch({ type: 'timeline/runtime', state, nowMs: now() }))
      .catch((err: unknown) => fail('Timeline not applied', err));
  }

  const actions = {
    notify,
    select,
    hover(id: string | null) { dispatch({ type: 'world/hover', id }); },
    clearSelection() { void select(null); },
    flyTo,
    goTo,
    async search(text: string, limit = 12): Promise<SearchResult[]> {
      const center = getState().world.view.center;
      try { return await client.request('search.query', { text, bias: center, limit }); } catch (err) { fail('Search unavailable', err); return []; }
    },

    async setMode(mode: RenderMode): Promise<void> {
      dispatch({ type: 'ui/mode', mode });
      hosts.get()?.setMode(mode);
      const active = hosts.get()?.activeMode();
      if (active) dispatch({ type: 'ui/activeMode', mode: active });
      await updateSettings({ renderMode: mode });
    },
    toggleMode(): void { void actions.setMode(getState().ui.activeMode === '2D' ? '3D' : '2D'); },

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
        } catch (err) { console.warn('[worldview] events for lens failed:', describeError(err)); }
      }
    },

    timeline,
    updateSettings,

    // ---- sources ----
    async setSourceEnabled(providerId: string, enabled: boolean): Promise<void> {
      try { await client.request('sources.setEnabled', { providerId, enabled }); } catch (err) { fail('Source not updated', err); }
    },
    async refreshSource(providerId: string): Promise<void> {
      try { await client.request('sources.refresh', { providerId }); } catch (err) { fail('Refresh failed', err); }
    },
    async loadManifest(providerId: string): Promise<void> {
      if (providerId in getState().sources.manifests) return;
      try { dispatch({ type: 'sources/manifest', providerId, manifest: await client.request('sources.manifest', { providerId }) }); } catch (err) { fail('Manifest unavailable', err); }
    },
    async checkCredential(key: string): Promise<void> {
      try { dispatch({ type: 'sources/credential', key, present: (await client.request('credentials.has', { key })).present }); } catch (err) { fail('Credential state unavailable', err); }
    },
    async setCredential(key: string, value: string, providerId?: string): Promise<boolean> {
      try {
        await client.request('credentials.set', { key, value });
        dispatch({ type: 'sources/credential', key, present: true });
        if (providerId) await client.request('sources.refresh', { providerId });
        notify('Credential stored', 'Saved to the operating system secure store.');
        return true;
      } catch (err) { fail('Credential not stored', err); return false; }
    },
    async deleteCredential(key: string): Promise<void> {
      try { await client.request('credentials.delete', { key }); dispatch({ type: 'sources/credential', key, present: false }); } catch (err) { fail('Credential not removed', err); }
    },
    openSource(providerId: string | null) {
      dispatch({ type: 'ui/sourceDetail', providerId });
      if (providerId) { dispatch({ type: 'ui/contextTab', tab: 'sources' }); void actions.loadManifest(providerId); }
    },

    // ---- collections ----
    async saveCollection(collection: Collection): Promise<void> {
      try { dispatch({ type: 'collections/list', collections: await client.request('collections.save', { ...collection, updatedAt: new Date(now()).toISOString() }) }); } catch (err) { fail('Collection not saved', err); }
    },
    async createCollection(name: string): Promise<string> {
      const id = `col-${now().toString(36)}`;
      const iso = new Date(now()).toISOString();
      await actions.saveCollection({ id, name: name.trim() || 'Untitled collection', createdAt: iso, updatedAt: iso, items: [] });
      dispatch({ type: 'collections/activate', id });
      return id;
    },
    setActiveCollection(id: string | null) { dispatch({ type: 'collections/activate', id }); },
    async renameCollection(id: string, name: string): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === id);
      if (c) await actions.saveCollection({ ...c, name: name.trim() || c.name });
    },
    async deleteCollection(id: string): Promise<void> {
      try { dispatch({ type: 'collections/list', collections: await client.request('collections.delete', { id }) }); } catch (err) { fail('Collection not deleted', err); }
    },
    async addToCollection(collectionId: string, item: Omit<CollectionItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === collectionId);
      if (!c) return;
      const iso = new Date(now()).toISOString();
      await actions.saveCollection({ ...c, items: [...c.items, { ...item, id: `item-${now().toString(36)}-${c.items.length}`, createdAt: iso, updatedAt: iso }] });
    },
    async removeFromCollection(collectionId: string, itemId: string): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === collectionId);
      if (c) await actions.saveCollection({ ...c, items: c.items.filter((i) => i.id !== itemId) });
    },
    async setItemNote(collectionId: string, itemId: string, note: string): Promise<void> {
      const c = getState().collections.collections.find((x) => x.id === collectionId);
      if (!c) return;
      const iso = new Date(now()).toISOString();
      await actions.saveCollection({ ...c, items: c.items.map((i) => (i.id === itemId ? { ...i, note, updatedAt: iso } : i)) });
    },
    async addSelectionToCollection(collectionId: string): Promise<void> {
      const w = getState().world;
      if (w.selectedKind === 'object' && w.selectedObject) {
        const o = w.selectedObject;
        await actions.addToCollection(collectionId, { kind: 'object', title: o.labels['callsign'] ?? o.labels['name'] ?? o.labels['title'] ?? o.id, objectId: o.id, ...(o.position ? { position: o.position } : {}) });
      } else if (w.selectedKind === 'event' && w.selectedEvent) {
        await actions.addToCollection(collectionId, { kind: 'event', title: w.selectedEvent.title, eventId: w.selectedEvent.id });
      }
    },
    async addLocationToCollection(collectionId: string, title?: string): Promise<void> {
      const view = getState().world.view;
      await actions.addToCollection(collectionId, { kind: 'location', title: title ?? `${view.center.latitude.toFixed(3)}, ${view.center.longitude.toFixed(3)}`, position: view.center });
    },
    async exportCollection(id: string): Promise<void> {
      try {
        const r = await client.request('collections.export', { id });
        if ('path' in r) notify('Collection exported', r.path);
      } catch (err) { fail('Export failed', err); }
    },
    async importCollection(): Promise<void> {
      try {
        const r = await client.request('collections.import', undefined);
        if (r.imported) { dispatch({ type: 'collections/list', collections: await client.request('collections.list', undefined) }); notify('Collection imported', r.imported.name); }
        if (r.issues.length) notify('Import issues', r.issues.slice(0, 3).join('; '), 'MINOR');
      } catch (err) { fail('Import failed', err); }
    },

    // ---- watch zones ----
    async saveWatchZone(zone: WatchZone): Promise<void> {
      try { dispatch({ type: 'watchzones/list', zones: await client.request('watchzones.save', zone) }); } catch (err) { fail('Watch zone not saved', err); }
    },
    async deleteWatchZone(id: string): Promise<void> {
      try { dispatch({ type: 'watchzones/list', zones: await client.request('watchzones.delete', { id }) }); } catch (err) { fail('Watch zone not deleted', err); }
    },
    async createCircleZoneAtCenter(radiusM = 50_000, name?: string): Promise<void> {
      const view = getState().world.view;
      const lens = lensById(getState().lenses.activeId, getState().lenses.lenses);
      await actions.saveWatchZone({
        id: `zone-${now().toString(36)}`,
        name: name ?? `Zone near ${view.center.latitude.toFixed(2)}, ${view.center.longitude.toFixed(2)}`,
        geometry: { kind: 'circle', center: { latitude: view.center.latitude, longitude: view.center.longitude }, radiusM },
        eventTypes: lens?.eventTypes.length ? lens.eventTypes : ['earthquake', 'wildfire-cluster', 'weather-alert'],
        notifications: { inApp: true, desktop: false },
        enabled: true,
        createdAt: new Date(now()).toISOString(),
      });
      dispatch({ type: 'ui/contextTab', tab: 'watchzones' });
    },
    flyToZone(zone: WatchZone): void {
      const b = regionBounds(zone.geometry);
      if (b) void flyTo({ position: { latitude: (b.north + b.south) / 2, longitude: (b.east + b.west) / 2 }, bounds: b });
    },

    // ---- ui ----
    openDialog(dialog: DialogId) { dispatch({ type: 'ui/dialog', dialog }); },
    closeDialog() { dispatch({ type: 'ui/dialog', dialog: null }); },
    openPalette() { dispatch({ type: 'ui/palette', open: true }); },
    closePalette() { dispatch({ type: 'ui/palette', open: false }); },
    setRailCollapsed(collapsed: boolean) { dispatch({ type: 'ui/railCollapsed', collapsed }); },
    setContextTab(tab: ContextTab) { dispatch({ type: 'ui/contextTab', tab }); if (tab === 'feed') dispatch({ type: 'feed/markRead' }); },
    focusSearch() { if (typeof document !== 'undefined') document.querySelector<HTMLInputElement>('#wv-global-search input')?.focus(); },
    dismissNotification(id: string) { dispatch({ type: 'ui/dismissNotification', id }); },
    finishWelcome() {
      dispatch({ type: 'session/firstRunDone' });
      dispatch({ type: 'ui/dialog', dialog: null });
      // Persisted through settings so it survives a reinstall of the renderer bundle and
      // is visible to the runtime; a failure here only means the welcome shows again.
      void client.request('settings.set', { firstRunCompleted: true }).catch(() => {});
    },

    // ---- app / diagnostics / updater / offline ----
    async openExternal(url: string): Promise<void> {
      try { const r = await client.request('app.openExternal', { url }); if (!r.opened) notify('Link not opened', url, 'INFO'); } catch (err) { fail('Link not opened', err); }
    },
    async getDiagnostics(): Promise<DiagnosticsSnapshot | null> {
      try { return await client.request('diagnostics.get', undefined); } catch (err) { fail('Diagnostics unavailable', err); return null; }
    },
    async exportDiagnostics(): Promise<void> {
      try { const r = await client.request('diagnostics.export', undefined); if ('path' in r) notify('Diagnostics exported (redacted)', r.path); } catch (err) { fail('Export failed', err); }
    },
    async checkForUpdates(): Promise<void> {
      try { dispatch({ type: 'updater/state', state: await client.request('updater.check', undefined) }); } catch (err) { fail('Update check failed', err); }
    },
    async installUpdate(): Promise<void> {
      try { dispatch({ type: 'updater/state', state: await client.request('updater.install', undefined) }); } catch (err) { fail('Update not installed', err); }
    },
    async installOfflinePack(): Promise<void> {
      try {
        const r = await client.request('offline.installPack', undefined);
        if (r.installed) notify('Offline pack installed', r.installed.name);
        if (r.issues.length) notify('Pack issues', r.issues.slice(0, 3).join('; '), 'MINOR');
        dispatch({ type: 'offline/status', status: await client.request('offline.status', undefined) });
      } catch (err) { fail('Pack not installed', err); }
    },
    async removePack(id: string): Promise<void> {
      try { dispatch({ type: 'offline/status', status: await client.request('offline.removePack', { id }) }); } catch (err) { fail('Pack not removed', err); }
    },
    async setPackEnabled(id: string, enabled: boolean): Promise<void> {
      try { dispatch({ type: 'offline/status', status: await client.request('offline.setPackEnabled', { id, enabled }) }); } catch (err) { fail('Pack not updated', err); }
    },
    async cameraSnapshot(cameraId: string): Promise<CameraSnapshot | null> {
      try { return await client.request('camera.snapshot', { cameraId }); } catch (err) { fail('Snapshot unavailable', err); return null; }
    },
    async whatChangedHere(hours = 24): Promise<WhatChangedResult | null> {
      const view = getState().world.view;
      const bounds = view.bounds ?? { west: view.center.longitude - 5, east: view.center.longitude + 5, south: view.center.latitude - 5, north: view.center.latitude + 5 };
      const end = new Date(now()).toISOString(), start = new Date(now() - hours * 3600_000).toISOString();
      try { return await client.request('world.whatChanged', { region: { kind: 'bounds', bounds }, time: { start, end } }); } catch (err) { fail('What changed unavailable', err); return null; }
    },
    async exportVisible(format: 'geojson' | 'json' | 'csv'): Promise<void> {
      const s = getState();
      const lens = lensById(s.lenses.activeId, s.lenses.lenses);
      const query: WorldQuery = { ...(lens ? { objectTypes: lens.objectTypes } : {}), ...(s.world.view.bounds ? { region: { kind: 'bounds', bounds: s.world.view.bounds } } : {}) };
      try {
        const r = await client.request('export.objects', { query, format });
        if ('path' in r) notify('Export written', r.skippedProviders.length ? `${r.path} (skipped by policy: ${r.skippedProviders.join(', ')})` : r.path);
      } catch (err) { fail('Export failed', err); }
    },
  };
  return actions;
}

export type ShellActions = ReturnType<typeof createActions>;
