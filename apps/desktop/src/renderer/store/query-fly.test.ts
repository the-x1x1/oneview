import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { DemoClient } from '../demo/demo-client.js';
import { createActions } from './actions.js';
import { loadInitialState } from './bootstrap-state.js';
import { rootReducer } from './reducer.js';
import type { RootAction, RootState } from './types.js';
import type { RendererHostLike } from '../renderer-host-like.js';

const T0 = Date.parse('2026-10-04T06:00:00Z');
const ISO = new Date(T0).toISOString();

/** An invented earthquake far from the view, not data from any source. */
const quake: WorldObject = {
  id: 'earthquake:test:far',
  type: 'earthquake',
  sourceRefs: [],
  position: { latitude: -27.5, longitude: -179.5 },
  observedAt: ISO,
  updatedAt: ISO,
  freshness: 'RECENT',
  confidence: 0.9,
  labels: { title: 'M 4.5 - test' },
  properties: { magnitude: 4.5 },
} as unknown as WorldObject;

test('a query with one match flies to it, though the view does not hold it', async () => {
  const flights: unknown[] = [];
  const host = {
    mount() {},
    unmount() {},
    setMode() {},
    activeMode: () => '3D',
    getView: () => ({
      center: { latitude: 50, longitude: 8.5 },
      altitudeM: 6000,
      zoom: 12,
      headingDegrees: 0,
      pitchDegrees: -36,
    }),
    flyTo(target: unknown) {
      flights.push(target);
    },
    select() {},
    setLens() {},
    on: () => () => {},
  } as unknown as RendererHostLike;
  const demo = new DemoClient({ now: () => T0 });
  const client = new Proxy(demo, {
    get(target, prop, receiver) {
      if (prop !== 'request') return Reflect.get(target, prop, receiver);
      return async (method: string, params: unknown) => {
        if (method === 'world.query') return { items: [quake], total: 1 };
        if (method === 'world.get') return quake;
        if (method === 'world.track') return [];
        if (method === 'world.related') return { objects: [], events: [] };
        return (target.request as (m: string, p: unknown) => Promise<unknown>)(method, params);
      };
    },
  });
  let state: RootState = await loadInitialState(demo, () => T0);
  const dispatch = (action: RootAction) => {
    state = rootReducer(state, action);
  };
  const actions = createActions({
    client: client as typeof demo,
    dispatch,
    getState: () => state,
    hosts: { get: () => host, set: () => {} },
    now: () => T0,
  });
  await actions.goTo({
    kind: 'query',
    id: 'query:1',
    title: 'Earthquakes near Tonga',
    query: { objectTypes: ['earthquake'] },
  } as never);
  assert.equal(state.world.selectedId, quake.id);
  assert.equal(flights.length, 1, 'flew to the one match');
});
