import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hudClock } from './hud.js';

test('the HUD clock is the time of what the map shows', () => {
  const now = Date.parse('2026-10-04T06:14:27Z');
  const shown = Date.parse('2026-10-04T06:14:14Z');
  assert.deepEqual(hudClock(now, 'LIVE', shown), { atMs: now });
  assert.deepEqual(hudClock(now, undefined, shown), { atMs: now });
  assert.deepEqual(hudClock(now, 'PAUSED', shown), { atMs: shown, tag: 'PAUSED' });
  assert.deepEqual(hudClock(now, 'HISTORICAL', shown - 3_600_000), { atMs: shown - 3_600_000, tag: 'HISTORICAL' });
  assert.deepEqual(hudClock(now, 'REPLAY', Number.NaN), { atMs: now }, 'no moment known: now');
});
