import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import type { WhatChangedResult } from '@worldview/ipc-contract';
import { changeRows } from './changes-panel.js';
import { visibleTabs } from '../components/context-rail.js';

const ISO = '2026-09-23T06:00:00.000Z';
const ev = (id: string, type: string): WorldEvent =>
  ({ id, type, title: id, startAt: ISO, objectIds: [], provenance: {} }) as unknown as WorldEvent;

test('what changed: alerts listed on their own, counts by how far they moved, status changes named', () => {
  const alert = ev('event:nws:1', 'weather-alert');
  const quake = ev('event:usgs:2', 'earthquake');
  const result: WhatChangedResult = {
    region: { kind: 'bounds', bounds: { west: -10, east: 10, south: -10, north: 10 } },
    time: { start: ISO, end: ISO },
    newEvents: [alert, quake],
    endedEvents: [ev('event:nws:0', 'weather-alert')],
    statusChanges: [
      { objectId: 'vessel:mmsi:1', from: 'underway', to: 'moored', at: ISO },
      { objectId: 'source:adsb-lol', from: 'LIVE', to: 'DEGRADED', at: ISO },
    ],
    countChanges: [
      { objectType: 'aircraft', before: 100, after: 90 },
      { objectType: 'camera', before: 0, after: 400 },
    ],
    newAlerts: [alert],
  };
  const objects = new Map<string, WorldObject>([
    ['vessel:mmsi:1', { id: 'vessel:mmsi:1', labels: { name: 'MV Example' } } as unknown as WorldObject],
  ]);
  const rows = changeRows(result, objects);
  assert.deepEqual(
    rows.alerts.map((e) => e.id),
    ['event:nws:1'],
  );
  assert.deepEqual(
    rows.events.map((e) => e.id),
    ['event:usgs:2'],
    'the alert is not listed twice',
  );
  assert.deepEqual(
    rows.counts.map((c) => [c.objectType, c.delta]),
    [
      ['camera', 400],
      ['aircraft', -10],
    ],
  );
  assert.deepEqual(
    rows.status.map((s) => s.name),
    ['MV Example', 'adsb-lol'],
  );
  assert.equal(rows.total, 2 + 1 + 2 + 2);
});

test('what changed: a tab of its own once opened', () => {
  assert.ok(!visibleTabs([], []).includes('changes'));
  assert.ok(visibleTabs([], ['changes']).includes('changes'));
});
