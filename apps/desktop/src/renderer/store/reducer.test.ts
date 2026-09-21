import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import type { TimelineState, WorldChangedEvent } from '@worldview/ipc-contract';
import { initialState, rootReducer, MAX_FEED_ITEMS } from './reducer.js';
import type { RootState } from './types.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');
const ISO = new Date(NOW).toISOString();

function obj(id: string, type = 'aircraft', lat = 21, lon = -157): WorldObject {
  return { id, type, sourceRefs: [], position: { latitude: lat, longitude: lon }, observedAt: ISO, updatedAt: ISO, freshness: 'LIVE', confidence: 0.9, labels: { callsign: id.toUpperCase() }, properties: {}, provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: ISO } };
}

function change(partial: Partial<WorldChangedEvent>): WorldChangedEvent {
  return { added: [], updated: [], removed: [], refreshed: [], at: ISO, objectCount: 0, objects: [], freshness: [], ...partial };
}

test('world mirror: snapshot replaces, deltas upsert/remove/refresh, selection survives removal', () => {
  let s: RootState = initialState(NOW);
  s = rootReducer(s, { type: 'world/snapshot', objects: [obj('a'), obj('b')], count: 2, subscription: { objectTypes: ['aircraft'] } });
  assert.equal(s.world.objects.size, 2);
  assert.equal(s.world.count, 2);
  s = rootReducer(s, { type: 'world/changed', change: change({ added: ['c'], objects: [obj('c'), { ...obj('a'), freshness: 'RECENT' }], updated: ['a'] }) });
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
  s = rootReducer(s, { type: 'world/changed', change: change({ updated: ['b'], objects: [{ ...obj('b', 'aircraft', 22, -158) }] }) });
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

test('timeline: runtime sync maps ISO state into the control reducer; control actions delegate', () => {
  let s: RootState = initialState(NOW);
  const runtime: TimelineState = { mode: 'HISTORICAL', cursor: '2026-09-21T07:00:00.000Z', speed: 5, range: { start: '2026-09-20T08:00:00.000Z', end: ISO }, availability: [{ objectType: 'earthquake', ranges: [{ start: '2026-09-20T08:00:00.000Z', end: ISO }] }] };
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
  let s: RootState = initialState(NOW);
  const item = (id: string, at: string) => ({ id, at, title: id, severity: 'INFO' as const, type: 'earthquake', recorded: true });
  s = rootReducer(s, { type: 'feed/recent', items: [item('a', '2026-09-21T07:00:00Z'), item('b', '2026-09-21T07:30:00Z')] });
  assert.deepEqual(s.feed.items.map((i) => i.id), ['b', 'a']);
  s = rootReducer(s, { type: 'feed/item', item: item('c', '2026-09-21T07:45:00Z') });
  assert.equal(s.feed.items[0]?.id, 'c');
  assert.equal(s.feed.unread, 1);
  const dup = rootReducer(s, { type: 'feed/item', item: item('c', '2026-09-21T07:45:00Z') });
  assert.equal(dup, s);
  s = rootReducer(s, { type: 'feed/markRead' });
  assert.equal(s.feed.unread, 0);
  for (let i = 0; i < MAX_FEED_ITEMS + 10; i++) s = rootReducer(s, { type: 'feed/item', item: item(`f${i}`, ISO) });
  assert.equal(s.feed.items.length, MAX_FEED_ITEMS);
});

test('session, lenses, sources, ui slices', () => {
  let s: RootState = initialState(NOW);
  const settings = { renderMode: '3D' as const, firstRunCompleted: true, basemapId: 'b', terrainId: 't', activeLensId: 'aviation', reducedMotion: true, textScale: 1.2, updater: { automatic: false, prerelease: false }, demoMode: true, privacy: { telemetry: false as const }, providers: {} };
  s = rootReducer(s, { type: 'session/ready', appInfo: { version: '1', channel: 'dev', commit: 'c', demoMode: true, platform: 'browser' }, settings });
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
  for (let i = 0; i < 8; i++) s = rootReducer(s, { type: 'ui/notify', notification: { id: `n${i}`, title: 't', body: 'b', severity: 'INFO', at: NOW } });
  assert.equal(s.ui.notifications.length, 5, 'notifications are bounded');
  s = rootReducer(s, { type: 'session/error', message: 'boom' });
  assert.equal(s.session.status, 'error');
});
