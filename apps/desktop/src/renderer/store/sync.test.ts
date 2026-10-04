import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldChangedEvent, WorldClient } from '@worldview/ipc-contract';
import { bindClient, DELTA_GATHER_MS } from './sync.js';
import type { RootAction } from './types.js';

function fakeClient() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const client = {
    on: (channel: string, fn: (payload: unknown) => void) => {
      handlers.set(channel, fn);
      return () => handlers.delete(channel);
    },
    request: () => new Promise(() => undefined),
  } as unknown as WorldClient;
  return { client, emit: (channel: string, payload: unknown) => handlers.get(channel)?.(payload) };
}

const delta = (id: string): WorldChangedEvent =>
  ({
    added: [id],
    updated: [],
    removed: [],
    refreshed: [],
    objects: [{ id }],
    freshness: [],
    at: '2026-09-23T08:00:00.000Z',
  }) as unknown as WorldChangedEvent;

test('the parts of a big delta that arrive together are dispatched as one change', async () => {
  const { client, emit } = fakeClient();
  const actions: RootAction[] = [];
  const off = bindClient({
    client,
    dispatch: (a) => actions.push(a),
    getState: () => ({}) as never,
    now: () => 0,
  });
  emit('world.changed', delta('a'));
  emit('world.changed', delta('b'));
  emit('world.changed', delta('c'));
  assert.equal(actions.filter((a) => a.type.startsWith('world/changed')).length, 0, 'gathered first');
  await new Promise((r) => setTimeout(r, DELTA_GATHER_MS + 20));
  const world = actions.filter((a) => a.type.startsWith('world/changed'));
  assert.equal(world.length, 1);
  assert.equal(world[0]!.type, 'world/changedMany');
  assert.deepEqual(
    (world[0] as { changes: WorldChangedEvent[] }).changes.map((c) => c.added[0]),
    ['a', 'b', 'c'],
    'in the order they came',
  );
  emit('world.changed', delta('d'));
  await new Promise((r) => setTimeout(r, DELTA_GATHER_MS + 20));
  assert.equal(actions.filter((a) => a.type === 'world/changed').length, 1, 'a lone delta is dispatched as itself');
  emit('world.changed', delta('e'));
  off();
  await new Promise((r) => setTimeout(r, DELTA_GATHER_MS + 20));
  assert.equal(actions.filter((a) => a.type.startsWith('world/changed')).length, 2, 'nothing after dispose');
});

test('the watch-zone event types are asked for again when a source is turned off or on, not on every health update', async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const asked: string[] = [];
  const client = {
    on: (channel: string, fn: (payload: unknown) => void) => {
      handlers.set(channel, fn);
      return () => handlers.delete(channel);
    },
    request: (name: string) => {
      asked.push(name);
      return name === 'events.types.list' ? Promise.resolve([{ type: 'earthquake' }]) : new Promise(() => undefined);
    },
  } as unknown as WorldClient;
  const actions: RootAction[] = [];
  const off = bindClient({ client, dispatch: (a) => actions.push(a), getState: () => ({}) as never, now: () => 0 });
  const typesAsked = () => asked.filter((n) => n === 'events.types.list').length;
  const atStart = typesAsked();
  const sources = (usgs: boolean) => ({
    entries: [
      { providerId: 'adsb', enabled: true },
      { providerId: 'usgs', enabled: usgs },
    ],
    connection: {},
  });
  handlers.get('sources.changed')!(sources(true));
  handlers.get('sources.changed')!(sources(true));
  assert.equal(typesAsked(), atStart, 'health updates with the same sources enabled ask for nothing');
  handlers.get('sources.changed')!(sources(false));
  assert.equal(typesAsked(), atStart + 1, 'a source turned off');
  handlers.get('sources.changed')!(sources(true));
  assert.equal(typesAsked(), atStart + 2, 'and back on');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(actions.some((a) => a.type === 'session/eventTypes'));
  off();
});

test('the basemaps are asked for again when a pack is installed or the connection goes offline, not on every update', async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const asked: string[] = [];
  const client = {
    on: (channel: string, fn: (payload: unknown) => void) => {
      handlers.set(channel, fn);
      return () => handlers.delete(channel);
    },
    request: (name: string) => {
      asked.push(name);
      return name === 'map.providers.list'
        ? Promise.resolve({ basemaps: [], terrains: [], activeBasemapId: 'x', activeTerrainId: 'y' })
        : new Promise(() => undefined);
    },
  } as unknown as WorldClient;
  const actions: RootAction[] = [];
  const off = bindClient({ client, dispatch: (a) => actions.push(a), getState: () => ({}) as never, now: () => 0 });
  const listed = () => asked.filter((n) => n === 'map.providers.list').length;
  const status = (packs: Array<{ id: string; status: string }>, state = 'CONNECTED') => ({
    connection: { state },
    packs,
    capabilities: {},
  });
  const start = listed();
  handlers.get('offline.changed')!(status([]));
  assert.equal(listed(), start + 1, 'the first status asks');
  handlers.get('offline.changed')!(status([]));
  handlers.get('connection.changed')!({ state: 'CONNECTED' });
  assert.equal(listed(), start + 1, 'nothing changed: nothing asked');
  handlers.get('offline.changed')!(status([{ id: 'hawaii', status: 'active' }]));
  assert.equal(listed(), start + 2, 'a pack installed');
  handlers.get('connection.changed')!({ state: 'OFFLINE' });
  assert.equal(listed(), start + 3, 'offline');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(actions.some((a) => a.type === 'session/mapProviders'));
  off();
});

test("the active lens's events are read again on a timer and replace the list; a lens changed meanwhile wins", async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  let lensId = 'overview';
  let release: ((v: unknown) => void) | undefined;
  let hold = false;
  const asked: unknown[] = [];
  const client = {
    on: (channel: string, fn: (payload: unknown) => void) => {
      handlers.set(channel, fn);
      return () => handlers.delete(channel);
    },
    request: (method: string, params: unknown) => {
      if (method !== 'world.events') return new Promise(() => undefined);
      asked.push(params);
      if (hold) return new Promise((r) => (release = r));
      return Promise.resolve({ items: [{ id: 'event:new' }] });
    },
  } as unknown as WorldClient;
  const actions: RootAction[] = [];
  const off = bindClient({
    client,
    dispatch: (a) => actions.push(a),
    getState: () => ({ lenses: { activeId: lensId, lenses: [] } }) as never,
    now: () => 0,
    eventsRefreshMs: 30,
  });
  await new Promise((r) => setTimeout(r, 45));
  const first = actions.filter((a) => a.type === 'world/events');
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], { type: 'world/events', events: [{ id: 'event:new' }], replace: true });
  assert.ok((asked[0] as { eventTypes: string[] }).eventTypes.length > 0, "the overview lens's event types");

  // A request in flight when the lens changes: its answer is for the old lens, not applied,
  // and no second request is sent while one is out.
  hold = true;
  const sent = asked.length;
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(asked.length, sent + 1);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(asked.length, sent + 1, 'one at a time');
  lensId = 'not-the-same';
  release?.({ items: [{ id: 'event:old-lens' }] });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!actions.some((a) => a.type === 'world/events' && (a.events[0] as { id: string }).id === 'event:old-lens'));
  off();
  const count = actions.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(actions.length, count, 'nothing after dispose');
});
