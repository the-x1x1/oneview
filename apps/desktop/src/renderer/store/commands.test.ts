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
  assert.equal(lens.get().lenses.activeId, 'maritime');

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
