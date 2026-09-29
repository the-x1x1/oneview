import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewState } from '@worldview/render-core';
import { describeHome, homeFlyTarget, homeFromView, shouldFlyHomeAtStart } from './home.js';
import { initialState, rootReducer } from './reducer.js';

const view = (over: Partial<ViewState> = {}): ViewState => ({
  center: { latitude: 21.30694444, longitude: -157.85833333 },
  altitudeM: 12_345.6,
  zoom: 11.234,
  headingDegrees: 30,
  pitchDegrees: -40,
  ...over,
});

test('home view: the ground in the middle of the view, with the altitude and zoom, rounded', () => {
  assert.deepEqual(homeFromView(view()), {
    latitude: 21.306944,
    longitude: -157.858333,
    altitudeM: 12_346,
    zoom: 11.23,
  });
  // Tilted on the globe the middle of the view is not under the camera: the middle is kept.
  const tilted = homeFromView(view({ focus: { latitude: 21.4, longitude: -157.7 } }));
  assert.equal(tilted.latitude, 21.4);
  // MapLibre reports an unwrapped longitude after crossing the antimeridian.
  assert.equal(homeFromView(view({ center: { latitude: 0, longitude: 190 } })).longitude, -170);
  assert.deepEqual(homeFlyTarget(homeFromView(view())), {
    position: { latitude: 21.306944, longitude: -157.858333 },
    altitudeM: 12_346,
    zoom: 11.23,
  });
  assert.equal(describeHome(homeFromView(view())), '21.3069° N, 157.8583° W · 12 km up');
  assert.equal(
    describeHome({ latitude: -33.9, longitude: 18.4, altitudeM: 900, zoom: 15 }),
    '33.9000° S, 18.4000° E · 900 m up',
  );
});

test('home view: flown to at start only when asked for, set, after the first frame, and once', () => {
  const home = { view: { latitude: 1, longitude: 2, altitudeM: 1000, zoom: 12 }, flyOnStart: true };
  assert.equal(shouldFlyHomeAtStart(home, true, false), true);
  assert.equal(shouldFlyHomeAtStart(home, false, false), false, 'not before the map has drawn');
  assert.equal(shouldFlyHomeAtStart(home, true, true), false, 'once');
  assert.equal(shouldFlyHomeAtStart({ ...home, flyOnStart: false }, true, false), false, 'off by default');
  assert.equal(shouldFlyHomeAtStart({ view: null, flyOnStart: true }, true, false), false, 'nothing set');
  assert.equal(shouldFlyHomeAtStart(undefined, true, false), false);
});

test('first frame: recorded once in the UI state', () => {
  const s = initialState(0);
  assert.equal(s.ui.firstFrame, false);
  const next = rootReducer(s, { type: 'ui/firstFrame' });
  assert.equal(next.ui.firstFrame, true);
  assert.equal(rootReducer(next, { type: 'ui/firstFrame' }), next, 'no new state the second time');
});
