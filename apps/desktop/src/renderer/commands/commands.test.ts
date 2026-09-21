import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paletteItems } from '@worldview/ui';
import { buildCommands } from './commands.js';
import { applyKey, resolveKey } from './keyboard.js';
import { initialState, rootReducer } from '../store/reducer.js';
import type { ShellActions } from '../store/actions.js';
import type { RootState } from '../store/types.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');

/** Records which action names were invoked; every command must map to a real action. */
function recordingActions(): { actions: ShellActions; calls: string[] } {
  const calls: string[] = [];
  const handler: ProxyHandler<object> = { get: (_t, prop) => (...args: unknown[]) => { calls.push(`${String(prop)}(${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(',')})`); return undefined; } };
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
  assert.equal(byId('lens.aviation')?.available, true);

  s = rootReducer(s, { type: 'world/select', id: 'aircraft:icao24:abc', kind: 'object' });
  s = rootReducer(s, { type: 'collections/list', collections: [{ id: 'c1', name: 'Trips', createdAt: 'x', updatedAt: 'x', items: [] }] });
  s = rootReducer(s, { type: 'timeline/runtime', nowMs: NOW, state: { mode: 'HISTORICAL', cursor: '2026-09-21T07:00:00.000Z', speed: 1, range: { start: '2026-09-20T08:00:00.000Z', end: '2026-09-21T08:00:00.000Z' }, availability: [{ objectType: 'earthquake', ranges: [{ start: '2026-09-20T08:00:00.000Z', end: '2026-09-21T08:00:00.000Z' }] }] } });
  cmds = buildCommands(s, actions);
  assert.equal(byId('selection.clear')?.available, true);
  assert.equal(byId('collection.add')?.available, true);
  assert.equal(byId('timeline.live')?.available, true);
  assert.equal(byId('timeline.earliest')?.available, true);

  for (const c of cmds) await c.run();
  assert.ok(calls.some((c) => c.startsWith('setLens(aviation)')));
  assert.ok(calls.some((c) => c.startsWith('openDialog(diagnostics)')));
  assert.ok(calls.some((c) => c.startsWith('createCircleZoneAtCenter(50000)')));
  assert.ok(calls.some((c) => c.includes('jumpToLive')));
  assert.ok(calls.some((c) => c.startsWith('addSelectionToCollection(c1)')));
  assert.equal(new Set(cmds.map((c) => c.id)).size, cmds.length, 'command ids are unique');
});

test('palette ranking glue: unavailable commands never appear; query narrows to matches', () => {
  const { actions } = recordingActions();
  const s = initialState(NOW);
  const cmds = buildCommands(s, actions);
  const all = paletteItems('', cmds);
  assert.ok(all.every((i) => i.id !== 'cmd:selection.clear'));
  const diag = paletteItems('diagn', cmds);
  assert.equal(diag[0]?.id, 'cmd:diagnostics.open');
  const lens = paletteItems('maritime', cmds);
  assert.equal(lens[0]?.id, 'cmd:lens.maritime');
  assert.ok(paletteItems('zzzzzz', cmds).length === 0);
});

test('keyboard map: Ctrl+K, Esc precedence, / focus, 2/3 modes, ignores editable targets', () => {
  assert.equal(resolveKey({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, inEditable: true }), 'palette');
  assert.equal(resolveKey({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: true }), 'escape');
  assert.equal(resolveKey({ key: '/', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }), 'search');
  assert.equal(resolveKey({ key: '/', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: true }), null);
  assert.equal(resolveKey({ key: '2', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }), 'mode2d');
  assert.equal(resolveKey({ key: '3', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, inEditable: false }), 'mode3d');
  assert.equal(resolveKey({ key: '3', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, inEditable: false }), null);

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
