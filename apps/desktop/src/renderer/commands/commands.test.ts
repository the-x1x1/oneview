import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paletteItems } from '@worldview/ui';
import { buildCommands } from './commands.js';
import { applyKey, resolveKey } from './keyboard.js';
import { initialState, rootReducer } from '../store/reducer.js';
import type { ShellActions } from '../store/actions.js';
import type { RootState } from '../store/types.js';
import type { AppSettings } from '@worldview/ipc-contract';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');

/** Records which action names were invoked; every command must map to a real action. */
function recordingActions(): { actions: ShellActions; calls: string[] } {
  const calls: string[] = [];
  const handler: ProxyHandler<object> = {
    get:
      (_t, prop) =>
      (...args: unknown[]) => {
        calls.push(
          `${String(prop)}(${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(',')})`,
        );
        return undefined;
      },
  };
  return { actions: new Proxy({}, handler) as ShellActions, calls };
}

test('commands: availability follows state; every command runs a shell action', async () => {
  const { actions, calls } = recordingActions();
  let s: RootState = initialState(NOW);
  let cmds = buildCommands(s, actions);
  const byId = (id: string) => cmds.find((c) => c.id === id);
  assert.equal(byId('selection.clear')?.available, false);
  assert.equal(byId('collection.add')?.available, false);
  assert.equal(byId('timeline.live')?.available, false, 'already live');
  assert.equal(byId('timeline.earliest')?.available, false, 'no history');
  assert.equal(byId('lens.overview')?.available, false, 'active lens is not offered');
  assert.equal(byId('lens.aviation'), undefined, 'categories are layers, not lenses');
  assert.equal(byId('layer.aviation')?.title, 'Hide Aviation', 'every layer starts on');
  assert.notEqual(byId('layer.aviation.only')?.available, false);
  assert.equal(byId('layer.all')?.available, false, 'nothing hidden');

  s = rootReducer(s, { type: 'world/select', id: 'aircraft:icao24:abc', kind: 'object' });
  s = rootReducer(s, {
    type: 'collections/list',
    collections: [{ id: 'c1', name: 'Trips', createdAt: 'x', updatedAt: 'x', items: [] }],
  });
  s = rootReducer(s, {
    type: 'timeline/runtime',
    nowMs: NOW,
    state: {
      mode: 'HISTORICAL',
      cursor: '2026-09-21T07:00:00.000Z',
      speed: 1,
      range: { start: '2026-09-20T08:00:00.000Z', end: '2026-09-21T08:00:00.000Z' },
      availability: [
        { objectType: 'earthquake', ranges: [{ start: '2026-09-20T08:00:00.000Z', end: '2026-09-21T08:00:00.000Z' }] },
      ],
    },
  });
  cmds = buildCommands(s, actions);
  assert.equal(byId('selection.clear')?.available, true);
  assert.equal(byId('collection.add')?.available, true);
  assert.equal(byId('timeline.live')?.available, true);
  assert.equal(byId('timeline.earliest')?.available, true);

  for (const c of cmds) await c.run();
  assert.ok(calls.some((c) => c.startsWith('setLayerVisible(aviation,false)')));
  assert.ok(calls.some((c) => c.startsWith('showOnlyLayer(aviation)')));
  assert.ok(calls.some((c) => c.startsWith('openDialog(diagnostics)')));
  assert.ok(calls.some((c) => c.startsWith('createCircleZoneAtCenter(50000)')));
  assert.ok(calls.some((c) => c.includes('jumpToLive')));
  assert.ok(calls.some((c) => c.startsWith('addSelectionToCollection(c1)')));
  assert.equal(new Set(cmds.map((c) => c.id)).size, cmds.length, 'command ids are unique');
});

test('commands: a hidden layer is offered to show; one alone is not offered alone again', () => {
  const { actions } = recordingActions();
  let s: RootState = initialState(NOW);
  const settings = {
    ...s.session.settings!,
    hiddenLayers: ['maritime', 'space', 'weather', 'disasters', 'transportation', 'infrastructure', 'environment'],
  };
  s = rootReducer(s, { type: 'session/settings', settings });
  const cmds = buildCommands(s, actions);
  const byId = (id: string) => cmds.find((c) => c.id === id);
  assert.equal(byId('layer.maritime')?.title, 'Show Maritime');
  assert.equal(byId('layer.aviation.only')?.available, false, 'already the only one on');
  assert.notEqual(byId('layer.all')?.available, false);
});

test('palette ranking glue: unavailable commands never appear; query narrows to matches', () => {
  const { actions } = recordingActions();
  const s = initialState(NOW);
  const cmds = buildCommands(s, actions);
  const all = paletteItems('', cmds);
  assert.ok(all.every((i) => i.id !== 'cmd:selection.clear'));
  const diag = paletteItems('diagn', cmds);
  assert.equal(diag[0]?.id, 'cmd:diagnostics.open');
  const layer = paletteItems('maritime', cmds);
  assert.ok(layer[0]?.id.startsWith('cmd:layer.maritime'), layer[0]?.id);
  assert.ok(paletteItems('zzzzzz', cmds).length === 0);
});

test('keyboard map: Ctrl+K, Esc precedence, / focus, 2/3 modes, ignores editable targets', () => {
  assert.equal(
    resolveKey({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, inEditable: true }),
    'palette',
  );
  assert.equal(
    resolveKey({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: true }),
    'escape',
  );
  assert.equal(
    resolveKey({ key: '/', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }),
    'search',
  );
  assert.equal(
    resolveKey({ key: '/', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: true }),
    null,
  );
  assert.equal(
    resolveKey({ key: '2', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }),
    'mode2d',
  );
  assert.equal(
    resolveKey({ key: '3', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }),
    'mode3d',
  );
  assert.equal(
    resolveKey({ key: '3', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, inEditable: false }),
    null,
  );

  const { actions, calls } = recordingActions();
  let s = initialState(NOW);
  assert.equal(applyKey('escape', s, actions), false, 'nothing to close');
  s = rootReducer(s, { type: 'ui/palette', open: true });
  s = rootReducer(s, { type: 'ui/dialog', dialog: 'settings' });
  s = rootReducer(s, { type: 'world/select', id: 'x', kind: 'object' });
  assert.equal(applyKey('escape', s, actions), true);
  assert.equal(calls.at(-1), 'closePalette()', 'palette closes first');
  s = rootReducer(s, { type: 'ui/palette', open: false });
  applyKey('escape', s, actions);
  assert.equal(calls.at(-1), 'closeDialog()', 'then dialogs');
  s = rootReducer(s, { type: 'ui/dialog', dialog: null });
  applyKey('escape', s, actions);
  assert.equal(calls.at(-1), 'clearSelection()', 'then the selection');
  applyKey('mode3d', s, actions);
  assert.equal(calls.at(-1), 'setMode(3D)');
});

test('commands: the last search can be exported once one has run, and the command names it', async () => {
  const { actions, calls } = recordingActions();
  let s: RootState = initialState(NOW);
  let cmds = buildCommands(s, actions);
  assert.equal(cmds.find((c) => c.id === 'export.query.csv')?.available, false, 'no search yet');
  s = rootReducer(s, {
    type: 'ui/lastQuery',
    query: {
      objectTypes: ['earthquake'],
      time: { start: '2026-09-14T08:00:00.000Z', end: '2026-09-21T08:00:00.000Z' },
    },
    title: 'M5+ earthquakes (last 7 days)',
    total: 12,
  });
  cmds = buildCommands(s, actions);
  const csv = cmds.find((c) => c.id === 'export.query.csv')!;
  assert.equal(csv.available, true);
  assert.match(csv.title, /M5\+ earthquakes \(last 7 days\)$/);
  await csv.run();
  assert.deepEqual(calls.slice(-1), ['exportLastQuery(csv)']);
});

const SETTINGS: AppSettings = {
  renderMode: '3D',
  firstRunCompleted: true,
  basemapId: 'b',
  terrainId: 't',
  activeLensId: 'overview',
  reducedMotion: false,
  textScale: 1,
  updater: { automatic: false, prerelease: false },
  cameras: { go2rtcPath: '' },
  demoMode: true,
  privacy: { telemetry: false },
  providers: {},
  hiddenLayers: [],
  tileCache: { maxMB: 2048, preloadWorld: false },
  history: { maxMB: 10_240 },
  reference: { borders: true, labels: true },
  display: { graphics: 'auto', visualStyle: 'thermal', hud: false, dayNight: true },
};

const key = (k: string, extra: Partial<Parameters<typeof resolveKey>[0]> = {}) =>
  resolveKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false, ...extra });

test('keyboard map: H, V / Shift+V, N, O, F and C; never with a modifier or in a text field', () => {
  assert.equal(key('h'), 'toggleHud');
  assert.equal(key('H'), 'toggleHud', 'Caps Lock is not Shift');
  assert.equal(key('H', { shiftKey: true }), 'goHome', 'Shift+H: the home view');
  assert.equal(key('Home'), 'goHome');
  assert.equal(key('Home', { inEditable: true }), null, 'Home in the search box moves the caret');
  assert.equal(key('v'), 'nextStyle');
  assert.equal(key('V', { shiftKey: true }), 'previousStyle');
  assert.equal(key('V'), 'nextStyle', 'Caps Lock is not Shift');
  assert.equal(key('n'), 'toggleDayNight');
  assert.equal(key('o'), 'toggleOrbit');
  assert.equal(key('f'), 'toggleFollow');
  assert.equal(key('c'), 'toggleCleanView');
  assert.equal(key('m'), 'toggleMeasure');
  assert.equal(key('M'), 'toggleMeasure', 'Caps Lock is not Shift');
  assert.equal(key('g'), 'toggleGrid');
  assert.equal(key('r'), 'toggleRangeRings');
  assert.equal(key('R'), 'toggleRangeRings', 'Caps Lock is not Shift');
  assert.equal(key('G'), 'toggleGrid', 'Caps Lock is not Shift');
  assert.equal(key('g', { inEditable: true }), null, 'typing a G in the search box');
  assert.equal(key('c', { ctrlKey: true }), null, 'Ctrl+C still copies');
  assert.equal(key('v', { metaKey: true }), null, 'Cmd+V still pastes');
  assert.equal(key('h', { inEditable: true }), null, 'typing an H in the search box');
  assert.equal(key('o', { altKey: true }), null);
});

test('keyboard: display keys run their actions; F follows an object only; Esc leaves clean view before clearing the selection', () => {
  const { actions, calls } = recordingActions();
  let s = initialState(NOW);
  s = rootReducer(s, { type: 'session/settings', settings: SETTINGS });
  applyKey('toggleHud', s, actions);
  applyKey('nextStyle', s, actions);
  applyKey('previousStyle', s, actions);
  applyKey('toggleDayNight', s, actions);
  applyKey('toggleOrbit', s, actions);
  applyKey('goHome', s, actions);
  applyKey('toggleGrid', s, actions);
  applyKey('toggleRangeRings', s, actions);
  applyKey('toggleFieldStatus', s, actions);
  assert.deepEqual(calls, [
    'toggleHud()',
    'cycleVisualStyle(1)',
    'cycleVisualStyle(-1)',
    'toggleDayNight()',
    'setOrbit(true)',
    'goHome()',
    'toggleGrid()',
    'toggleRangeRings()',
    'toggleFieldStatus()',
  ]);
  assert.equal(
    resolveKey({ key: 'b', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }),
    'toggleFieldStatus',
  );
  assert.equal(applyKey('toggleFollow', s, actions), false, 'nothing selected, nothing to follow');
  s = rootReducer(s, { type: 'world/select', id: 'event:quake', kind: 'event' });
  assert.equal(applyKey('toggleFollow', s, actions), false, 'an event does not move');
  s = rootReducer(s, { type: 'world/select', id: 'aircraft:icao24:abc', kind: 'object' });
  assert.equal(applyKey('toggleFollow', s, actions), true);
  assert.equal(calls.at(-1), 'setFollow(true)');
  s = rootReducer(s, { type: 'ui/cameraMode', orbit: false, followId: 'aircraft:icao24:abc' });
  applyKey('toggleFollow', s, actions);
  assert.equal(calls.at(-1), 'setFollow(false)');

  applyKey('toggleCleanView', s, actions);
  assert.equal(calls.at(-1), 'setCleanView(true)');
  s = rootReducer(s, { type: 'ui/cleanView', on: true });
  s = rootReducer(s, {
    type: 'ui/whatsHere',
    whatsHere: { position: { latitude: 19.7, longitude: -155.1 }, screen: { x: 10, y: 20 } },
  });
  applyKey('escape', s, actions);
  assert.equal(calls.at(-1), 'closeWhatsHere()', "Esc puts What's here away first");
  s = rootReducer(s, { type: 'ui/whatsHere', whatsHere: null });
  applyKey('escape', s, actions);
  assert.equal(calls.at(-1), 'setCleanView(false)', 'Esc leaves clean view first');
  s = rootReducer(s, { type: 'ui/cleanView', on: false });
  applyKey('toggleMeasure', s, actions);
  assert.equal(calls.at(-1), 'toggleMeasure()');
  s = rootReducer(s, { type: 'ui/measure', measure: { points: [] } });
  applyKey('escape', s, actions);
  assert.equal(calls.at(-1), 'toggleMeasure()', 'Esc ends measuring before it clears the selection');
  s = rootReducer(s, { type: 'ui/measure', measure: null });
  applyKey('escape', s, actions);
  assert.equal(calls.at(-1), 'clearSelection()', 'then clears the selection');
  assert.equal(
    resolveKey({ key: ']', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }),
    'nextNearby',
  );
  assert.equal(
    resolveKey({ key: '[', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: true }),
    null,
    'not while typing',
  );
  const k = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false };
  assert.equal(resolveKey({ ...k, key: ']', repeat: true }), null, 'held down: one step, not thirty a second');
  assert.equal(resolveKey({ ...k, key: '[', ctrlKey: true, altKey: true }), 'previousNearby', 'typed with AltGr');
  assert.equal(resolveKey({ ...k, key: ']', ctrlKey: true }), null, 'Ctrl+] is not it');
  applyKey('previousNearby', s, actions);
  assert.equal(calls.at(-1), 'selectNearby(-1)');
});

test('commands: display commands show their keys, name the style they go to, and respect reduced motion', async () => {
  const { actions, calls } = recordingActions();
  let s = initialState(NOW);
  s = rootReducer(s, { type: 'session/settings', settings: SETTINGS });
  let cmds = buildCommands(s, actions);
  const byId = (id: string) => cmds.find((c) => c.id === id);
  assert.equal(byId('view.hud')?.shortcut, 'H');
  assert.equal(byId('view.hud')?.title, 'Show HUD');
  assert.equal(byId('view.style.next')?.shortcut, 'V');
  assert.equal(byId('view.style.next')?.title, 'Next visual style (CRT)');
  assert.equal(byId('view.style.previous')?.shortcut, 'Shift+V');
  assert.equal(byId('view.style.previous')?.title, 'Previous visual style (Night vision)');
  assert.equal(byId('view.style.thermal')?.available, false, 'the style shown is not offered');
  assert.equal(byId('view.daynight')?.title, 'Hide day and night');
  assert.equal(byId('view.daynight')?.shortcut, 'N');
  assert.equal(byId('view.clean')?.shortcut, 'C');
  assert.equal(byId('camera.orbit')?.shortcut, 'O');
  assert.equal(byId('camera.follow')?.shortcut, 'F');
  assert.equal(byId('camera.follow')?.available, false, 'nothing selected');
  await byId('view.style.noir')!.run();
  assert.equal(calls.at(-1), 'setVisualStyle(noir)');

  s = rootReducer(s, { type: 'session/settings', settings: { ...SETTINGS, reducedMotion: true } });
  cmds = buildCommands(s, actions);
  assert.equal(byId('camera.orbit')?.available, false, 'reduced motion: nothing turns by itself');
  s = rootReducer(s, { type: 'world/select', id: 'vessel:mmsi:1', kind: 'object' });
  cmds = buildCommands(s, actions);
  assert.notEqual(byId('camera.follow')?.available, false);
  assert.equal(new Set(cmds.map((c) => c.id)).size, cmds.length, 'command ids are unique');
});

test('camera state: orbit and follow exclusive; a new selection lets go; reduced motion and a mode switch stop them', () => {
  let s = initialState(NOW);
  s = rootReducer(s, { type: 'session/settings', settings: SETTINGS });
  s = rootReducer(s, { type: 'ui/cameraMode', orbit: true, followId: null });
  assert.equal(s.ui.orbit, true);
  s = rootReducer(s, { type: 'ui/cameraMode', orbit: true, followId: 'a' });
  assert.deepEqual([s.ui.orbit, s.ui.followId], [false, 'a'], 'follow wins');
  s = rootReducer(s, { type: 'world/select', id: 'a', kind: 'object' });
  assert.equal(s.ui.followId, 'a', 're-selecting the same object keeps following it');
  s = rootReducer(s, { type: 'world/select', id: 'b', kind: 'object' });
  assert.equal(s.ui.followId, null);
  s = rootReducer(s, { type: 'ui/cameraMode', orbit: true, followId: null });
  s = rootReducer(s, { type: 'session/settings', settings: { ...SETTINGS, reducedMotion: true } });
  assert.equal(s.ui.orbit, false);
  s = rootReducer(s, { type: 'ui/cameraMode', orbit: false, followId: 'b' });
  s = rootReducer(s, { type: 'ui/activeMode', mode: '3D' });
  assert.equal(s.ui.followId, null, 'the renderer left behind lets go');
});

test('commands: the Storms quick view is offered once settings are loaded and runs its action', async () => {
  const { actions, calls } = recordingActions();
  let s: RootState = initialState(NOW);
  assert.equal(buildCommands(s, actions).find((c) => c.id === 'view.storms')?.available, false);
  s = rootReducer(s, { type: 'session/settings', settings: { hiddenLayers: [] } as unknown as AppSettings });
  const storms = buildCommands(s, actions).find((c) => c.id === 'view.storms')!;
  assert.notEqual(storms.available, false);
  assert.ok(storms.keywords?.includes('hurricane') && storms.keywords.includes('tornado'));
  await storms.run();
  assert.deepEqual(calls, ['showStorms()']);
});
