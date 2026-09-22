import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canScrub,
  clampToAvailability,
  formatCursor,
  fractionToMs,
  initialTimelineState,
  mergedAvailability,
  msToFraction,
  timelineReducer,
  type TimelineControlState,
} from './timeline-reducer.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');
const H = 3600_000;

function withHistory(state: TimelineControlState): TimelineControlState {
  return {
    ...state,
    availability: [
      { objectType: 'earthquake', ranges: [{ startMs: NOW - 24 * H, endMs: NOW }] },
      { objectType: 'aircraft', ranges: [{ startMs: NOW - 2 * H, endMs: NOW - H }] },
    ],
  };
}

test('mergedAvailability merges overlapping windows in order', () => {
  const merged = mergedAvailability([
    {
      objectType: 'a',
      ranges: [
        { startMs: 10, endMs: 20 },
        { startMs: 40, endMs: 50 },
      ],
    },
    { objectType: 'b', ranges: [{ startMs: 15, endMs: 30 }] },
  ]);
  assert.deepEqual(merged, [
    { startMs: 10, endMs: 30 },
    { startMs: 40, endMs: 50 },
  ]);
});

test('scrubbing is impossible without availability — never pretend history exists', () => {
  const s0 = initialTimelineState(NOW);
  assert.equal(canScrub(s0), false);
  const s1 = timelineReducer(s0, { type: 'scrubStart' });
  assert.equal(s1.scrubbing, false);
  const s2 = timelineReducer(s1, { type: 'scrubTo', ms: NOW - H });
  assert.equal(s2.cursorMs, NOW);
  assert.equal(s2.mode, 'LIVE');
  assert.deepEqual(clampToAvailability(NOW - H, [], NOW), { ms: NOW, snapped: true });
});

test('scrub snaps to the nearest availability window and sets HISTORICAL', () => {
  const s0 = withHistory(initialTimelineState(NOW));
  assert.equal(canScrub(s0), true);
  let s = timelineReducer(s0, { type: 'scrubStart' });
  assert.equal(s.scrubbing, true);
  s = timelineReducer(s, { type: 'scrubTo', ms: NOW - 30 * H }); // before any window → snaps to earliest
  assert.equal(s.cursorMs, NOW - 24 * H);
  s = timelineReducer(s, { type: 'scrubTo', ms: NOW - 3 * H });
  assert.equal(s.cursorMs, NOW - 3 * H);
  s = timelineReducer(s, { type: 'scrubEnd' });
  assert.equal(s.scrubbing, false);
  assert.equal(s.mode, 'HISTORICAL');
  // future is clamped to now
  const fut = timelineReducer(s, { type: 'scrubTo', ms: NOW + H });
  assert.equal(fut.cursorMs, NOW);
  assert.equal(fut.mode, 'LIVE');
});

test('play from HISTORICAL enters REPLAY, advances at speed, and returns to LIVE at now', () => {
  let s = withHistory(initialTimelineState(NOW));
  s = timelineReducer(s, { type: 'scrubTo', ms: NOW - 10 * 60_000 });
  assert.equal(s.mode, 'HISTORICAL');
  s = timelineReducer(s, { type: 'setSpeed', speed: 60 });
  s = timelineReducer(s, { type: 'play' });
  assert.equal(s.mode, 'REPLAY');
  s = timelineReducer(s, { type: 'tick', nowMs: NOW + 5000 }); // 5 s wall → 300 s replay
  assert.equal(s.cursorMs, NOW - 10 * 60_000 + 300_000);
  assert.equal(s.mode, 'REPLAY');
  s = timelineReducer(s, { type: 'tick', nowMs: NOW + 20_000 });
  assert.equal(s.mode, 'LIVE');
  assert.equal(s.cursorMs, NOW + 20_000);
  // range end follows now while live-anchored
  assert.equal(s.range.endMs, NOW + 20_000);
});

test('pause holds the cursor; togglePlay and jumpToLive', () => {
  let s = withHistory(initialTimelineState(NOW));
  s = timelineReducer(s, { type: 'pause' });
  assert.equal(s.mode, 'PAUSED');
  s = timelineReducer(s, { type: 'tick', nowMs: NOW + 10_000 });
  assert.equal(s.cursorMs, NOW);
  s = timelineReducer(s, { type: 'togglePlay' });
  assert.equal(s.mode, 'REPLAY');
  s = timelineReducer(s, { type: 'jumpToLive' });
  assert.equal(s.mode, 'LIVE');
  assert.equal(s.cursorMs, NOW + 10_000);
  const invalidSpeed = timelineReducer(s, { type: 'setSpeed', speed: 7 as unknown as 5 });
  assert.equal(invalidSpeed.speed, 1);
});

test('sync from the runtime replaces mode/cursor/range and clamps to now', () => {
  const s = timelineReducer(initialTimelineState(NOW), {
    type: 'sync',
    mode: 'HISTORICAL',
    cursorMs: NOW + 99,
    speed: 5,
    range: { startMs: NOW - H, endMs: NOW },
    availability: [{ objectType: 'earthquake', ranges: [{ startMs: NOW - H, endMs: NOW }] }],
    nowMs: NOW,
  });
  assert.equal(s.cursorMs, NOW);
  assert.equal(s.speed, 5);
  assert.equal(canScrub(s), true);
});

test('fraction helpers and cursor formatting', () => {
  const range = { startMs: 0, endMs: 1000 };
  assert.equal(fractionToMs(0.5, range), 500);
  assert.equal(fractionToMs(2, range), 1000);
  assert.equal(msToFraction(250, range), 0.25);
  assert.equal(msToFraction(5, { startMs: 5, endMs: 5 }), 1);
  assert.equal(formatCursor(NOW, NOW), '08:00:00 UTC');
  assert.equal(formatCursor(NOW - 24 * H, NOW), '2026-09-20 08:00:00 UTC');
});
