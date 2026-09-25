import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import type { TimelineState, WorldChangedEvent } from '@worldview/ipc-contract';
import { initialState, rootReducer, MAX_FEED_ITEMS } from './reducer.js';
import type { RootState } from './types.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');
const ISO = new Date(NOW).toISOString();

function obj(id: string, type = 'aircraft', lat = 21, lon = -157): WorldObject {
  return {
    id,
    type,
    sourceRefs: [],
    position: { latitude: lat, longitude: lon },
    observedAt: ISO,
    updatedAt: ISO,
    freshness: 'LIVE',
    confidence: 0.9,
    labels: { callsign: id.toUpperCase() },
    properties: {},
    provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: ISO },
  };
}

function change(partial: Partial<WorldChangedEvent>): WorldChangedEvent {
  return {
    added: [],
    updated: [],
    removed: [],
    refreshed: [],
    at: ISO,
    objectCount: 0,
    objects: [],
    freshness: [],
    ...partial,
  };
}

test('world mirror: the parts of one delta applied together end where applying them one by one does', () => {
  const start = rootReducer(initialState(NOW), {
    type: 'world/snapshot',
    objects: [obj('a'), obj('b')],
    count: 2,
    subscription: {},
  });
  const parts = [
    change({ removed: ['b'], freshness: [{ id: 'a', freshness: 'RECENT' }] }),
    change({ added: ['c'], objects: [obj('c')] }),
    change({ updated: ['a'], objects: [{ ...obj('a', 'aircraft', 30, 40) }], at: '2026-09-21T08:00:09.000Z' }),
  ];
  let oneByOne = start;
  for (const p of parts) oneByOne = rootReducer(oneByOne, { type: 'world/changed', change: p });
  const together = rootReducer(start, { type: 'world/changedMany', changes: parts });
  assert.deepEqual([...together.world.objects.entries()], [...oneByOne.world.objects.entries()]);
  assert.equal(together.world.count, oneByOne.world.count);
  assert.equal(together.world.lastChangeAt, '2026-09-21T08:00:09.000Z');
  assert.equal(together.world.objects.get('a')?.position?.latitude, 30);
});

test('world mirror: snapshot replaces, deltas upsert/remove/refresh, selection survives removal', () => {
  let s: RootState = initialState(NOW);
  s = rootReducer(s, {
    type: 'world/snapshot',
    objects: [obj('a'), obj('b')],
    count: 2,
    subscription: { objectTypes: ['aircraft'] },
  });
  assert.equal(s.world.objects.size, 2);
  assert.equal(s.world.count, 2);
  s = rootReducer(s, {
    type: 'world/changed',
    change: change({ added: ['c'], objects: [obj('c'), { ...obj('a'), freshness: 'RECENT' }], updated: ['a'] }),
  });
  assert.equal(s.world.objects.size, 3);
  assert.equal(s.world.objects.get('a')?.freshness, 'RECENT');
  assert.equal(s.world.count, 3);
  s = rootReducer(s, { type: 'world/changed', change: change({ freshness: [{ id: 'b', freshness: 'STALE' }] }) });
  assert.equal(s.world.objects.get('b')?.freshness, 'STALE');
  s = rootReducer(s, { type: 'world/select', id: 'b', kind: 'object' });
  assert.equal(s.world.selectedObject?.id, 'b');
  assert.equal(s.ui.contextTab, 'selection');
  s = rootReducer(s, { type: 'world/changed', change: change({ removed: ['b', 'c'] }) });
  assert.equal(s.world.objects.has('c'), false, 'removed object dropped');
  assert.equal(s.world.objects.has('b'), true, 'selected object is kept in the mirror');
  // a snapshot without the selected object keeps it visible
  s = rootReducer(s, { type: 'world/snapshot', objects: [obj('a')], count: 1, subscription: {} });
  assert.deepEqual([...s.world.objects.keys()].sort(), ['a', 'b']);
  // selected object updates follow deltas
  s = rootReducer(s, {
    type: 'world/changed',
    change: change({ updated: ['b'], objects: [{ ...obj('b', 'aircraft', 22, -158) }] }),
  });
  assert.equal(s.world.selectedObject?.position?.latitude, 22);
  // empty change only updates lastChangeAt
  const before = s.world.objects;
  s = rootReducer(s, { type: 'world/changed', change: change({ at: '2026-09-21T08:00:05.000Z' }) });
  assert.equal(s.world.objects, before);
  assert.equal(s.world.lastChangeAt, '2026-09-21T08:00:05.000Z');
});

test('selection: track/related only apply to the current selection; clearing resets everything', () => {
  let s: RootState = initialState(NOW);
  s = rootReducer(s, { type: 'world/select', id: 'x', kind: 'object' });
  s = rootReducer(s, { type: 'world/track', objectId: 'y', points: [{ observedAt: ISO, latitude: 1, longitude: 2 }] });
  assert.equal(s.world.track.length, 0, 'stale track ignored');
  s = rootReducer(s, { type: 'world/track', objectId: 'x', points: [{ observedAt: ISO, latitude: 1, longitude: 2 }] });
  assert.equal(s.world.track.length, 1);
  s = rootReducer(s, { type: 'world/selectedObject', object: obj('x') });
  assert.equal(s.world.selectedObject?.id, 'x');
  assert.equal(s.world.objects.has('x'), true, 'selected object loaded outside the subscription is mirrored');
  s = rootReducer(s, { type: 'world/related', forId: 'x', objects: [obj('z')], events: [] });
  assert.equal(s.world.related.objects.length, 1);
  s = rootReducer(s, { type: 'world/select', id: 'event:earthquake:usgs:1' });
  assert.equal(s.world.selectedKind, 'event');
  assert.equal(s.world.track.length, 0);
  s = rootReducer(s, { type: 'world/select', id: null });
  assert.equal(s.world.selectedId, null);
  assert.equal(s.world.selectedObject, null);
  assert.equal(s.world.related.objects.length, 0);
});

test('selection: an object the runtime no longer has reads as missing, not as loading forever', () => {
  let s: RootState = initialState(NOW);
  s = rootReducer(s, { type: 'world/select', id: 'earthquake:usgs:old', kind: 'object' });
  assert.equal(s.world.selectedMissing, false);
  s = rootReducer(s, { type: 'world/selectedObject', object: null });
  assert.equal(s.world.selectedMissing, true);
  s = rootReducer(s, { type: 'world/select', id: 'x', kind: 'object' });
  assert.equal(s.world.selectedMissing, false, 'a new selection starts over');
  s = rootReducer(s, { type: 'world/selectedObject', object: obj('x') });
  assert.equal(s.world.selectedMissing, false);
  s = rootReducer(s, { type: 'world/select', id: null });
  s = rootReducer(s, { type: 'world/selectedObject', object: null });
  assert.equal(s.world.selectedMissing, false, 'nothing selected is not missing');
});

test('timeline: runtime sync maps ISO state into the control reducer; control actions delegate', () => {
  let s: RootState = initialState(NOW);
  const runtime: TimelineState = {
    mode: 'HISTORICAL',
    cursor: '2026-09-21T07:00:00.000Z',
    speed: 5,
    range: { start: '2026-09-20T08:00:00.000Z', end: ISO },
    availability: [{ objectType: 'earthquake', ranges: [{ start: '2026-09-20T08:00:00.000Z', end: ISO }] }],
  };
  s = rootReducer(s, { type: 'timeline/runtime', state: runtime, nowMs: NOW });
  assert.equal(s.timeline.control.mode, 'HISTORICAL');
  assert.equal(s.timeline.control.cursorMs, NOW - 3600_000);
  assert.equal(s.timeline.control.speed, 5);
  assert.equal(s.timeline.control.availability[0]?.objectType, 'earthquake');
  assert.equal(s.timeline.runtime, runtime);
  s = rootReducer(s, { type: 'timeline/control', action: { type: 'jumpToLive' } });
  assert.equal(s.timeline.control.mode, 'LIVE');
  const same = rootReducer(s, { type: 'timeline/control', action: { type: 'jumpToLive' } });
  assert.equal(same, s, 'no-op actions keep state identity');
});

test('feed: newest first, bounded, dedup, unread counter', () => {
  // The session began at 07:05: items dated after it are news.
  let s: RootState = initialState(Date.parse('2026-09-21T07:05:00Z'));
  const item = (id: string, at: string) => ({
    id,
    at,
    title: id,
    severity: 'INFO' as const,
    type: 'earthquake',
    recorded: true,
  });
  s = rootReducer(s, {
    type: 'feed/recent',
    items: [item('a', '2026-09-21T07:00:00Z'), item('b', '2026-09-21T07:30:00Z')],
  });
  assert.deepEqual(
    s.feed.items.map((i) => i.id),
    ['b', 'a'],
  );
  s = rootReducer(s, { type: 'feed/item', item: item('c', '2026-09-21T07:45:00Z') });
  assert.equal(s.feed.items[0]?.id, 'c');
  assert.equal(s.feed.unread, 1);
  const dup = rootReducer(s, { type: 'feed/item', item: item('c', '2026-09-21T07:45:00Z') });
  assert.equal(dup, s);
  // An event that happened earlier but arrived now takes its place in time, not the top.
  s = rootReducer(s, { type: 'feed/item', item: item('late', '2026-09-21T07:10:00Z') });
  assert.deepEqual(
    s.feed.items.map((i) => i.id),
    ['c', 'b', 'late', 'a'],
  );
  assert.equal(s.feed.unread, 2, 'still counted as new');
  // Already in force before the session began (every active alert on the first poll): listed, not unread.
  s = rootReducer(s, { type: 'feed/item', item: item('old', '2026-09-21T06:00:00Z') });
  assert.equal(s.feed.items.at(-1)?.id, 'old');
  assert.equal(s.feed.unread, 2, 'not news to this session');
  s = rootReducer(s, { type: 'feed/markRead' });
  assert.equal(s.feed.unread, 0);
  for (let i = 0; i < MAX_FEED_ITEMS + 10; i++) s = rootReducer(s, { type: 'feed/item', item: item(`f${i}`, ISO) });
  assert.equal(s.feed.items.length, MAX_FEED_ITEMS);
});

test('session, lenses, sources, ui slices', () => {
  let s: RootState = initialState(NOW);
  const settings = {
    renderMode: '3D' as const,
    firstRunCompleted: true,
    basemapId: 'b',
    terrainId: 't',
    activeLensId: 'aviation',
    reducedMotion: true,
    textScale: 1.2,
    updater: { automatic: false, prerelease: false },
    cameras: { go2rtcPath: '' },
    demoMode: true,
    privacy: { telemetry: false as const },
    providers: {},
    hiddenLayers: [],
    tileCache: { maxMB: 2048, preloadWorld: false },
    history: { maxMB: 10_240 },
    reference: { borders: true, labels: true },
  };
  s = rootReducer(s, {
    type: 'session/ready',
    appInfo: { version: '1', channel: 'dev', commit: 'c', demoMode: true, platform: 'browser' },
    settings,
  });
  assert.equal(s.session.status, 'ready');
  assert.equal(s.ui.mode, '3D', 'render mode follows settings');
  assert.equal(s.lenses.activeId, 'aviation', 'lens follows settings');
  s = rootReducer(s, { type: 'lenses/activate', id: 'nope' });
  assert.equal(s.lenses.activeId, 'aviation');
  s = rootReducer(s, { type: 'lenses/list', lenses: [] });
  assert.ok(s.lenses.lenses.length >= 9, 'empty list falls back to built-in lenses');
  s = rootReducer(s, { type: 'sources/credential', key: 'firms.mapKey', present: true });
  assert.equal(s.sources.credentials['firms.mapKey'], true);
  s = rootReducer(s, { type: 'ui/contextTab', tab: 'collections' });
  assert.equal(s.ui.contextTab, 'collections');
  assert.ok(s.ui.pinnedTabs.includes('collections'));
  for (let i = 0; i < 8; i++)
    s = rootReducer(s, {
      type: 'ui/notify',
      notification: { id: `n${i}`, title: 't', body: 'b', severity: 'INFO', at: NOW },
    });
  assert.equal(s.ui.notifications.length, 5, 'notifications are bounded');
  s = rootReducer(s, { type: 'session/error', message: 'boom' });
  assert.equal(s.session.status, 'error');
});

test('world/changed: the selected object moving grows its track; a replayed position does not', () => {
  let s: RootState = initialState(NOW);
  s = rootReducer(s, { type: 'world/select', id: 'a', kind: 'object' });
  s = rootReducer(s, { type: 'world/selectedObject', object: obj('a') });
  s = rootReducer(s, {
    type: 'world/track',
    objectId: 'a',
    points: [
      { observedAt: new Date(NOW - 20_000).toISOString(), latitude: 21, longitude: -157.2 },
      { observedAt: new Date(NOW - 10_000).toISOString(), latitude: 21, longitude: -157.1 },
    ],
  });
  const moved = {
    ...obj('a', 'aircraft', 21, -157),
    observedAt: ISO,
    position: { latitude: 21, longitude: -157, altitudeM: 900 },
  };
  s = rootReducer(s, { type: 'world/changed', change: change({ updated: ['a'], objects: [moved] }) });
  assert.equal(s.world.track.length, 3);
  assert.deepEqual(s.world.track.at(-1), { observedAt: ISO, latitude: 21, longitude: -157, altitudeM: 900 });

  const replayed = {
    ...moved,
    observedAt: new Date(NOW - 60_000).toISOString(),
    position: { latitude: 20, longitude: -150 },
  };
  s = rootReducer(s, { type: 'world/changed', change: change({ updated: ['a'], objects: [replayed] }) });
  assert.equal(s.world.track.length, 3, 'an earlier position is the timeline moving back, not the object');

  const other = { ...obj('b'), observedAt: new Date(NOW + 10_000).toISOString() };
  s = rootReducer(s, { type: 'world/changed', change: change({ updated: ['b'], objects: [other] }) });
  assert.equal(s.world.track.length, 3, 'only the selected object');
});

test('paged snapshot: the view stays filled while pages arrive; deltas win; the last page sweeps', () => {
  let s: RootState = initialState(NOW);
  // A regional mirror: two aircraft and a ship on screen.
  s = rootReducer(s, {
    type: 'world/snapshot',
    objects: [obj('a1'), obj('a2'), obj('s1', 'ship')],
    count: 3,
    subscription: { objectTypes: ['aircraft', 'ship'], bounds: { west: -160, south: 18, east: -154, north: 23 } },
  });
  // Zoom out: a world snapshot for aircraft only, in pages.
  const sub = { objectTypes: ['aircraft'] };
  s = rootReducer(s, { type: 'world/snapshotStart', token: 't1', objects: [obj('b1')], count: 5, subscription: sub });
  assert.deepEqual(
    [...s.world.objects.keys()].sort(),
    ['a1', 'a2', 'b1'],
    'on-screen aircraft stay until the snapshot decides; the ship is not in the new lens',
  );
  // A delta during the stream: a2 moves (newer than any page), b3 is removed.
  const moved = { ...obj('a2'), updatedAt: '2026-09-21T08:00:30.000Z', position: { latitude: 22, longitude: -157 } };
  s = rootReducer(s, {
    type: 'world/changed',
    change: change({ updated: ['a2'], removed: ['b3'], objects: [moved] }),
  });
  // A page that still carries the old a2 and the removed b3.
  s = rootReducer(s, {
    type: 'world/snapshotPart',
    token: 't1',
    objects: [obj('a2'), obj('b2'), obj('b3')],
    done: false,
  });
  assert.equal(s.world.objects.get('a2')?.position?.latitude, 22, 'the page’s older a2 does not overwrite the delta');
  assert.equal(s.world.objects.has('b3'), false, 'a removed object is not brought back');
  // A page for a replaced stream is ignored.
  const before = s;
  s = rootReducer(s, { type: 'world/snapshotPart', token: 'old', objects: [obj('zz')], done: true });
  assert.equal(s, before);
  // The last page: a1 was never named by the snapshot, so it goes.
  s = rootReducer(s, { type: 'world/snapshotPart', token: 't1', objects: [obj('b4')], done: true });
  assert.deepEqual([...s.world.objects.keys()].sort(), ['a2', 'b1', 'b2', 'b4']);
  assert.equal(s.world.snapshotStream, null);
  assert.equal(s.world.count, 4, 'five in the snapshot, one removed by a delta since');
});

test('paged snapshot: the selected object survives the sweep; a whole snapshot ends a stream', () => {
  let s: RootState = initialState(NOW);
  s = rootReducer(s, { type: 'world/snapshot', objects: [obj('sel'), obj('x')], count: 2, subscription: {} });
  s = rootReducer(s, { type: 'world/select', id: 'sel', kind: 'object' });
  assert.equal(s.world.selectedId, 'sel');
  s = rootReducer(s, { type: 'world/snapshotStart', token: 't', objects: [obj('y')], count: 2, subscription: {} });
  s = rootReducer(s, { type: 'world/snapshotPart', token: 't', objects: [obj('z')], done: true });
  assert.equal(s.world.objects.has('x'), false);
  assert.equal(s.world.objects.has('sel'), true, 'the selection is kept');
  s = rootReducer(s, { type: 'world/snapshotStart', token: 'u', objects: [], count: 9, subscription: {} });
  s = rootReducer(s, { type: 'world/snapshot', objects: [obj('w')], count: 1, subscription: {} });
  assert.equal(s.world.snapshotStream, null);
});
