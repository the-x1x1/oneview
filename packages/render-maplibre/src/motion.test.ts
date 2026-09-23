import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RenderFeature } from '@worldview/render-core';
import { inView, motionStepMs2d, moverInView, moverOf, positionAt, type Mover } from './motion.js';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test('a moving point goes along the great circle by wall-clock time, holds before, carries one step past', () => {
  const m: Mover = { from: [10, 0], to: [11, 0], fromMs: 1000, toMs: 16_000 };
  assert.deepEqual(positionAt(m, 0), [10, 0], 'before the first end: held there');
  const half = positionAt(m, 8500);
  assert.ok(near(half[0], 10.5, 1e-4) && near(half[1], 0), JSON.stringify(half));
  const late = positionAt(m, 31_000);
  assert.ok(near(late[0], 12, 1e-3), 'one step past the second end');
  assert.deepEqual(positionAt(m, 1e9), late, 'and no further');
  // Across the antimeridian: 179.5 → -179.5 passes 180, not back through 0.
  const wrap = positionAt({ from: [179.5, 10], to: [-179.5, 10], fromMs: 0, toMs: 10 }, 5);
  assert.ok(near(Math.abs(wrap[0]), 180, 1e-3), JSON.stringify(wrap));
  // Over the pole: a polar orbit's step from 89°N on one side to 89°N on the other.
  const pole = positionAt({ from: [0, 89], to: [180, 89], fromMs: 0, toMs: 10 }, 5);
  assert.ok(near(pole[1], 90, 1e-3), JSON.stringify(pole));
});

test('only features with a forward motion move', () => {
  const f = (motion?: RenderFeature['motion'], kind: 'point' | 'line' = 'point'): RenderFeature => ({
    id: 's',
    geometry:
      kind === 'point' ? { kind: 'point', position: { latitude: 1, longitude: 2 } } : { kind: 'line', positions: [] },
    style: { styleClass: 'satellite' },
    interactive: true,
    priority: 1,
    layer: 'satellite',
    ...(motion ? { motion } : {}),
  });
  const to = { latitude: 1.5, longitude: 2.5 };
  assert.deepEqual(moverOf(f({ to, fromMs: 0, toMs: 15_000 })), {
    from: [2, 1],
    to: [2.5, 1.5],
    fromMs: 0,
    toMs: 15_000,
  });
  assert.equal(moverOf(f()), undefined);
  assert.equal(moverOf(f({ to, fromMs: 10, toMs: 10 })), undefined);
  assert.equal(moverOf(f({ to, fromMs: 0, toMs: 1 }, 'line')), undefined);
});

test('the step interval follows how far a pixel is: 2 s over the world, 5 Hz close in', () => {
  assert.equal(motionStepMs2d(1, 0), 2000);
  assert.ok(near(motionStepMs2d(4, 0), (0.5 * 40_075_016.686) / (512 * 16) / 7.5, 1e-6), 'zoom 4: ~326 ms');
  assert.equal(motionStepMs2d(10, 0), 200);
  assert.ok(motionStepMs2d(4, 60) < motionStepMs2d(4, 0), 'a pixel covers less toward the poles');
});

test('in view: a tenth of margin, bounds past ±180, a step straight across the view', () => {
  const b = { west: 170, south: -10, east: 190, north: 10 };
  assert.ok(inView(-175, 0, b), '-175 is 185 in bounds that run past 180');
  assert.ok(inView(168.5, 0, b), 'inside the margin');
  assert.ok(!inView(160, 0, b));
  assert.ok(!inView(175, 13, b));
  assert.ok(inView(0, 0, { west: -200, south: -80, east: 200, north: 80 }), 'the whole world');
  const small = { west: 0, south: 0, east: 1, north: 1 };
  assert.ok(moverInView({ from: [-1, 0.5], to: [2, 0.5], fromMs: 0, toMs: 1 }, small), 'across');
  assert.ok(!moverInView({ from: [-3, 5], to: [-2, 6], fromMs: 0, toMs: 1 }, small));
});
