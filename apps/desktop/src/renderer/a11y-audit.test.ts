import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ViewState } from '@worldview/render-core';
import { auditMarkup } from './a11y-audit.js';
import { createShell } from './create-shell.js';
import { DemoClient } from './demo/demo-client.js';
import { loadInitialState, withSelection } from './store/bootstrap-state.js';
import { rootReducer } from './store/reducer.js';
import { installClock } from './hooks/use-now.js';
import type { RendererHostLike } from './renderer-host-like.js';

const T0 = Date.parse('2026-09-21T08:00:00.000Z');
installClock(() => T0);

const host: RendererHostLike = {
  mount() {},
  unmount() {},
  setMode() {},
  activeMode: () => '3D',
  supportsMode: () => true,
  getView: (): ViewState => ({
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

test('the audit finds what a screen reader could not name', () => {
  const found = auditMarkup(
    '<div><button><svg aria-hidden="true"></svg></button><button aria-label="Close"></button>' +
      '<input type="text"/><label>Name <input type="text"/></label><label for="q">Q</label><input id="q"/>' +
      '<img src="a.png"/><img src="b.png" alt=""/><div role="switch"></div><svg role="img" aria-label="Chart"></svg></div>',
  );
  assert.deepEqual(
    found.map((f) => f.rule),
    ['name', 'label', 'alt', 'name'],
  );
});

test('every screen of the shell names its controls', async () => {
  const client = new DemoClient({ now: () => T0 });
  const base = await loadInitialState(client, () => T0);
  const screens: Array<[string, typeof base]> = [['overview', base]];
  for (const tab of ['sources', 'feed', 'timeline', 'related', 'changes', 'collections', 'watchzones'] as const)
    screens.push([`tab ${tab}`, rootReducer(base, { type: 'ui/contextTab', tab })]);
  for (const dialog of ['settings', 'attribution', 'welcome', 'diagnostics'] as const)
    screens.push([`dialog ${dialog}`, rootReducer(base, { type: 'ui/dialog', dialog })]);
  screens.push(['earthquake', await withSelection(base, client, 'earthquake:usgs:us7000wv01')]);
  const failures: string[] = [];
  for (const [name, state] of screens) {
    const html = renderToStaticMarkup(createShell({ client, host, initialState: state, now: () => T0 }));
    for (const f of auditMarkup(html)) failures.push(`${name}: ${f.rule}: ${f.element}`);
  }
  assert.deepEqual(failures, [], 'controls without an accessible name');
});
