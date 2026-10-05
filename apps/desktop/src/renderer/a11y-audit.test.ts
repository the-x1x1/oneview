import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ViewState } from '@worldview/render-core';
import { auditMarkup } from './a11y-audit.js';
import { rememberSkyAnswer } from './panels/sky-panel.js';
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
  // The Sky tab with an answer in hand (its first one comes after the page has drawn).
  rememberSkyAnswer({
    at: new Date(T0).toISOString(),
    observer: { latitude: 21.3, longitude: -157.85 },
    total: 2,
    visible: 1,
    stale: 0,
    sunElevationDeg: -30,
    satellites: [
      {
        id: 'satellite:norad:25544',
        name: 'ISS (ZARYA)',
        category: 'station',
        azimuthDeg: 47,
        elevationDeg: 62,
        rangeM: 470_000,
        altitudeM: 420_000,
        sunlit: true,
      },
      {
        id: 'satellite:norad:2',
        name: 'NOAA 19',
        category: 'weather',
        azimuthDeg: 200,
        elevationDeg: 20,
        rangeM: 1_900_000,
        altitudeM: 850_000,
        sunlit: false,
      },
    ],
  });
  for (const tab of ['sources', 'feed', 'timeline', 'related', 'changes', 'collections', 'watchzones', 'sky'] as const)
    screens.push([`tab ${tab}`, rootReducer(base, { type: 'ui/contextTab', tab })]);
  for (const dialog of ['settings', 'attribution', 'welcome', 'diagnostics'] as const)
    screens.push([`dialog ${dialog}`, rootReducer(base, { type: 'ui/dialog', dialog })]);
  screens.push(['earthquake', await withSelection(base, client, 'earthquake:usgs:us7000wv01')]);
  screens.push([
    "what's here",
    rootReducer(base, {
      type: 'ui/whatsHere',
      whatsHere: { position: { latitude: 19.8207, longitude: -155.468 }, screen: { x: 200, y: 150 } },
    }),
  ]);
  const failures: string[] = [];
  for (const [name, state] of screens) {
    const html = renderToStaticMarkup(createShell({ client, host, initialState: state, now: () => T0 }));
    for (const f of auditMarkup(html)) failures.push(`${name}: ${f.rule}: ${f.element}`);
  }
  assert.deepEqual(failures, [], 'controls without an accessible name');
});
