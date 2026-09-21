import type { WorldClient, WorldSubscription } from '@worldview/ipc-contract';
import { lensById } from '@worldview/render-core';
import { initialState, rootReducer } from './reducer.js';
import type { RootAction, RootState } from './types.js';

/**
 * Builds a fully loaded RootState from a client without React — the same requests
 * `bindClient` issues at start-up, reduced synchronously. Used by static-markup tests and
 * screenshot/CI runs (`createShell({ client, initialState })`).
 */
export async function loadInitialState(client: WorldClient, now: () => number, opts: { lensId?: string | undefined; subscription?: WorldSubscription | undefined } = {}): Promise<RootState> {
  let state = initialState(now());
  const apply = (action: RootAction) => { state = rootReducer(state, action); };
  const [appInfo, settings] = await Promise.all([client.request('app.info', undefined), client.request('settings.get', undefined)]);
  apply({ type: 'session/ready', appInfo, settings });
  apply({ type: 'sources/list', entries: await client.request('sources.list', undefined), connection: await client.request('sources.connection', undefined) });
  apply({ type: 'timeline/runtime', state: await client.request('timeline.get', undefined), nowMs: now() });
  apply({ type: 'lenses/list', lenses: await client.request('lenses.list', undefined) });
  apply({ type: 'collections/list', collections: await client.request('collections.list', undefined) });
  apply({ type: 'watchzones/list', zones: await client.request('watchzones.list', undefined) });
  apply({ type: 'feed/recent', items: await client.request('feed.recent', { limit: 200 }) });
  apply({ type: 'offline/status', status: await client.request('offline.status', undefined) });
  apply({ type: 'updater/state', state: await client.request('updater.state', undefined) });
  if (opts.lensId) apply({ type: 'lenses/activate', id: opts.lensId });
  const lens = lensById(state.lenses.activeId, state.lenses.lenses);
  const subscription: WorldSubscription = opts.subscription ?? { ...(lens ? { objectTypes: lens.objectTypes } : {}) };
  const snapshot = await client.request('world.subscribe', subscription);
  apply({ type: 'world/snapshot', objects: snapshot.snapshot, count: snapshot.count, subscription });
  if (lens?.eventTypes.length) apply({ type: 'world/events', events: (await client.request('world.events', { eventTypes: lens.eventTypes, limit: 500 })).items });
  return state;
}

/** Selects an object in a loaded state, resolving its track and related items through the client. */
export async function withSelection(state: RootState, client: WorldClient, objectId: string): Promise<RootState> {
  let s = rootReducer(state, { type: 'world/select', id: objectId, kind: 'object' });
  s = rootReducer(s, { type: 'world/selectedObject', object: await client.request('world.get', { objectId }) });
  s = rootReducer(s, { type: 'world/track', objectId, points: await client.request('world.track', { objectId }) });
  const related = await client.request('world.related', { objectId });
  return rootReducer(s, { type: 'world/related', forId: objectId, objects: related.objects, events: related.events });
}
