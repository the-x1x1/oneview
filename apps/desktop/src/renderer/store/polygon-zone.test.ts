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
  assert.equal(zone.geometry.kind, 'polygon');
  const ring = (zone.geometry as { polygon: Array<[number, number]> }).polygon;
  assert.deepEqual(ring[0], [-155.4, 19.3], 'it starts where the shape was started');
  for (const corner of [
    [-155.1, 19.5],
    [-155.0, 19.2],
  ])
    assert.ok(
      ring.some(([lon, lat]) => Math.abs(lon - corner[0]!) < 1e-9 && Math.abs(lat - corner[1]!) < 1e-9),
      `corner ${corner}`,
    );
  assert.ok(ring.length > 3, 'each leg along its great circle, as drawn');
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

test('a zone from a long leg follows the arc the map drew, not the straight line in degrees', async () => {
  const h = await harness();
  await h.actions.createPolygonZone(
    [
      { latitude: 60, longitude: 0 },
      { latitude: 60, longitude: 40 },
      { latitude: 50, longitude: 20 },
    ],
    'Wide',
  );
  const zone = h.get().watchzones.zones.find((z) => z.name === 'Wide')!;
  const ring = (zone.geometry as { polygon: Array<[number, number]> }).polygon;
  // The great circle from 60° N 0° to 60° N 40° E bows north to about 61.5° N at 20° E.
  const top = Math.max(...ring.map(([, lat]) => lat));
  assert.ok(top > 61.3 && top < 61.7, `${top}`);
  assert.ok(ring.length <= 10_000);
});

test('pass alerts: a satellite on and off the list; the options shared by all', async () => {
  const h = await harness();
  const iss = { objectId: 'satellite:norad:25544', name: 'ISS (ZARYA)' };
  await h.actions.setPassAlert(iss, true);
  assert.deepEqual(h.get().session.settings?.passAlerts, {
    satellites: [iss],
    leadMinutes: 10,
    visibleOnly: true,
    desktop: false,
  });
  await h.actions.setPassAlertOptions({ leadMinutes: 5, desktop: true });
  await h.actions.setPassAlert({ objectId: 'satellite:norad:48274', name: 'CSS (TIANHE)' }, true);
  await h.actions.setPassAlert(iss, false);
  assert.deepEqual(h.get().session.settings?.passAlerts, {
    satellites: [{ objectId: 'satellite:norad:48274', name: 'CSS (TIANHE)' }],
    leadMinutes: 5,
    visibleOnly: true,
    desktop: true,
  });
});
