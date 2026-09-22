import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttleLatest, type ThrottleClock } from './throttle.js';

function manualClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const clock: ThrottleClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  return { clock, advance, pending: () => timers.length };
}

test('throttleLatest: a sixty-frame pan becomes a handful of updates, ending on the last view', () => {
  // The shell used to dispatch every camera frame into application state, re-rendering the
  // whole shell and re-running presentation each time. The first value goes straight
  // through (a click-and-hold should feel immediate), the rest collapse, and the final
  // position is always delivered — a throttle that dropped the last frame would leave the
  // app believing the camera stopped somewhere it did not.
  const { clock, advance } = manualClock();
  const seen: number[] = [];
  const t = throttleLatest<number>(250, (v) => seen.push(v), clock);
  for (let frame = 0; frame < 60; frame++) {
    t.call(frame);
    advance(16);
  }
  advance(1000);
  assert.equal(seen[0], 0, 'the first frame is not delayed');
  assert.equal(seen.at(-1), 59, 'the last frame is never dropped');
  assert.ok(seen.length <= 6, `about four a second over one second of motion, got ${seen.length}`);
});

test('throttleLatest: flush delivers now, cancel delivers nothing', () => {
  const { clock, advance, pending } = manualClock();
  const seen: string[] = [];
  const t = throttleLatest<string>(250, (v) => seen.push(v), clock);
  t.call('a');
  t.call('b');
  t.flush();
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(pending(), 0, 'flushing clears the timer');
  advance(10);
  t.call('c');
  t.cancel();
  advance(1000);
  assert.deepEqual(seen, ['a', 'b'], 'a cancelled value never arrives — unmount must not dispatch');
});
