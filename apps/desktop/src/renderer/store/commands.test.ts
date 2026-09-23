import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMMANDS } from '@worldview/query-engine';
import type { SearchResult } from '@worldview/ipc-contract';
import { DemoClient } from '../demo/demo-client.js';
import { loadInitialState } from './bootstrap-state.js';
import { rootReducer } from './reducer.js';
import { createActions } from './actions.js';
import type { RootAction, RootState } from './types.js';
import type { RendererHostLike } from '../renderer-host-like.js';

/**
 * Every command the search grammar can produce has to do something. They used to be
 * ranked, rendered and clickable while `goTo` handled only object/event results and then
 * fell through to a position the command results do not carry — so selecting one cleared
 * the box and did nothing, which is worse than not offering it.
 */

const T0 = Date.parse('2026-09-21T08:00:00.000Z');

const host: RendererHostLike = {
  mount() {},
  unmount() {},
  setMode() {},
  activeMode: () => '2D',
  supportsMode: () => true,
  getView: () => ({
    center: { latitude: 20, longitude: -157 },
    altitudeM: 1,
    zoom: 2,
    headingDegrees: 0,
    pitchDegrees: -90,
  }),
  flyTo() {},
  select() {},
  setLens() {},
  on: () => () => {},
};

async function harness() {
  const client = new DemoClient({ now: () => T0 });
  let state: RootState = await loadInitialState(client, () => T0);
  const dispatch = (action: RootAction) => {
    state = rootReducer(state, action);
  };
  const actions = createActions({
    client,
    dispatch,
    getState: () => state,
    hosts: { get: () => host, set: () => {} },
    now: () => T0,
  });
  return { actions, get: () => state };
}

const commandResult = (id: string): SearchResult => ({
  kind: 'command',
  id: `command:${id}`,
  title: id,
  source: 'command',
  score: 1,
});

test('search commands: every command in the vocabulary has an outcome', async () => {
  for (const command of DEFAULT_COMMANDS) {
    const h = await harness();
    const before = h.get().ui.notifications.length;
    await h.actions.goTo(commandResult(command.id));
    const added = h.get().ui.notifications.slice(before);
    assert.ok(
      !added.some((n) => n.title === 'Command unavailable'),
      `"${command.id}" is offered by the search grammar with no action behind it`,
    );
  }
});

test('search commands: the observable outcomes are the ones the titles promise', async () => {
  const mode = await harness();
  await mode.actions.goTo(commandResult('switch-2d'));
  assert.equal(mode.get().ui.mode, '2D');
  await mode.actions.goTo(commandResult('switch-3d'));
  assert.equal(mode.get().ui.mode, '3D');

  const lens = await harness();
  await lens.actions.goTo(commandResult('lens-maritime'));
  assert.equal(lens.get().lenses.activeId, 'overview', 'categories are layers of the Overview');
  assert.deepEqual(
    lens.get().session.settings?.hiddenLayers.includes('maritime'),
    false,
    'maritime is the one layer left on',
  );
  assert.ok((lens.get().session.settings?.hiddenLayers.length ?? 0) >= 6);

  const dialog = await harness();
  await dialog.actions.goTo(commandResult('open-diagnostics'));
  assert.equal(dialog.get().ui.dialog, 'diagnostics');
  await dialog.actions.goTo(commandResult('manage-providers'));
  assert.equal(dialog.get().ui.dialog, 'settings');

  const tab = await harness();
  await tab.actions.goTo(commandResult('open-source-health'));
  assert.equal(tab.get().ui.contextTab, 'sources');

  const live = await harness();
  await live.actions.goTo(commandResult('pause-is-not-a-command'));
  assert.ok(
    live.get().ui.notifications.some((n) => n.title === 'Command unavailable'),
    'an unknown command says so rather than failing quietly',
  );
});

test('search commands: "go to location" with nothing to go to asks for a place', async () => {
  const h = await harness();
  await h.actions.goTo(commandResult('goto-location'));
  const note = h.get().ui.notifications.at(-1);
  assert.equal(note?.title, 'Where to?');
  assert.match(note?.body ?? '', /place|coordinates/i);
});

test('search queries: a parsed query is run, and an empty result says so', async () => {
  const h = await harness();
  await h.actions.goTo({
    kind: 'query',
    id: 'query:none',
    title: 'tsunamis',
    source: 'parser',
    score: 1,
    query: { objectTypes: ['tsunami-warning'] },
  });
  const note = h.get().ui.notifications.at(-1);
  assert.equal(note?.title, 'No matches');

  const many = await harness();
  await many.actions.goTo({
    kind: 'query',
    id: 'query:aircraft',
    title: 'aircraft',
    source: 'parser',
    score: 1,
    query: { objectTypes: ['aircraft'] },
  });
  const last = many.get().ui.notifications.at(-1);
  assert.equal(last?.title, 'Search', 'the demo world has aircraft, so the query reports its count');
  assert.match(last?.body ?? '', /\d+ match/);
});

test('search: an object outside the current view is flown to from its loaded position', async () => {
  const flights: Array<{ latitude: number; longitude: number }> = [];
  const client = new DemoClient({ now: () => T0 });
  let state: RootState = await loadInitialState(client, () => T0);
  const id = 'earthquake:usgs:us7000wv01';
  const known = await client.request('world.get', { objectId: id });
  assert.ok(known?.position, 'the demo world has it, with a position');
  // Zoomed in elsewhere: the subscription does not hold it.
  const objects = new Map(state.world.objects);
  objects.delete(id);
  state = { ...state, world: { ...state.world, objects } };
  const actions = createActions({
    client,
    dispatch: (action: RootAction) => {
      state = rootReducer(state, action);
    },
    getState: () => state,
    hosts: {
      get: () => ({
        ...host,
        flyTo: (t: { position: { latitude: number; longitude: number } }) => void flights.push(t.position),
      }),
      set: () => {},
    },
    now: () => T0,
  });
  // An object result need not carry a position.
  await actions.goTo({ kind: 'object', id, title: 'M 4.5', source: 'world-state', score: 1 });
  assert.equal(state.world.selectedId, id);
  assert.equal(flights.length, 1, 'the camera goes to it');
  assert.equal(flights[0]?.latitude, known.position.latitude);
  assert.equal(flights[0]?.longitude, known.position.longitude);
});

test('fly targets: a shape flies to its bounds; one across the antimeridian to its centre', async () => {
  const { flyTargetForGeometry } = await import('./actions.js');
  const box = flyTargetForGeometry({
    type: 'Polygon',
    coordinates: [
      [
        [-160, 55],
        [-150, 55],
        [-150, 60],
        [-160, 60],
        [-160, 55],
      ],
    ],
  });
  assert.deepEqual(box?.bounds, { west: -160, south: 55, east: -150, north: 60 });
  const aleutians = flyTargetForGeometry({
    type: 'Polygon',
    coordinates: [
      [
        [175, 51],
        [-175, 51],
        [-175, 53],
        [175, 53],
        [175, 51],
      ],
    ],
  });
  assert.equal(aleutians?.bounds, undefined, 'min/max would span the whole world');
  assert.ok(aleutians?.position);
  assert.deepEqual(flyTargetForGeometry({ type: 'Point', coordinates: [1, 2] }), {
    position: { latitude: 2, longitude: 1 },
  });
});

test('select from the feed: an event the store does not hold is flown to once its details load', async () => {
  const flights: unknown[] = [];
  const client = new DemoClient({ now: () => T0 });
  let state: RootState = await loadInitialState(client, () => T0);
  const recent = await client.request('feed.recent', { limit: 50 });
  const item = recent.find((i) => i.eventId);
  assert.ok(item?.eventId, 'the demo feed has an event');
  const event = await client.request('world.event', { eventId: item.eventId });
  assert.ok(event?.geometry, 'with a place');
  state = { ...state, world: { ...state.world, events: new Map() } };
  const actions = createActions({
    client,
    dispatch: (action: RootAction) => {
      state = rootReducer(state, action);
    },
    getState: () => state,
    hosts: { get: () => ({ ...host, flyTo: (t: unknown) => void flights.push(t) }), set: () => {} },
    now: () => T0,
  });
  await actions.select(item.eventId, { kind: 'event', fly: true });
  assert.equal(flights.length, 1, 'the camera goes there after the details arrive');
});
