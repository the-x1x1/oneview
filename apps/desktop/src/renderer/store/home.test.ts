import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewState } from '@worldview/render-core';
import { describeHome, homeFlyOptions, homeFlyTarget, homeFromView, shouldFlyHomeAtStart } from './home.js';
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
    pitchDegrees: -40,
    headingDegrees: 30,
  });
  // Tilted on the globe the middle of the view is not under the camera: the middle is kept.
  const tilted = homeFromView(view({ focus: { latitude: 21.4, longitude: -157.7 } }));
  assert.equal(tilted.latitude, 21.4);
  // MapLibre reports an unwrapped longitude after crossing the antimeridian.
  assert.equal(homeFromView(view({ center: { latitude: 0, longitude: 190 } })).longitude, -170);
  const above = view({ pitchDegrees: -90, headingDegrees: 0 });
  assert.deepEqual(homeFlyTarget(homeFromView(above)), {
    position: { latitude: 21.306944, longitude: -157.858333 },
    altitudeM: 12_346,
    zoom: 11.23,
  });
  assert.equal(describeHome(homeFromView(above)), '21.3069° N, 157.8583° W · 12 km up');
  assert.equal(describeHome(homeFromView(view())), '21.3069° N, 157.8583° W · 12 km up · tilted 50°, facing 30°');
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

test('home view: a tilt and a heading are kept and flown back to; from above facing north they are not stored', () => {
  const tilted = homeFromView(view({ pitchDegrees: -30, headingDegrees: 275.44 }));
  assert.equal(tilted.pitchDegrees, -30);
  assert.equal(tilted.headingDegrees, 275.4);
  // The camera ends at the height it was set from: the distance along the line of sight is
  // the altitude over the sine of the tilt (sin 30° = 0.5).
  assert.equal(homeFlyTarget(tilted).altitudeM, 24_692);
  assert.deepEqual(homeFlyOptions(tilted), { pitchDegrees: -30, headingDegrees: 275.4 });
  // Straight down, facing north: nothing extra, and it arrives from above facing north.
  const flat = homeFromView(view({ pitchDegrees: -89.5, headingDegrees: 359.8 }));
  assert.equal(flat.pitchDegrees, undefined);
  assert.equal(flat.headingDegrees, undefined);
  assert.deepEqual(homeFlyOptions(flat), { headingDegrees: 0 });
  // A home saved by an earlier version (no tilt, no heading) comes back the old way.
  assert.deepEqual(homeFlyOptions({ latitude: 1, longitude: 2, altitudeM: 3, zoom: 4 }), { headingDegrees: 0 });
  // Facing north but tilted: the tilt alone.
  assert.equal(homeFromView(view({ pitchDegrees: -45, headingDegrees: 0.2 })).headingDegrees, undefined);
});
