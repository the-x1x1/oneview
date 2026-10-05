import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoClient } from '../demo/demo-client.js';
import type { RendererHostLike } from '../renderer-host-like.js';
import { loadInitialState } from './bootstrap-state.js';
import { createActions } from './actions.js';
import { rootReducer } from './reducer.js';
import type { RootAction, RootState } from './types.js';

const T0 = Date.parse('2026-10-05T18:00:00.000Z');

async function harness() {
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
    flyTo() {},
    select() {},
    setLens() {},
    on: () => () => {},
  };
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

test('the measured shape becomes a watch zone with that outline; one across 180° is refused', async () => {
  const h = await harness();
  const before = h.get().watchzones.zones.length;
  const ok = await h.actions.createPolygonZone(
    [
      { latitude: 19.3, longitude: -155.4 },
      { latitude: 19.5, longitude: -155.1 },
      { latitude: 19.2, longitude: -155.0 },
    ],
    'Area of 512.3 km²',
  );
  assert.equal(ok, true);
  const zones = h.get().watchzones.zones;
  assert.equal(zones.length, before + 1);
  const zone = zones.find((z) => z.name === 'Area of 512.3 km²')!;
  assert.deepEqual(zone.geometry, {
    kind: 'polygon',
    polygon: [
      [-155.4, 19.3],
      [-155.1, 19.5],
      [-155.0, 19.2],
    ],
  });
  assert.equal(h.get().ui.contextTab, 'watchzones');
  const across = await h.actions.createPolygonZone(
    [
      { latitude: -17, longitude: 179.5 },
      { latitude: -17.5, longitude: -179.5 },
      { latitude: -18, longitude: 179.8 },
    ],
    'Fiji',
  );
  assert.equal(across, false);
  assert.equal(h.get().watchzones.zones.length, before + 1, 'nothing saved');
  assert.ok(h.get().ui.notifications.some((n) => /180° meridian/.test(n.body)));
});
