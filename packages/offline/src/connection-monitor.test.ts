import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing } from '@worldview/provider-sdk';
import type { ConnectionSnapshot, ConnectionState } from '@worldview/source-health';
import { ConnectionMonitor, type NetworkSignal, type Scheduler } from './connection-monitor.js';

const { VirtualClock } = testing;

interface Harness {
  monitor: ConnectionMonitor;
  clock: InstanceType<typeof VirtualClock>;
  setOnline(v: boolean): void;
  pushOs(v: boolean): void;
  setProbe(v: boolean | 'throw'): void;
  setHealth(remoteLive: number, remoteTotal: number): void;
  changes: ConnectionState[];
  probes: number;
  ticks: Array<() => void>;
}

function harness(opts: { probe?: boolean; hysteresis?: number; health?: boolean } = {}): Harness {
  const clock = new VirtualClock(Date.parse('2026-09-21T12:00:00Z'));
  let online = true;
  let probe: boolean | 'throw' = true;
  let live = 2, total = 2;
  const osListeners = new Set<(online: boolean) => void>();
  const healthListeners = new Set<(s: ConnectionSnapshot) => void>();
  const network: NetworkSignal = { isOnline: () => online, subscribe: (l) => { osListeners.add(l); return () => osListeners.delete(l); } };
  const snapshot = (): ConnectionSnapshot => ({ state: live === 0 ? 'OFFLINE' : live < total ? 'DEGRADED' : 'CONNECTED', networkOnline: online, remoteLive: live, remoteTotal: total, localLive: 0, at: new Date(clock.now()).toISOString() });
  const h: Harness = {
    clock, changes: [], probes: 0, ticks: [],
    setOnline: (v) => { online = v; },
    pushOs: (v) => { online = v; for (const l of osListeners) l(v); },
    setProbe: (v) => { probe = v; },
    setHealth: (l, t) => { live = l; total = t; for (const x of healthListeners) x(snapshot()); },
    monitor: undefined as unknown as ConnectionMonitor,
  };
  const scheduler: Scheduler = { setInterval: (fn) => { h.ticks.push(fn); return fn; }, clearInterval: (handle) => { h.ticks = h.ticks.filter((t) => t !== handle); } };
  h.monitor = new ConnectionMonitor({
    network, clock, scheduler,
    ...(opts.probe === false ? {} : { probe: async () => { h.probes++; if (probe === 'throw') throw new Error('probe exploded'); return probe; } }),
    ...(opts.health === false ? {} : { sourceHealth: { connection: snapshot, on: (_e, l) => { healthListeners.add(l); return () => healthListeners.delete(l); } } }),
    ...(opts.hysteresis !== undefined ? { hysteresis: opts.hysteresis } : {}),
  });
  h.monitor.on('change', (s) => h.changes.push(s.state));
  return h;
}

test('connection-monitor: starts from the current inputs and stays put while they agree', async () => {
  const h = harness();
  assert.equal(h.monitor.state(), 'CONNECTED');
  await h.monitor.tick();
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED');
  assert.deepEqual(h.changes, []);
  assert.equal(h.probes, 2);
  const snap = h.monitor.snapshot();
  assert.equal(snap.remoteTotal, 2);
  assert.equal(snap.networkOnline, true);
});

test('connection-monitor: a probe-driven change needs two consecutive agreeing results (no flapping)', async () => {
  const h = harness();
  h.setProbe(false);
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED', 'one failed probe is not enough');
  h.setProbe(true);
  await h.monitor.tick();
  h.setProbe(false);
  await h.monitor.tick();
  h.setProbe(true);
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED', 'alternating probes never toggle the state');
  assert.deepEqual(h.changes, []);
  h.setProbe(false);
  await h.monitor.tick();
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'OFFLINE');
  assert.deepEqual(h.changes, ['OFFLINE']);
  h.setProbe('throw');
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'OFFLINE', 'a throwing probe counts as unreachable');
  h.setProbe(true);
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'OFFLINE');
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED');
  assert.deepEqual(h.changes, ['OFFLINE', 'CONNECTED']);
  assert.equal(h.monitor.probeStatus().result, true);
});

test('connection-monitor: OS offline is authoritative and immediate; OS online needs confirmation', async () => {
  const h = harness();
  h.monitor.start();
  assert.equal(h.ticks.length, 1);
  h.pushOs(false);
  assert.equal(h.monitor.state(), 'OFFLINE');
  assert.deepEqual(h.changes, ['OFFLINE']);
  await h.monitor.tick();
  assert.equal(h.probes, 0, 'no probe while the OS says offline');
  h.pushOs(true);
  assert.equal(h.monitor.state(), 'OFFLINE', 'one OS online signal is not yet confirmed');
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED', 'signal + one good probe = two agreeing observations');
  assert.deepEqual(h.changes, ['OFFLINE', 'CONNECTED']);
  h.monitor.stop();
  assert.equal(h.ticks.length, 0);
});

test('connection-monitor: source health degrades the state and a reachable network distinguishes DEGRADED from OFFLINE', async () => {
  const h = harness();
  h.setHealth(1, 2);
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED');
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'DEGRADED');
  h.setHealth(0, 2);
  await h.monitor.tick();
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'DEGRADED', 'all sources down but the probe succeeds → DEGRADED, not OFFLINE');
  h.setHealth(2, 2);
  await h.monitor.tick();
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED');
  assert.deepEqual(h.changes, ['DEGRADED', 'CONNECTED']);

  // Without a probe, the registry's judgement stands: no live remote source → OFFLINE.
  const noProbe = harness({ probe: false });
  noProbe.setHealth(0, 2);
  await noProbe.monitor.tick();
  await noProbe.monitor.tick();
  assert.equal(noProbe.monitor.state(), 'OFFLINE');

  // Registry push events re-evaluate using the last probe result, without probing again.
  const pushed = harness();
  pushed.monitor.start();
  await pushed.monitor.tick();
  assert.equal(pushed.probes, 1);
  pushed.setHealth(0, 3);
  pushed.setHealth(0, 3);
  assert.equal(pushed.monitor.state(), 'DEGRADED');
  assert.equal(pushed.probes, 1);
  pushed.monitor.stop();
});

test('connection-monitor: hysteresis of 1 commits immediately; no sources means CONNECTED when reachable', async () => {
  const h = harness({ hysteresis: 1, health: false });
  h.setProbe(false);
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'OFFLINE');
  h.setProbe(true);
  await h.monitor.tick();
  assert.equal(h.monitor.state(), 'CONNECTED');
  assert.deepEqual(h.changes, ['OFFLINE', 'CONNECTED']);
});
