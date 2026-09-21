import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUILT_IN_LENSES, type LensDefinition, type ViewState } from '@worldview/render-core';
import { createShell } from './create-shell.js';
import { DemoClient } from './demo/demo-client.js';
import { loadInitialState, withSelection } from './store/bootstrap-state.js';
import { rootReducer } from './store/reducer.js';
import { installClock } from './hooks/use-now.js';
import type { RendererHostLike } from './renderer-host-like.js';
import { visibleTabs } from './components/context-rail.js';
import { parsePolygonText } from './panels/watchzones-panel.js';

const T0 = Date.parse('2026-09-21T08:00:00.000Z');
installClock(() => T0);

/** Minimal host for static rendering: reports 2D-only so the shell hides the 3D toggle. */
const fakeHost: RendererHostLike = {
  mount() {}, unmount() {}, setMode() {}, activeMode: () => '2D', supportsMode: (m) => m === '2D',
  getView: (): ViewState => ({ center: { latitude: 20, longitude: -157 }, altitudeM: 1, zoom: 2, headingDegrees: 0, pitchDegrees: -90 }),
  flyTo() {}, select() {}, setLens(_l: LensDefinition) {}, on: () => () => {},
};

function assertHonest(html: string) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/placeholder="[^"]*"/g, '');
  assert.ok(!/\bTODO\b|lorem ipsum|coming soon|not implemented/i.test(text), 'no placeholder text');
}

test('main screen (Overview): layout landmarks, lens names, LIVE, Sources tab, RECORDED DATA banner', async () => {
  const client = new DemoClient({ now: () => T0 });
  const state = await loadInitialState(client, () => T0);
  const html = renderToStaticMarkup(createShell({ client, host: fakeHost, initialState: state, now: () => T0 }));
  assert.ok(html.includes('role="banner"') && html.includes('aria-label="Lenses"') && html.includes('aria-label="Map"') && html.includes('aria-label="Context"') && html.includes('aria-label="Timeline"'));
  for (const lens of BUILT_IN_LENSES) assert.ok(html.includes(`>${lens.name}<`), lens.name);
  assert.ok(html.includes('WORLDVIEW'));
  assert.ok(html.includes('RECORDED DATA'), 'demo banner');
  assert.ok(html.includes('>LIVE<'), 'timeline live badge');
  assert.ok(html.includes('DEGRADED'), 'connection badge reflects mixed source states');
  assert.ok(html.includes('>Sources<') && html.includes('>Selection<') && html.includes('>Feed<'), 'overview lens shows Feed');
  assert.ok(!html.includes('>Collections<'), 'collections tab hidden until opened or lens-visible');
  assert.ok(html.includes('08:00:00') && html.includes('UTC'));
  assert.ok(html.includes('2D') && !html.includes('3D globe'), '3D toggle hidden for a 2D-only host');
  assert.ok(html.includes('objects'), 'object count');
  assert.ok(html.includes('Nothing selected'));
  assertHonest(html);
});

test('selection screen: earthquake and aircraft context sections render registry content', async () => {
  const client = new DemoClient({ now: () => T0 });
  const base = await loadInitialState(client, () => T0, { lensId: 'disasters' });
  const eq = await withSelection(base, client, 'earthquake:usgs:us7000wv01');
  const html = renderToStaticMarkup(createShell({ client, host: fakeHost, initialState: eq, now: () => T0 }));
  assert.ok(html.includes('Kokopo'));
  assert.ok(html.includes('M 5.7 mww') && html.includes('45 km') && html.includes('USGS event page'));
  assert.ok(html.includes('High confidence') || html.includes('Medium confidence'));
  assert.ok(!/confidence[^<]*0\.\d\d/.test(html), 'confidence shown as a class, never a raw number');
  assert.ok(html.includes('Clear selection'));
  assert.ok(html.includes('U.S. Geological Survey'));
  assert.ok(html.includes('Related') && html.includes('>1</span>'), 'related badge counts the linked event');
  assertHonest(html);

  // Two minutes into the recording the aircraft have a track to summarise.
  let later = T0;
  const moving = new DemoClient({ now: () => later });
  later = T0 + 120_000;
  const aviation = await loadInitialState(moving, () => later, { lensId: 'aviation' });
  const ac = await withSelection(aviation, moving, 'aircraft:icao24:a4f0e1');
  const html2 = renderToStaticMarkup(createShell({ client: moving, host: fakeHost, initialState: ac, now: () => later }));
  assert.ok(html2.includes('UAL1541') && html2.includes('N24974') && html2.includes('B739') && html2.includes('2211'));
  assert.ok(html2.includes('35,000 ft') && html2.includes('459 kt'), 'aviation units');
  assert.ok(html2.includes('Track points'), 'history section from the track');
  assert.ok(!html2.includes('>Feed<'), 'aviation lens hides the feed tab');
});

test('sources, feed, settings, diagnostics-ready, attribution, welcome and offline screens', async () => {
  const client = new DemoClient({ now: () => T0 });
  const state = await loadInitialState(client, () => T0);
  const render = (s: typeof state) => renderToStaticMarkup(createShell({ client, host: fakeHost, initialState: s, now: () => T0 }));

  let s = rootReducer(state, { type: 'ui/contextTab', tab: 'sources' });
  s = rootReducer(s, { type: 'ui/sourceDetail', providerId: 'nasa-firms' });
  let html = render(s);
  assert.ok(html.includes('aria-label="Source health"'));
  for (const name of ['USGS Earthquake Hazards Program', 'NASA FIRMS', 'AISStream', 'CelesTrak', 'OpenSky Network']) assert.ok(html.includes(name), name);
  assert.ok(html.includes('Credentials required') && html.includes('Offline') && html.includes('Stale') && html.includes('Disabled') && html.includes('Rate limited'));
  assert.ok(html.includes('firms.mapKey') && html.includes('type="password"'), 'credential entry for the FIRMS key');
  assert.ok(html.includes('Recent transitions') && html.includes('Refresh now'));
  assert.ok(html.includes('cached'), 'cached data labelled');
  assertHonest(html);

  s = rootReducer(state, { type: 'ui/contextTab', tab: 'feed' });
  html = render(s);
  assert.ok(html.includes('World feed') && html.includes('High Surf Warning') && html.includes('AISStream went OFFLINE'));
  assert.ok((html.match(/RECORDED DATA/g) ?? []).length >= 3, 'feed rows are labelled recorded');

  s = rootReducer(state, { type: 'ui/dialog', dialog: 'settings' });
  html = render(s);
  assert.ok(html.includes('role="dialog"') && html.includes('Text scale') && html.includes('Reduced motion') && html.includes('Natural Earth II') && html.includes('Updates are disabled in demo mode'));
  assert.ok(!html.includes('Check now'), 'update check hidden when the updater is disabled');

  s = rootReducer(state, { type: 'ui/dialog', dialog: 'attribution' });
  html = render(s);
  assert.ok(html.includes('Data &amp; attribution') && html.includes('U.S. Geological Survey (public domain)') && html.includes('Orbital elements courtesy of CelesTrak'));

  s = rootReducer(state, { type: 'ui/dialog', dialog: 'welcome' });
  html = render(s);
  assert.ok(html.includes('Welcome to WORLDVIEW') && html.includes('Start with Earth') && html.includes('Privacy boundary') && html.includes('never people'));

  s = rootReducer(state, { type: 'ui/dialog', dialog: 'diagnostics' });
  html = render(s);
  assert.ok(html.includes('Diagnostics') && html.includes('Export diagnostics'));

  s = rootReducer(state, { type: 'sources/connection', connection: { state: 'OFFLINE', networkOnline: false, remoteLive: 0, remoteTotal: 6, localLive: 1, at: new Date(T0).toISOString() } });
  html = render(s);
  assert.ok(html.includes('>OFFLINE<') && html.includes('Offline — remote sources are unreachable'));

  s = rootReducer(state, { type: 'ui/contextTab', tab: 'watchzones' });
  s = rootReducer(s, { type: 'ui/contextTab', tab: 'collections' });
  html = render(s);
  assert.ok(html.includes('>Watch zones<') && html.includes('>Collections<') && html.includes('New collection name'));
});

test('context rail tab visibility and polygon parsing helpers', () => {
  assert.deepEqual(visibleTabs(['selection', 'sources', 'feed'], []), ['selection', 'sources', 'timeline', 'related', 'feed']);
  assert.deepEqual(visibleTabs([], ['watchzones']), ['selection', 'sources', 'timeline', 'related', 'watchzones']);
  const ok = parsePolygonText('21.7, -158.3\n21.3 -156.0\n20.8, -156.1');
  assert.equal(ok.error, undefined);
  assert.equal(ok.ring.length, 4, 'ring is closed');
  assert.deepEqual(ok.ring[0], [-158.3, 21.7]);
  assert.ok(parsePolygonText('1, 2').error);
  assert.ok(parsePolygonText('91, 0\n0, 0\n1, 1').error);
});
