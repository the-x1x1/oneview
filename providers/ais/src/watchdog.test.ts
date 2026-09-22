import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AisWatchdog } from './watchdog.js';

const T0 = Date.parse('2026-09-21T08:00:00.000Z');

test('watchdog: connect is issued once, handshake is not liveness, data is', () => {
  const w = new AisWatchdog();
  assert.deepEqual(w.tick(T0), [{ type: 'connect', generation: 1 }]);
  assert.deepEqual(w.tick(T0 + 1000), [], 'no second connect while a socket is owned');
  assert.equal(w.currentStatus, 'connecting');
  assert.deepEqual(w.onOpen(1), []);
  assert.equal(w.currentStatus, 'connecting', 'open does not make the feed live');
  assert.deepEqual(w.onMessage(1, T0 + 2000), []);
  assert.equal(w.currentStatus, 'live');
  assert.equal(w.snapshot(T0 + 2500).silentForMs, 500);
});

test('watchdog: silence beyond the budget recycles the socket and walks the ladder', () => {
  const w = new AisWatchdog({ silenceMs: 90_000, backoffMs: [5000, 15_000] });
  w.tick(T0);
  w.onMessage(1, T0);
  assert.deepEqual(w.tick(T0 + 89_999), []);
  assert.deepEqual(w.tick(T0 + 90_000), [{ type: 'terminate', generation: 1, reason: 'silent' }]);
  assert.equal(w.currentStatus, 'reconnecting');
  assert.match(w.snapshot(T0 + 90_000).error ?? '', /no AIS data for 90 s/);
  assert.equal(w.snapshot(T0 + 90_000).nextAttemptAt, T0 + 95_000);
  assert.deepEqual(w.tick(T0 + 94_000), [], 'before the backoff elapses');
  assert.deepEqual(w.tick(T0 + 95_000), [{ type: 'connect', generation: 2 }]);
  // Second silent session → second rung; third → ladder exhausted → down.
  assert.deepEqual(w.tick(T0 + 185_000), [{ type: 'terminate', generation: 2, reason: 'silent' }]);
  assert.equal(w.snapshot(T0 + 185_000).nextAttemptAt, T0 + 200_000);
  w.tick(T0 + 200_000);
  w.tick(T0 + 290_000);
  assert.equal(w.currentStatus, 'down');
  assert.equal(w.snapshot(T0 + 290_000).nextAttemptAt, T0 + 290_000 + 900_000);
  // Data on the next attempt resets the ladder.
  w.tick(T0 + 1_190_000);
  w.onMessage(4, T0 + 1_190_001);
  assert.equal(w.currentStatus, 'live');
  assert.equal(w.snapshot(T0 + 1_190_001).attempt, 0);
});

test('watchdog: close and transport failures schedule by the ladder; orphans are terminated and ignored', () => {
  const w = new AisWatchdog({ backoffMs: [5000, 15_000, 60_000] });
  w.tick(T0);
  assert.deepEqual(w.onClose(1, T0 + 100), []);
  assert.equal(w.currentStatus, 'reconnecting');
  assert.equal(w.snapshot(T0 + 100).nextAttemptAt, T0 + 5100);
  assert.deepEqual(w.tick(T0 + 5100), [{ type: 'connect', generation: 2 }]);
  assert.deepEqual(w.onFailure(2, T0 + 5200, { kind: 'transport', message: 'ECONNRESET' }), [
    { type: 'terminate', generation: 2, reason: 'transport' },
  ]);
  assert.equal(w.snapshot(T0 + 5200).error, 'ECONNRESET');
  assert.equal(w.snapshot(T0 + 5200).nextAttemptAt, T0 + 20_200);
  // Late events from generation 1 or 2 must not touch the schedule.
  assert.deepEqual(w.onOpen(1), [{ type: 'terminate', generation: 1, reason: 'orphan' }]);
  assert.deepEqual(w.onMessage(2, T0 + 6000), [{ type: 'terminate', generation: 2, reason: 'orphan' }]);
  assert.deepEqual(w.onClose(1, T0 + 6000), []);
  assert.equal(w.snapshot(T0 + 6000).nextAttemptAt, T0 + 20_200);
});

test('watchdog: auth rejection is sticky until the credential changes', () => {
  const w = new AisWatchdog({ authProbeMs: 3_600_000 });
  w.tick(T0);
  assert.deepEqual(w.onFailure(1, T0 + 10, { kind: 'auth' }), [{ type: 'terminate', generation: 1, reason: 'auth' }]);
  assert.equal(w.currentStatus, 'auth-failed');
  assert.equal(w.snapshot(T0 + 10).nextAttemptAt, T0 + 10 + 3_600_000);
  assert.deepEqual(w.tick(T0 + 60_000), [], 'no fast retry on a refused key');
  // A probe that dies for a transport reason stays on the auth cadence.
  w.tick(T0 + 10 + 3_600_000);
  w.onClose(2, T0 + 20 + 3_600_000);
  assert.equal(w.currentStatus, 'auth-failed');
  assert.equal(w.snapshot(T0 + 20 + 3_600_000).nextAttemptAt, T0 + 20 + 7_200_000);
  // Credential rotation clears the terminal state immediately.
  assert.deepEqual(w.onCredentialChange(T0 + 100_000), []);
  assert.equal(w.currentStatus, 'idle');
  assert.deepEqual(w.tick(T0 + 100_000), [{ type: 'connect', generation: 3 }]);
});

test('watchdog: rate limit honours retry-after and never re-enters the fast rungs', () => {
  const w = new AisWatchdog({ backoffMs: [5000, 15_000], downRetryMs: 900_000 });
  w.tick(T0);
  w.onFailure(1, T0, { kind: 'rate-limit', retryAfterMs: 120_000 });
  assert.equal(w.currentStatus, 'reconnecting');
  assert.equal(w.snapshot(T0).nextAttemptAt, T0 + 120_000);
  w.tick(T0 + 120_000);
  w.onClose(2, T0 + 120_001);
  assert.equal(w.currentStatus, 'down', 'the ladder is spent after a rate limit');
  assert.equal(w.snapshot(T0 + 120_001).nextAttemptAt, T0 + 120_001 + 900_000);
});

test('watchdog: reset releases the socket but keeps the generation counter monotonic', () => {
  const w = new AisWatchdog({}, 7);
  assert.deepEqual(w.tick(T0), [{ type: 'connect', generation: 8 }]);
  assert.deepEqual(w.reset(), [{ type: 'terminate', generation: 8, reason: 'dispose' }]);
  assert.equal(w.currentStatus, 'idle');
  assert.equal(w.snapshot(T0).nextAttemptAt, undefined);
  assert.deepEqual(w.tick(T0), [{ type: 'connect', generation: 9 }]);
});
