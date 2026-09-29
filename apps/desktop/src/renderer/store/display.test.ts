import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { DemoClient } from '../demo/demo-client.js';
import { loadInitialState } from './bootstrap-state.js';
import { rootReducer } from './reducer.js';
import { createActions, SELECTION_PITCH_DEGREES } from './actions.js';
import type { RootAction, RootState } from './types.js';
import type { RendererHostLike } from '../renderer-host-like.js';
import { displaySettings, objectFeatureId, objectIdOfFeature } from './display.js';

const T0 = Date.parse('2026-09-21T08:00:00.000Z');
const ISO = new Date(T0).toISOString();

async function harness() {
  const flights: Array<{ target: unknown; opts: unknown }> = [];
  const host: RendererHostLike = {
    mount() {},
    unmount() {},
    setMode() {},
    activeMode: () => '3D',
    getView: () => ({
      center: { latitude: 0, longitude: 0 },
      altitudeM: 1,
      zoom: 2,
      headingDegrees: 0,
      pitchDegrees: -90,
    }),
    flyTo(target, opts) {
      flights.push({ target, opts });
    },
    select() {},
    setLens() {},
    on: () => () => {},
  };
  // The demo client answers settings.set as the runtime does (demo-client.ts).
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
  return { actions, get: () => state, dispatch, flights };
}

/** An invented aircraft for the store, not data from any source. */
const aircraft: WorldObject = {
  id: 'aircraft:icao24:abc123',
  type: 'aircraft',
  sourceRefs: [],
  position: { latitude: 21.3, longitude: -157.9, altitudeM: 9000 },
  observedAt: ISO,
  updatedAt: ISO,
  freshness: 'LIVE',
  confidence: 0.9,
  labels: {},
  properties: {},
  provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: ISO },
};

test('display actions: V twice in quick succession moves two styles, and each change is saved', async () => {
  const h = await harness();
  assert.equal(displaySettings(h.get().session.settings).visualStyle, 'standard');
  const a = h.actions.cycleVisualStyle(1);
  const b = h.actions.cycleVisualStyle(1);
  await Promise.all([a, b]);
  assert.equal(h.get().session.settings?.display.visualStyle, 'thermal');
  await h.actions.cycleVisualStyle(-1);
  assert.equal(h.get().session.settings?.display.visualStyle, 'night-vision');
  await h.actions.toggleHud();
  await h.actions.toggleDayNight();
  assert.deepEqual(
    { hud: h.get().session.settings?.display.hud, dayNight: h.get().session.settings?.display.dayNight },
    { hud: true, dayNight: true },
  );
  assert.equal(h.get().session.settings?.display.graphics, 'auto', 'the rest of display is left as it was');
});

test('camera actions: orbit is refused with reduced motion; follow takes the selected object only', async () => {
  const h = await harness();
  h.actions.setOrbit(true);
  assert.equal(h.get().ui.orbit, true);
  h.actions.setOrbit(false);
  await h.actions.updateSettings({ reducedMotion: true });
  h.actions.setOrbit(true);
  assert.equal(h.get().ui.orbit, false);
  assert.equal(h.get().ui.notifications[0]?.title, 'Orbit is off', 'and says why');

  h.actions.setFollow(true);
  assert.equal(h.get().ui.followId, null, 'nothing selected');
  h.dispatch({ type: 'world/snapshot', objects: [aircraft], count: 1, subscription: {} });
  h.dispatch({ type: 'world/select', id: aircraft.id, kind: 'object' });
  h.actions.setFollow(true);
  assert.equal(h.get().ui.followId, aircraft.id);
  h.actions.cameraModeEnded({ orbit: false, followId: null });
  assert.equal(h.get().ui.followId, null, 'the renderer let go: so does the state');
});

test('fly to selection: an oblique view on the globe, straight down in 2D', async () => {
  const h = await harness();
  h.dispatch({ type: 'world/snapshot', objects: [aircraft], count: 1, subscription: {} });
  h.dispatch({ type: 'ui/activeMode', mode: '3D' });
  await h.actions.select(aircraft.id, { kind: 'object', fly: true });
  assert.deepEqual(h.flights[0]?.opts, { pitchDegrees: SELECTION_PITCH_DEGREES });
  h.dispatch({ type: 'ui/activeMode', mode: '2D' });
  await h.actions.select(aircraft.id, { kind: 'object', fly: true });
  assert.equal(h.flights[1]?.opts, undefined);
});

test('feature ids for objects, both ways', () => {
  assert.equal(objectFeatureId('aircraft:icao24:abc'), 'obj:aircraft:icao24:abc');
  assert.equal(objectIdOfFeature('obj:aircraft:icao24:abc'), 'aircraft:icao24:abc');
  assert.equal(objectIdOfFeature('event:quake'), null);
});

test('compare imagery: nothing drawn is said, not shown; with overlays the last two are compared; again ends it', async () => {
  const h = await harness();
  h.dispatch({ type: 'sources/overlays', overlays: [] });
  h.actions.toggleImageryCompare();
  assert.equal(h.get().ui.imageryCompare, null);
  assert.match(h.get().ui.notifications.at(-1)?.title ?? '', /No imagery to compare/);
  // Invented overlays in the shape a WMTS connector publishes, not data from GIBS.
  const overlay = (providerId: string) => ({
    kind: 'xyz' as const,
    id: `${providerId}:layer`,
    providerId,
    name: `${providerId} true colour`,
    attribution: 'test',
    url: `https://tiles.example.invalid/${providerId}/{z}/{x}/{y}.jpg`,
  });
  h.dispatch({ type: 'sources/overlays', overlays: [overlay('snpp'), overlay('noaa20')] });
  h.actions.toggleImageryCompare();
  assert.deepEqual(h.get().ui.imageryCompare, { left: 'snpp', right: 'noaa20', position: 0.5 });
  h.actions.setImageryCompare({ left: null, right: 'noaa20', position: 0.3 });
  assert.deepEqual(h.get().ui.imageryCompare, { left: null, right: 'noaa20', position: 0.3 });
  h.actions.toggleImageryCompare();
  assert.equal(h.get().ui.imageryCompare, null);
});
