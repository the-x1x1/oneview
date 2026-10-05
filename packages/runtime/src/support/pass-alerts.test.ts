import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PassAlertSettings } from '@worldview/ipc-contract';
import type { JsonValue } from '@worldview/world-model';
import { PASS_ALERT_HORIZON_MS, PassAlerts, passAlertBody } from './pass-alerts.js';

const T0 = Date.parse('2026-10-05T04:00:00.000Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const pass = (riseMin: number, visible: boolean) => ({
  riseAt: iso(riseMin),
  riseAzimuthDeg: 300,
  culminationAt: iso(riseMin + 3),
  culminationAzimuthDeg: 20,
  maxElevationDeg: 61.6,
  setAt: iso(riseMin + 6),
  setAzimuthDeg: 100,
  ...(visible ? { visibleFrom: iso(riseMin + 1), visibleUntil: iso(riseMin + 5) } : {}),
});

function harness(settings: PassAlertSettings | undefined, passes: JsonValue[], home = true) {
  let now = T0;
  const timers: Array<{ at: number; fn: () => void; handle: number; cleared?: boolean }> = [];
  let next = 1;
  const notices: Array<{ id: string; title: string; body: string; desktop: boolean }> = [];
  const asked: string[] = [];
  const alerts = new PassAlerts({
    now: () => now,
    settings: () => settings,
    home: () => (home ? { latitude: 21.3, longitude: -157.9 } : undefined),
    details: async (objectId) => {
      asked.push(objectId);
      return [{ properties: { passes } }];
    },
    notify: (n) => notices.push(n),
    setTimer: (fn, ms) => {
      const handle = next++;
      timers.push({ at: now + ms, fn, handle });
      return handle;
    },
    clearTimer: (h) => {
      const t = timers.find((x) => x.handle === h);
      if (t) t.cleared = true;
    },
  });
  const advance = (minutes: number) => {
    now += minutes * 60_000;
    for (const t of timers)
      if (!t.cleared && t.at <= now) {
        t.cleared = true;
        t.fn();
      }
  };
  return { alerts, notices, asked, advance, set: (s: PassAlertSettings | undefined) => (settings = s) };
}

const ISS = { objectId: 'satellite:norad:25544', name: 'ISS (ZARYA)' };
const base: PassAlertSettings = { satellites: [ISS], leadMinutes: 10, visibleOnly: true, desktop: false };

test('a visible pass over home is announced its lead before it rises, once', async () => {
  const h = harness(base, [pass(30, true), pass(120, false), pass(60 * 5, true)]);
  await h.alerts.refresh();
  assert.deepEqual(h.asked, [ISS.objectId]);
  assert.deepEqual(
    h.alerts.scheduled(),
    [`${ISS.objectId}|${iso(30)}`],
    'the invisible one and the one hours away are not',
  );
  h.advance(19);
  assert.equal(h.notices.length, 0);
  h.advance(1);
  assert.deepEqual(h.notices, [
    {
      id: `pass:${ISS.objectId}|${iso(30)}`,
      title: 'ISS (ZARYA) over home in 10 min',
      body: 'Rises WNW at 04:30 UTC, highest 62° NNE at 04:33, sets E · visible to the eye 04:31–04:35 UTC',
      desktop: false,
    },
  ]);
  await h.alerts.refresh();
  h.advance(5);
  assert.equal(h.notices.length, 1, 'announced once');
});

test('every pass when visibility does not matter; a look after the lead announces at once; desktop as set now', async () => {
  const h = harness({ ...base, visibleOnly: false }, [pass(5, false)]);
  await h.alerts.refresh();
  h.set({ ...base, visibleOnly: false, desktop: true });
  h.advance(0);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0]!.title, 'ISS (ZARYA) over home in 5 min');
  assert.equal(h.notices[0]!.desktop, true, 'the desktop switch as it stands when it fires');
  assert.match(h.notices[0]!.body, /not visible to the eye$/);
});

test('no home, no satellites, or a satellite taken off the list: nothing scheduled, and a scheduled one never fires', async () => {
  const noHome = harness(base, [pass(30, true)], false);
  await noHome.alerts.refresh();
  assert.deepEqual(noHome.alerts.scheduled(), []);
  assert.deepEqual(noHome.asked, [], 'nothing asked without a home');
  const h = harness(base, [pass(30, true)]);
  await h.alerts.refresh();
  assert.equal(h.alerts.scheduled().length, 1);
  h.set({ ...base, satellites: [] });
  await h.alerts.refresh();
  assert.deepEqual(h.alerts.scheduled(), []);
  h.advance(60);
  assert.equal(h.notices.length, 0);
  assert.ok(PASS_ALERT_HORIZON_MS >= 3600_000);
});

test('the notice text', () => {
  assert.equal(
    passAlertBody({ ...pass(0, false), riseAzimuthDeg: undefined } as never),
    'Rises at 04:00 UTC, highest 62° NNE at 04:03, sets E · not visible to the eye',
  );
});
