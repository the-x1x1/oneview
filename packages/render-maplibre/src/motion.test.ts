import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, type RenderFeature } from '@worldview/render-core';
import { MotionModel2D, motionStepMs2d } from './motion.js';
import { MapLibreWorldRenderer, movingLayerId } from './renderer.js';
import { createFakeMapLibre, fakeImageCanvasFactory } from './testing/fake-maplibre.js';

const plane = (
  id: string,
  lon: number,
  lat: number,
  motion?: RenderFeature['motion'],
  layer = 'aircraft',
): RenderFeature => ({
  id,
  objectId: id,
  geometry: { kind: 'point', position: { latitude: lat, longitude: lon } },
  style: { styleClass: layer },
  interactive: true,
  priority: 50,
  layer,
  ...(motion ? { motion } : {}),
});
const near = (actual: readonly number[] | undefined, expected: readonly number[], message?: string) =>
  assert.ok(
    actual !== undefined &&
      actual.length === expected.length &&
      actual.every((v, i) => Math.abs(v - expected[i]!) < 1e-9),
    `${message ?? 'position'}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`,
  );
// 0.1° east over 10 s.
const east = (lon: number, lat: number, fromMs = 0) => ({
  to: { latitude: lat, longitude: lon + 0.1 },
  fromMs,
  toMs: fromMs + 10_000,
});

test('MotionModel2D: what is inside the widened view moves; a view holding too many moves nothing', () => {
  const m = new MotionModel2D();
  m.set(plane('a', 0, 0, east(0, 0)));
  m.set(plane('b', 50, 0, east(50, 0)));
  assert.equal(m.set(plane('c', 1, 1)), false, 'no motion: not tracked');
  const view = { west: -5, east: 5, south: -5, north: 5 };
  const first = m.choose(view, 5_000);
  assert.deepEqual(first, { enter: ['a'], leave: [] });
  near(m.position('a', 5_000), [0.05, 0]);
  const moved = m.choose({ west: 45, east: 55, south: -5, north: 5 }, 5_000);
  assert.deepEqual(moved, { enter: ['b'], leave: ['a'] });
  assert.deepEqual(
    m.choose({ west: -60, east: 60, south: -10, north: 10 }, 0, 1),
    { enter: [], leave: ['b'] },
    'over the cap: nothing',
  );
  assert.equal(m.active.size, 0);
  // Across the antimeridian.
  m.set(plane('d', 179.5, 0, east(179.5, 0)));
  assert.deepEqual(m.choose({ west: 170, east: -170, south: -5, north: 5 }, 0).enter, ['d']);
});

test('motionStepMs2d: half a pixel for the fastest mover, within 30 a second and one per 2 s', () => {
  // Zoom 8 at the equator: 40,075 km / (512 × 256) ≈ 306 m a pixel; 250 m/s → 611 ms.
  assert.ok(Math.abs(motionStepMs2d(8, 0, 250) - 611.5) < 1);
  assert.equal(motionStepMs2d(2, 0, 250), 2000);
  assert.ok(Math.abs(motionStepMs2d(18, 0, 250) - 1000 / 30) < 1e-9);
  assert.equal(motionStepMs2d(8, 0, 0), 2000);
});

test('MapLibreWorldRenderer: markers with motion leave their layer and move in a companion source, then go back', async () => {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  let wall = 5_000;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    wallNow: () => wall,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  map.jumpTo({ center: [0, 0], zoom: 6 });
  const runTimers = () => {
    for (const t of timers.splice(0)) t.fn();
    scheduler.flush();
  };
  renderer.update({ upsert: [plane('a', 0, 0, east(0, 0)), plane('s', 0.5, 0.5)], remove: [] });
  scheduler.flush();
  runTimers();
  const main = map.getSource('wv:aircraft')!;
  const moving = map.getSource(`wv:${movingLayerId('aircraft')}`)!;
  assert.ok(moving, 'a companion source was added');
  assert.deepEqual(
    main.data.features.map((f) => f.properties.id),
    ['s'],
    'the moving marker left its layer; the still one stayed',
  );
  near(moving.data.features[0]!.geometry.coordinates as number[], [0.05, 0], 'drawn where it is now');
  assert.ok(map.layers.some((l) => l.id === `wv:${movingLayerId('aircraft')}:circle`));
  assert.equal(timers.length, 1, 'and the next step is booked');
  wall = 7_500;
  runTimers();
  near(moving.data.features[0]!.geometry.coordinates as number[], [0.075, 0]);
  // Paused: the feature comes back without motion, and back to its layer.
  renderer.update({ upsert: [plane('a', 0, 0)], remove: [] });
  scheduler.flush();
  runTimers();
  assert.deepEqual(main.data.features.map((f) => f.properties.id).sort(), ['a', 's']);
  assert.equal(moving.data.features.length, 0, 'nothing left moving');
  assert.equal(timers.length, 0, 'and no more steps');
  renderer.dispose();
});

test('MapLibreWorldRenderer: a marker that stops moving because the view left it goes back where it had got to', async () => {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  let wall = 5_000;
  const timers: Array<() => void> = [];
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    wallNow: () => wall,
    setTimer: (fn) => (timers.push(fn), fn),
    clearTimer: (h) => {
      const i = timers.indexOf(h as () => void);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  map.jumpTo({ center: [0, 0], zoom: 6 });
  const run = () => {
    for (const t of timers.splice(0)) t();
    scheduler.flush();
  };
  renderer.update({ upsert: [plane('a', 0, 0, east(0, 0))], remove: [] });
  scheduler.flush();
  run();
  wall = 10_000;
  map.jumpTo({ center: [90, 0], zoom: 6 });
  run();
  const main = map.getSource('wv:aircraft')!;
  assert.equal(main.data.features.length, 1);
  near(main.data.features[0]!.geometry.coordinates as number[], [0.1, 0], 'released at its moved position');
  renderer.dispose();
});
