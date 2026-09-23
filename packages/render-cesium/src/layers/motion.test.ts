import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Movers, motionStepMs } from './motion.js';

test('a moving marker is placed by wall-clock time along its step, held before it, carried one step past it at most', () => {
  let now = 1_000;
  const movers = new Movers(() => now);
  let at = { x: NaN, y: NaN, z: NaN };
  let shown = true;
  movers.set(
    'p:sat',
    { place: (p) => (at = { ...p }), shown: () => shown, from: { x: 0, y: 0, z: 0 }, to: { x: 100, y: 0, z: 10 } },
    { fromMs: 1_000, toMs: 16_000 },
  );
  assert.deepEqual(at, { x: 0, y: 0, z: 0 }, 'placed at once, at where it is now');
  assert.equal(movers.step(8_500), 1);
  assert.deepEqual(at, { x: 50, y: 0, z: 5 }, 'halfway through the step');
  movers.step(0);
  assert.deepEqual(at, { x: 0, y: 0, z: 0 }, 'before the step: held at its start');
  movers.step(23_500);
  assert.deepEqual(at, { x: 150, y: 0, z: 15 }, 'the next poll is late: carried on');
  movers.step(1_000_000);
  assert.deepEqual(at, { x: 200, y: 0, z: 20 }, 'but one step past at most');
  shown = false;
  assert.equal(movers.step(8_500), 0, 'a marker the Earth hides is not moved');
  movers.delete('p:sat');
  assert.equal(movers.size, 0);
  now = 0;
});

test('motion is stepped as often as the zoom makes a step visible, within 30 per second and one per 2 s', () => {
  assert.equal(motionStepMs(40_000), 2000, 'the whole globe: a satellite crosses a pixel in seconds');
  assert.ok(Math.abs(motionStepMs(1_500) - 100) < 1e-9, '1.5 km a pixel: every 100 ms');
  assert.ok(Math.abs(motionStepMs(10) - 1000 / 30) < 1e-9, 'close in: 30 a second, no more');
  assert.ok(Math.abs(motionStepMs(NaN) - 1000 / 30) < 1e-9);
});
