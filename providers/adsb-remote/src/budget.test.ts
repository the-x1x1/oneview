import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CEILING_APPROACH,
  INCREASE_PER_SUCCESS,
  MAX_DEBT,
  MAX_PER_MIN,
  MIN_PER_MIN,
  RequestBudget,
  START_PER_MIN,
} from './budget.js';

/** Polls every `stepMs` for `durationMs`; returns when each poll was allowed to send. */
function drive(b: RequestBudget, fromMs: number, durationMs: number, stepMs = 10_000): number[] {
  const sent: number[] = [];
  for (let t = fromMs; t < fromMs + durationMs; t += stepMs)
    if (b.mayPoll(t)) {
      b.sending(t);
      b.answered(t);
      sent.push(t);
    }
  return sent;
}

test('RequestBudget: starts below the rate that drew 429s and creeps up to one request a poll while clean', () => {
  const b = new RequestBudget();
  assert.equal(b.perMinute, START_PER_MIN);
  const first = drive(b, 0, 60_000);
  assert.ok(first.length <= START_PER_MIN + 1, `first minute: ${first.length} requests`);
  drive(b, 60_000, 10 * 60_000);
  assert.equal(b.perMinute, MAX_PER_MIN, 'ten clean minutes later: the cap');
  const later = drive(b, 11 * 60_000, 60_000);
  assert.equal(later.length, 6, 'one request each ten-second poll, never more');
  assert.equal(b.summary(11 * 60_000).rateLimited, 0);
});

test('RequestBudget: a 429 halves the rate and nothing goes before its Retry-After; the repeated status during the wait is not a second decrease', () => {
  const b = new RequestBudget({ startPerMin: 6 });
  assert.ok(b.mayPoll(0));
  b.sending(0);
  b.refused(1_000, true, 30_000);
  assert.equal(b.perMinute, 3);
  assert.equal(b.summary(1_000).waitMs, 30_000);
  assert.equal(b.summary(1_000).rateLimited, 1);
  for (let t = 1_000; t < 31_000; t += 5_000) assert.equal(b.mayPoll(t), false, `held back at ${t}`);
  // The host answers requests made during its own Retry-After with the same status: not a new limit.
  b.refused(10_000, true, 21_000);
  assert.equal(b.perMinute, 3, 'still 3');
  assert.equal(b.summary(10_000).rateLimited, 1);
  // The host's pacing (no 429 status) only moves the wait.
  b.refused(20_000, false, 15_000);
  assert.equal(b.perMinute, 3);
  assert.equal(b.summary(20_000).waitMs, 15_000);
  // After the wait the bucket has to refill from empty: 20 s a token at 3 a minute.
  assert.equal(b.mayPoll(35_000), true);
  // Never below the floor, however many 429s.
  const c = new RequestBudget({ startPerMin: 1 });
  for (let i = 0; i < 5; i++) c.refused(i * 1_000_000, true, 1_000);
  assert.equal(c.perMinute, MIN_PER_MIN);
  // No Retry-After: the host's 45 s.
  const d = new RequestBudget();
  d.refused(0, true, undefined);
  assert.equal(d.summary(0).waitMs, 45_000);
});

test('RequestBudget: after a 429 it climbs back quickly to 80 % of the rate that met the limit, then slowly', () => {
  const b = new RequestBudget({ startPerMin: 6 });
  b.refused(0, true, 0);
  assert.equal(b.perMinute, 3);
  let n = 0;
  while (b.perMinute < 6 * CEILING_APPROACH) {
    b.answered(1_000 + n);
    n++;
  }
  assert.equal(n, Math.ceil((6 * CEILING_APPROACH - 3) / INCREASE_PER_SUCCESS), 'the fast part');
  const at = b.perMinute;
  for (let i = 0; i < 10; i++) b.answered(2_000 + i);
  assert.ok(b.perMinute - at < 10 * INCREASE_PER_SUCCESS * 0.2, `slow near the limit: ${at} → ${b.perMinute}`);
  // Half an hour on the limit is forgotten and the normal pace resumes.
  const before = b.perMinute;
  b.answered(31 * 60_000);
  assert.equal(b.perMinute, Math.min(MAX_PER_MIN, before + INCREASE_PER_SUCCESS));
});

test('RequestBudget: a foreground lookup goes at once, the polls wait while it runs and then pay back what it borrowed', () => {
  const b = new RequestBudget({ startPerMin: 6 });
  assert.ok(b.mayPoll(0));
  b.sending(0); // a poll just took the only token
  b.beginForeground();
  b.sending(1_000); // the route lookup goes anyway, into debt
  assert.equal(b.mayPoll(5_000), false, 'no poll while the lookup (or its retry wait) is in progress');
  b.endForeground();
  // The lookup borrowed the next poll's token (-0.9 after it): that poll asks nothing, the one after does.
  assert.equal(b.mayPoll(10_000), false);
  assert.equal(b.mayPoll(20_000), true);
  // Debt is bounded: a burst of lookups never silences the polls for long.
  const c = new RequestBudget({ startPerMin: 6 });
  for (let i = 0; i < 10; i++) c.sending(0);
  assert.equal(c.mayPoll(25_000), false);
  assert.equal(c.mayPoll((1 - MAX_DEBT) * 10_000), true, 'three tokens at six a minute: 30 s');
  // Disabled (the contract checklist): every poll may send.
  const off = new RequestBudget({ enabled: false });
  for (let i = 0; i < 5; i++) assert.equal(off.mayPoll(0), true);
});

/**
 * A stand-in for adsb.lol's limiter, invented for this test: a token bucket of `perMin` a
 * minute holding at most `burst`. Its real shape and numbers are unpublished ("dynamic based
 * on the environment load"); what matters here is that the budget finds whatever it is.
 */
function server(perMin: number, burst: number) {
  let tokens = burst;
  let at = 0;
  return (t: number): boolean => {
    tokens = Math.min(burst, tokens + ((t - at) * perMin) / 60_000);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function simulate(allow: (t: number) => boolean, paced: boolean, minutes: number) {
  const b = new RequestBudget({ enabled: paced });
  let sent = 0;
  let limited = 0;
  let blockedUntil = 0; // what the host does after a 429 whatever the provider thinks
  for (let t = 0; t < minutes * 60_000; t += 10_000) {
    // A route lookup every three minutes, a second after a poll.
    if (t % 180_000 === 0 && t > 0 && t + 1_000 >= blockedUntil) {
      b.beginForeground();
      b.sending(t + 1_000);
      sent++;
      if (allow(t + 1_000)) b.answered(t + 1_000);
      else {
        limited++;
        blockedUntil = t + 1_000 + 45_000;
        b.refused(t + 1_000, true, 45_000);
      }
      b.endForeground();
    }
    if (t < blockedUntil || !b.mayPoll(t)) continue;
    b.sending(t);
    sent++;
    if (allow(t)) b.answered(t);
    else {
      limited++;
      blockedUntil = t + 45_000;
      b.refused(t, true, 45_000);
    }
  }
  return { sent, limited, perMinute: b.perMinute };
}

test('RequestBudget: against a limiter below one request a poll, far fewer 429s than polling on the clock, at nearly its rate', () => {
  for (const limit of [3, 4, 5]) {
    const naive = simulate(server(limit, 2), false, 60);
    const paced = simulate(server(limit, 2), true, 60);
    assert.ok(
      paced.limited * 4 <= naive.limited,
      `limit ${limit}/min: ${paced.limited} 429s an hour paced, ${naive.limited} unpaced`,
    );
    assert.ok(paced.limited <= 12, `limit ${limit}/min: ${paced.limited} 429s in an hour`);
    assert.ok(
      paced.sent >= 0.6 * limit * 60,
      `limit ${limit}/min: ${paced.sent} requests an hour, ${(paced.sent / 60).toFixed(1)} a minute`,
    );
  }
  // A limiter the budget never reaches draws no 429 at all.
  const roomy = simulate(server(10, 3), true, 60);
  assert.equal(roomy.limited, 0);
  assert.equal(roomy.perMinute, MAX_PER_MIN);
});

test("RequestBudget: keeps the host's own gap after a 429, so no poll is refused locally before it reaches adsb.lol", () => {
  const b = new RequestBudget({ startPerMin: 6 });
  b.sending(0);
  b.sending(15_000);
  b.refused(15_000, true, 0); // no Retry-After wait: only the gap applies
  assert.equal(b.summary(15_000).hostGapMs, 30_000, 'double the refused 15 s gap, as the host keeps it');
  assert.equal(b.mayPoll(15_000 + 26_000), false, 'a token is there, but the host would refuse');
  assert.equal(b.mayPoll(15_000 + 28_000), true, 'within the host’s two seconds of slack');
  b.sending(43_000);
  for (let i = 0; i < 70; i++) b.answered(43_000 + i);
  assert.equal(b.summary(50_000).hostGapMs, undefined, 'narrowed 5 % an answer until it no longer applies');
});
