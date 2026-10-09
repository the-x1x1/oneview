import type { Dispatch } from 'react';
import type { WorldChangedEvent, WorldClient } from '@worldview/ipc-contract';
import { isIpcError } from '@worldview/ipc-contract';
import type { RootAction, RootState } from './types.js';
import { lensById } from '@worldview/render-core';
import { markDelta } from '../map/delta-marks.js';

export interface SyncDeps {
  client: WorldClient;
  dispatch: Dispatch<RootAction>;
  getState: () => RootState;
  now: () => number;
  /** How often the active lens's events are read again (tests shorten it). */
  eventsRefreshMs?: number;
}

/**
 * The events list (`world.events`, the newest 500 for the active lens) was read at start and
 * on a lens change only, and merged, so an event that ended stayed and one that began later
 * was missing until the lens changed. It is read again this often and replaces the list.
 */
export const EVENTS_REFRESH_MS = 120_000;

/** How long world deltas are gathered before they are applied together (one frame at most). */
export const DELTA_GATHER_MS = 12;

/** Sanitized error text for the UI (IpcError message or a generic line; never a stack). */
export function describeError(err: unknown): string {
  if (isIpcError(err)) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message.slice(0, 200);
  return 'Request failed';
}

/**
 * Loads the initial state through the request catalogue and subscribes to every runtime
 * event, mapping each to a store action. Returns the unsubscribe function.
 */
export function bindClient({
  client,
  dispatch,
  getState,
  now,
  eventsRefreshMs = EVENTS_REFRESH_MS,
}: SyncDeps): () => void {
  let disposed = false;
  const offs: Array<() => void> = [];
  let eventsInFlight = false;
  const refreshEvents = () => {
    if (disposed || eventsInFlight) return;
    const s = getState();
    const lens = lensById(s.lenses.activeId, s.lenses.lenses);
    if (!lens?.eventTypes.length) return;
    eventsInFlight = true;
    client
      .request('world.events', { eventTypes: lens.eventTypes, limit: 500 })
      .then((page) => {
        // A lens changed meanwhile has read its own; this answer is for the one before.
        if (!disposed && getState().lenses.activeId === lens.id)
          dispatch({ type: 'world/events', events: page.items, replace: true });
      })
      .catch((err: unknown) => {
        if (!disposed) console.warn('[worldview] events refresh failed:', describeError(err));
      })
      .finally(() => {
        eventsInFlight = false;
      });
  };
  const eventsTimer = setInterval(refreshEvents, eventsRefreshMs);
  // Not a reason to keep a process alive on its own (the tests, the demo under Node).
  if (typeof eventsTimer === 'object' && 'unref' in eventsTimer) (eventsTimer as { unref(): void }).unref();
  offs.push(() => clearInterval(eventsTimer));
  const guard =
    <T>(fn: (payload: T) => void) =>
    (payload: T) => {
      if (!disposed) fn(payload);
    };

  // The parts of one big delta arrive back to back (event-wire.ts: ~1 MB each, a couple of
  // dozen for a satellite refresh). Each dispatched on its own re-rendered the shell and
  // copied the whole mirror; gathered for a moment, they are applied as one change.
  let pendingDeltas: WorldChangedEvent[] = [];
  let deltaTimer: ReturnType<typeof setTimeout> | undefined;
  const flushDeltas = () => {
    deltaTimer = undefined;
    const changes = pendingDeltas;
    pendingDeltas = [];
    if (disposed || changes.length === 0) return;
    if (changes.length === 1) dispatch({ type: 'world/changed', change: changes[0]! });
    else dispatch({ type: 'world/changedMany', changes });
  };
  offs.push(() => {
    if (deltaTimer !== undefined) clearTimeout(deltaTimer);
    pendingDeltas = [];
  });
  offs.push(
    client.on(
      'world.changed',
      guard((change) => {
        markDelta(change.objects.length);
        pendingDeltas.push(change);
        deltaTimer ??= setTimeout(flushDeltas, DELTA_GATHER_MS);
      }),
    ),
  );
  // The event types a watch zone offers follow the enabled sources (runtime handlers.ts
  // events.types.list). Read once at start, they stayed as they were when a source was turned
  // off or on in Settings: earthquakes stayed offered with every earthquake source disabled.
  // Asked again whenever the set of enabled sources changes, not on every health update.
  let enabledSources: string | undefined;
  const refreshEventTypes = () =>
    client
      .request('events.types.list', undefined)
      .then(guard((eventTypes) => dispatch({ type: 'session/eventTypes', eventTypes })))
      .catch((err: unknown) => {
        if (!disposed) console.warn('[worldview] event types refresh failed:', describeError(err));
      });
  offs.push(
    client.on(
      'sources.changed',
      guard(({ entries, connection }) => {
        dispatch({ type: 'sources/list', entries, connection });
        const key = entries
          .filter((e) => e.enabled)
          .map((e) => e.providerId)
          .sort()
          .join('\n');
        if (enabledSources !== undefined && key !== enabledSources) void refreshEventTypes();
        enabledSources = key;
      }),
    ),
  );
  // The basemaps on offer depend on the installed packs (the offline vector basemaps read a
  // pack) and on being online (sources with no cached tiles go unavailable offline). Read once
  // at start, a pack installed from Settings left WORLDVIEW dark "unavailable" until a restart.
  // Asked again when either changes, not on every status update.
  let providersKey: string | undefined;
  const refreshMapProviders = (key: string) => {
    if (providersKey === key) return;
    // The first event asks as well: it may be the change (a pack installed before any other
    // offline status was sent), and one request more at start costs nothing.
    providersKey = key;
    client
      .request('map.providers.list', undefined)
      .then(guard((providers) => dispatch({ type: 'session/mapProviders', providers })))
      .catch((err: unknown) => {
        if (!disposed) console.warn('[worldview] map providers refresh failed:', describeError(err));
      });
  };
  let lastPacks = '';
  let lastOnline = true;
  const providersKeyOf = () => `${lastOnline ? 'online' : 'offline'}|${lastPacks}`;
  offs.push(
    client.on(
      'connection.changed',
      guard((connection) => {
        dispatch({ type: 'sources/connection', connection });
        lastOnline = connection.state !== 'OFFLINE';
        refreshMapProviders(providersKeyOf());
      }),
    ),
  );
  offs.push(
    client.on(
      'overlays.changed',
      guard(({ overlays }) => dispatch({ type: 'sources/overlays', overlays })),
    ),
  );
  offs.push(
    client.on(
      'timeline.changed',
      guard((state) => dispatch({ type: 'timeline/runtime', state, nowMs: now() })),
    ),
  );
  offs.push(
    client.on(
      'feed.item',
      guard((item) => dispatch({ type: 'feed/item', item })),
    ),
  );
  offs.push(
    client.on(
      'notification',
      guard((n) =>
        dispatch({
          type: 'ui/notify',
          notification: {
            id: n.id,
            title: n.title,
            body: n.body,
            severity: n.severity,
            ...(n.eventId ? { eventId: n.eventId } : {}),
            ...(n.watchZoneId ? { group: `zone:${n.watchZoneId}` } : {}),
            at: now(),
          },
        }),
      ),
    ),
  );
  offs.push(
    client.on(
      'updater.changed',
      guard((state) => dispatch({ type: 'updater/state', state })),
    ),
  );
  offs.push(
    client.on(
      'field.changed',
      guard((field) => dispatch({ type: 'offline/field', field })),
    ),
  );
  offs.push(
    client.on(
      'offline.changed',
      guard((status) => {
        dispatch({ type: 'offline/status', status });
        lastPacks = status.packs
          .map((p) => `${p.id}:${p.status}`)
          .sort()
          .join(',');
        lastOnline = status.connection.state !== 'OFFLINE';
        refreshMapProviders(providersKeyOf());
      }),
    ),
  );
  offs.push(
    client.on(
      'settings.changed',
      guard((settings) => dispatch({ type: 'session/settings', settings })),
    ),
  );
  offs.push(
    client.on(
      'lenses.changed',
      guard((lenses) => dispatch({ type: 'lenses/list', lenses })),
    ),
  );

  void (async () => {
    try {
      const [appInfo, settings] = await Promise.all([
        client.request('app.info', undefined),
        client.request('settings.get', undefined),
      ]);
      if (disposed) return;
      dispatch({ type: 'session/ready', appInfo, settings });
      // The welcome screen is driven by a persisted setting, so it behaves the same in a
      // packaged app, a portable copy and the browser demo.
      if (!settings.firstRunCompleted) dispatch({ type: 'ui/dialog', dialog: 'welcome' });
    } catch (err) {
      if (!disposed) dispatch({ type: 'session/error', message: describeError(err) });
      return;
    }
    const loads: Array<Promise<void>> = [
      client.request('sources.list', undefined).then((entries) => dispatch({ type: 'sources/list', entries })),
      client.request('overlays.list', undefined).then((overlays) => dispatch({ type: 'sources/overlays', overlays })),
      client
        .request('sources.connection', undefined)
        .then((connection) => dispatch({ type: 'sources/connection', connection })),
      client
        .request('timeline.get', undefined)
        .then((state) => dispatch({ type: 'timeline/runtime', state, nowMs: now() })),
      client.request('lenses.list', undefined).then((lenses) => dispatch({ type: 'lenses/list', lenses })),
      client
        .request('collections.list', undefined)
        .then((collections) => dispatch({ type: 'collections/list', collections })),
      client.request('watchzones.list', undefined).then((zones) => dispatch({ type: 'watchzones/list', zones })),
      client.request('feed.recent', { limit: 200 }).then((items) => dispatch({ type: 'feed/recent', items })),
      client.request('offline.status', undefined).then((status) => dispatch({ type: 'offline/status', status })),
      client.request('field.status', undefined).then((field) => dispatch({ type: 'offline/field', field })),
      client.request('updater.state', undefined).then((state) => dispatch({ type: 'updater/state', state })),
      client
        .request('map.providers.list', undefined)
        .then((providers) => dispatch({ type: 'session/mapProviders', providers })),
      client
        .request('events.types.list', undefined)
        .then((eventTypes) => dispatch({ type: 'session/eventTypes', eventTypes })),
    ];
    for (const p of loads)
      p.catch((err: unknown) => {
        if (!disposed) console.warn('[worldview] initial load failed:', describeError(err));
      });
    await Promise.allSettled(loads);
    // Reflect the settings' lens once lenses are known.
    const s = getState();
    if (s.session.settings && s.lenses.lenses.some((l) => l.id === s.session.settings?.activeLensId))
      dispatch({ type: 'lenses/activate', id: s.session.settings.activeLensId });
  })();

  return () => {
    disposed = true;
    for (const off of offs) off();
  };
}
