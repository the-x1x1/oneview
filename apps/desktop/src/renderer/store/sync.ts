import type { Dispatch } from 'react';
import type { WorldClient } from '@worldview/ipc-contract';
import { isIpcError } from '@worldview/ipc-contract';
import type { RootAction, RootState } from './types.js';

export interface SyncDeps {
  client: WorldClient;
  dispatch: Dispatch<RootAction>;
  getState: () => RootState;
  now: () => number;
}

/** Sanitized error text for the UI (IpcError message or a generic line; never a stack). */
export function describeError(err: unknown): string {
  if (isIpcError(err)) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message.slice(0, 200);
  return 'Request failed';
}

const WELCOME_KEY = 'worldview.welcomeSeen';

export function readFirstRun(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(WELCOME_KEY) !== '1'; } catch { return false; }
}

export function markWelcomeSeen(): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(WELCOME_KEY, '1'); } catch { /* storage unavailable: welcome shows again next launch */ }
}

/**
 * Loads the initial state through the request catalogue and subscribes to every runtime
 * event, mapping each to a store action. Returns the unsubscribe function.
 */
export function bindClient({ client, dispatch, getState, now }: SyncDeps): () => void {
  let disposed = false;
  const offs: Array<() => void> = [];
  const guard = <T,>(fn: (payload: T) => void) => (payload: T) => { if (!disposed) fn(payload); };

  offs.push(client.on('world.changed', guard((change) => dispatch({ type: 'world/changed', change }))));
  offs.push(client.on('sources.changed', guard(({ entries, connection }) => dispatch({ type: 'sources/list', entries, connection }))));
  offs.push(client.on('connection.changed', guard((connection) => dispatch({ type: 'sources/connection', connection }))));
  offs.push(client.on('timeline.changed', guard((state) => dispatch({ type: 'timeline/runtime', state, nowMs: now() }))));
  offs.push(client.on('feed.item', guard((item) => dispatch({ type: 'feed/item', item }))));
  offs.push(client.on('notification', guard((n) => dispatch({ type: 'ui/notify', notification: { id: n.id, title: n.title, body: n.body, severity: n.severity, ...(n.eventId ? { eventId: n.eventId } : {}), at: now() } }))));
  offs.push(client.on('updater.changed', guard((state) => dispatch({ type: 'updater/state', state }))));
  offs.push(client.on('offline.changed', guard((status) => dispatch({ type: 'offline/status', status }))));
  offs.push(client.on('settings.changed', guard((settings) => dispatch({ type: 'session/settings', settings }))));
  offs.push(client.on('lenses.changed', guard((lenses) => dispatch({ type: 'lenses/list', lenses }))));

  void (async () => {
    try {
      const [appInfo, settings] = await Promise.all([client.request('app.info', undefined), client.request('settings.get', undefined)]);
      if (disposed) return;
      dispatch({ type: 'session/ready', appInfo, settings });
      if (readFirstRun()) dispatch({ type: 'ui/dialog', dialog: 'welcome' });
    } catch (err) {
      if (!disposed) dispatch({ type: 'session/error', message: describeError(err) });
      return;
    }
    const loads: Array<Promise<void>> = [
      client.request('sources.list', undefined).then((entries) => dispatch({ type: 'sources/list', entries })),
      client.request('sources.connection', undefined).then((connection) => dispatch({ type: 'sources/connection', connection })),
      client.request('timeline.get', undefined).then((state) => dispatch({ type: 'timeline/runtime', state, nowMs: now() })),
      client.request('lenses.list', undefined).then((lenses) => dispatch({ type: 'lenses/list', lenses })),
      client.request('collections.list', undefined).then((collections) => dispatch({ type: 'collections/list', collections })),
      client.request('watchzones.list', undefined).then((zones) => dispatch({ type: 'watchzones/list', zones })),
      client.request('feed.recent', { limit: 200 }).then((items) => dispatch({ type: 'feed/recent', items })),
      client.request('offline.status', undefined).then((status) => dispatch({ type: 'offline/status', status })),
      client.request('updater.state', undefined).then((state) => dispatch({ type: 'updater/state', state })),
    ];
    for (const p of loads) p.catch((err: unknown) => { if (!disposed) console.warn('[worldview] initial load failed:', describeError(err)); });
    await Promise.allSettled(loads);
    // Reflect the settings' lens once lenses are known.
    const s = getState();
    if (s.session.settings && s.lenses.lenses.some((l) => l.id === s.session.settings?.activeLensId)) dispatch({ type: 'lenses/activate', id: s.session.settings.activeLensId });
  })();

  return () => { disposed = true; for (const off of offs) off(); };
}
