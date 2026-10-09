import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceHealthEntry } from '@worldview/source-health';
import { fieldStatusItems, shortAgo, type FieldInput } from './field-status-model.js';

// Every reading here is invented.
const NOW = Date.parse('2026-10-08T20:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function entry(providerId: string, name: string, health: Partial<SourceHealthEntry['health']>, enabled = true) {
  return {
    providerId,
    name,
    categories: [],
    locality: 'local',
    enabled,
    health: {
      providerId,
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
      ...health,
    },
    transitions: [],
    meta: {},
  } as unknown as SourceHealthEntry;
}

const base: FieldInput = { workOffline: false, connection: null, entries: [], field: null };
const item = (input: Partial<FieldInput>, id: string) =>
  fieldStatusItems({ ...base, ...input }, NOW).find((i) => i.id === id);

test('field status: the network says LOCAL when working offline, else what the connection is', () => {
  assert.equal(item({ workOffline: true }, 'network')?.value, 'LOCAL');
  const off = {
    state: 'OFFLINE',
    networkOnline: false,
    remoteLive: 0,
    remoteTotal: 3,
    localLive: 1,
    at: iso(0),
  } as const;
  assert.deepEqual(item({ connection: off }, 'network'), {
    id: 'network',
    label: 'NET',
    value: 'OFFLINE',
    tone: 'warn',
    title: 'No network',
  });
  assert.equal(item({}, 'network')?.value, 'ONLINE');
});

test('field status: GPS — fix with age, STALE, unknown age, NO FIX, set by hand, no source', () => {
  const mesh = (ownPosition: unknown, status = 'LIVE', enabled = true) => ({
    entries: [
      entry('meshtastic-local', 'Meshtastic', { status: status as 'LIVE', ownPosition: ownPosition as never }, enabled),
    ],
  });
  const fix = { state: 'fix', node: 'Deck', fixAt: iso(40_000), fixType: '3D', satellites: 8, accuracyM: 3.6 };
  assert.deepEqual(item(mesh(fix), 'gps'), {
    id: 'gps',
    label: 'GPS',
    value: '3D 40 s',
    tone: 'ok',
    title: 'GPS fix (Deck) (3D, 8 satellites), 40 s old, ±3.6 m',
  });
  // The health said "fix" twenty minutes ago; the strip works the age out now.
  const old = item(mesh({ ...fix, fixAt: iso(20 * 60_000) }), 'gps')!;
  assert.equal(old.value, 'STALE 3D 20 min');
  assert.equal(old.tone, 'warn');
  assert.equal(item(mesh({ ...fix, state: 'unknown-age', fixAt: iso(-3_600_000) }), 'gps')?.value, 'age unknown');
  assert.equal(item(mesh({ ...fix, fixAt: iso(-3_600_000) }), 'gps')?.value, 'age unknown', 'ahead of the clock');
  for (const state of ['no-fix', 'not-gnss']) {
    const g = item(mesh({ state, node: 'Deck' }), 'gps')!;
    assert.equal(g.value, 'NO FIX');
    assert.equal(g.tone, 'bad');
  }
  assert.equal(item(mesh({ state: 'manual' }), 'gps')?.value, 'set by hand');
  assert.equal(item(mesh(undefined), 'gps')?.value, 'waiting');
  assert.equal(item(mesh(fix, 'OFFLINE'), 'gps')?.value, 'no node');
  assert.equal(item(mesh(fix, 'STARTING'), 'gps')?.value, 'starting');
  assert.equal(item(mesh({ state: 'stale' }), 'gps')?.value, 'age unknown', 'no fix time: no age claimed');
  assert.equal(item(mesh(fix, 'LIVE', false), 'gps')?.value, 'no source');
  assert.equal(item({}, 'gps')?.tone, 'off');
});

test('field status: receivers say "connected" and "data received" apart, with a one-click switch', () => {
  const adsb = (h: Partial<SourceHealthEntry['health']>, enabled = true) => ({
    entries: [entry('readsb-local', 'Local ADS-B receiver', h, enabled)],
  });
  const live = item(adsb({ objectCount: 12, lastObservation: iso(4000) as never }), 'adsb')!;
  assert.equal(live.value, '12 aircraft · 4 s');
  assert.equal(live.title, 'Local ADS-B receiver: connected; 12 aircraft; last data 4 s ago');
  assert.deepEqual(live.source, { providerId: 'readsb-local', enabled: true });
  const quiet = item(adsb({ objectCount: 0 }), 'adsb')!;
  assert.equal(quiet.value, 'no data yet');
  assert.equal(quiet.title, 'Local ADS-B receiver: connected, nothing received yet');
  assert.equal(item(adsb({ status: 'OFFLINE', message: 'readsb not detected at …' }), 'adsb')?.value, 'not detected');
  const off = item(adsb({}, false), 'adsb')!;
  assert.equal(off.value, 'off');
  assert.deepEqual(off.source, { providerId: 'readsb-local', enabled: false });
  assert.equal(item({}, 'adsb'), undefined, 'not installed: not shown');
  assert.equal(item(adsb({ status: 'STARTING' }), 'adsb')?.value, 'starting');
  assert.equal(item(adsb({ status: 'NEEDS_SETUP', message: 'name the receiver' }), 'adsb')?.value, 'set up');
  // Connected, but nothing new for a quarter of an hour: not shown as all well.
  const silent = item(adsb({ objectCount: 3, lastObservation: iso(15 * 60_000) as never }), 'adsb')!;
  assert.equal(silent.tone, 'warn');
  assert.match(silent.title, /nothing new since$/);
  const mesh = item(
    { entries: [entry('meshtastic-local', 'Meshtastic', { objectCount: 1, lastObservation: iso(125_000) as never })] },
    'mesh',
  );
  assert.equal(mesh?.value, '1 node · 2 min');
});

test('field status: the worst vault, disk headroom, and power', () => {
  const vault = (state: string, freeBytes?: number) =>
    ({
      id: 'a',
      label: 'Field SSD',
      path: '/media/x',
      state,
      message: `it is ${state}`,
      checkedAt: iso(0),
      ...(freeBytes !== undefined ? { freeBytes } : {}),
    }) as never;
  assert.equal(item({ vaults: [vault('ready', 812 * 1024 ** 3)] }, 'vault')?.value, 'ready · 812 GB');
  const two = item({ vaults: [vault('ready'), vault('absent')] }, 'vault')!;
  assert.equal(two.value, 'ABSENT (+1)');
  assert.equal(two.tone, 'bad');
  assert.equal(item({ vaults: [] }, 'vault'), undefined);

  const field = (power: object, freeGb?: number) => ({
    field: {
      power: power as never,
      ...(freeGb !== undefined ? { appDisk: { freeBytes: freeGb * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 } } : {}),
      at: iso(0),
    },
  });
  assert.equal(item(field({ source: 'unknown' }, 5.5), 'disk')?.value, '5.5 GB');
  assert.equal(item(field({ source: 'unknown' }, 5.5), 'disk')?.tone, 'warn');
  assert.equal(item(field({ source: 'unknown' }), 'power'), undefined, 'unknown power is not shown as anything');
  assert.equal(item(field({ source: 'battery', batteryPct: 15 }), 'power')?.value, 'BAT 15%');
  assert.equal(item(field({ source: 'battery', batteryPct: 15 }), 'power')?.tone, 'warn');
  assert.equal(item(field({ source: 'battery', batteryPct: 8 }), 'power')?.tone, 'bad');
  assert.equal(item(field({ source: 'ac', batteryPct: 80, charging: true }), 'power')?.value, 'AC 80% ↑');
  assert.equal(item(field({ source: 'ac', noBattery: true }), 'power')?.value, 'AC');
});

test('shortAgo', () => {
  assert.deepEqual([0, 89_000, 91_000, 2 * 3_600_000, 50 * 3_600_000, -5].map(shortAgo), [
    '0 s',
    '89 s',
    '2 min',
    '2 h',
    '2 d',
    '0 s',
  ]);
});
