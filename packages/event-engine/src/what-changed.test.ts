import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeoRegion, WorldObject } from '@worldview/world-model';
import type { HistoryReader } from '@worldview/query-engine';
import { EventStore } from './store.js';
import { whatChanged } from './what-changed.js';
import { DAY, FixedClock, HOUR, eventFrom, iso, obj, quake, stateOf } from './test-fixtures.js';

const hawaii: GeoRegion = { kind: 'bounds', bounds: { west: -160.3, south: 18.9, east: -154.8, north: 22.3 } };
const last24h = { start: iso(-DAY), end: iso(0) };

function synthetic() {
  const clock = new FixedClock();
  const store = new EventStore();
  const events = [
    eventFrom({
      id: 'event:earthquake:usgs:new1',
      type: 'earthquake',
      title: 'M4.6 — Kilauea',
      startAt: iso(-6 * HOUR),
      severity: 'MODERATE',
      geometry: { type: 'Point', coordinates: [-155.3, 19.4] },
    }),
    eventFrom({
      id: 'event:earthquake:usgs:old1',
      type: 'earthquake',
      title: 'M3.0 — Kilauea (2 days ago)',
      startAt: iso(-2 * DAY),
      severity: 'MINOR',
      geometry: { type: 'Point', coordinates: [-155.3, 19.4] },
    }),
    eventFrom({
      id: 'event:earthquake:usgs:japan',
      type: 'earthquake',
      title: 'M5.0 — Japan',
      startAt: iso(-3 * HOUR),
      severity: 'MODERATE',
      geometry: { type: 'Point', coordinates: [140, 36] },
    }),
    eventFrom({
      id: 'event:weather-alert:nws:surf',
      type: 'weather-alert',
      title: 'High Surf Warning',
      startAt: iso(-10 * HOUR),
      endAt: iso(6 * HOUR),
      severity: 'SEVERE',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-158.3, 21.2],
            [-157.6, 21.2],
            [-157.6, 21.8],
            [-158.3, 21.8],
            [-158.3, 21.2],
          ],
        ],
      },
    }),
    eventFrom({
      id: 'event:weather-alert:nws:wind',
      type: 'weather-alert',
      title: 'Wind Advisory (ended)',
      startAt: iso(-30 * HOUR),
      endAt: iso(-4 * HOUR),
      severity: 'MINOR',
      geometry: { type: 'Point', coordinates: [-156.3, 20.8] },
    }),
    eventFrom({
      id: 'event:wildfire-cluster:worldview:abc',
      type: 'wildfire-cluster',
      title: 'Wildfire cluster — 4 detections',
      startAt: iso(-20 * HOUR),
      severity: 'MINOR',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-156.4, 20.7],
            [-156.3, 20.7],
            [-156.3, 20.8],
            [-156.4, 20.8],
            [-156.4, 20.7],
          ],
        ],
      },
    }),
    eventFrom({
      id: 'event:source-status-change:nasa-firms:1',
      type: 'source-status-change',
      title: 'NASA FIRMS: offline',
      startAt: iso(-5 * HOUR),
      severity: 'INFO',
      properties: { providerId: 'nasa-firms', from: 'LIVE', to: 'OFFLINE' },
    }),
    eventFrom({
      id: 'event:source-status-change:nasa-firms:2',
      type: 'source-status-change',
      title: 'NASA FIRMS: live',
      startAt: iso(-3 * DAY),
      severity: 'INFO',
      properties: { providerId: 'nasa-firms', from: 'OFFLINE', to: 'LIVE' },
    }),
  ];
  for (const e of events) store.upsert(e);
  const objects: WorldObject[] = [
    quake('new1', 4.6, 19.4, -155.3, iso(-6 * HOUR), { status: 'reviewed' }),
    quake('old1', 3.0, 19.4, -155.3, iso(-2 * DAY), { status: 'reviewed' }),
    obj({ id: 'aircraft:icao24:aaaaaa', type: 'aircraft', lat: 21.3, lon: -157.9, observedAt: iso(-60_000) }),
    obj({ id: 'aircraft:icao24:bbbbbb', type: 'aircraft', lat: 21.35, lon: -157.95, observedAt: iso(-60_000) }),
    obj({ id: 'vessel:mmsi:111111111', type: 'vessel', lat: 21.3, lon: -157.87, observedAt: iso(-2 * HOUR) }),
    obj({ id: 'camera:cctv:hnl', type: 'camera', lat: 21.31, lon: -157.86, observedAt: iso(-3 * DAY) }),
  ];
  const state = stateOf(clock, objects);
  return { clock, store, state };
}

test('whatChanged without history: events in range/region, source-status fallback, count changes from live validity', async () => {
  const { clock, store, state } = synthetic();
  const r = await whatChanged({ region: hawaii, time: last24h }, { events: store, state, now: () => clock.now() });
  assert.deepEqual(r.region, hawaii);
  assert.deepEqual(r.time, last24h);
  assert.deepEqual(
    r.newEvents.map((e) => e.id),
    ['event:earthquake:usgs:new1', 'event:weather-alert:nws:surf', 'event:wildfire-cluster:worldview:abc'],
    'started in range, in region, newest first; Japan and the 2-day-old quake excluded',
  );
  assert.deepEqual(
    r.endedEvents.map((e) => e.id),
    ['event:weather-alert:nws:wind'],
  );
  assert.deepEqual(
    r.newAlerts.map((e) => e.id),
    ['event:weather-alert:nws:surf'],
  );
  assert.deepEqual(r.statusChanges, [
    { objectId: 'source:nasa-firms', from: 'LIVE', to: 'OFFLINE', at: iso(-5 * HOUR) },
  ]);
  // before = objects observed before the range start and still valid at that time (aircraft expire after 10 min → not known 24 h ago).
  assert.deepEqual(r.countChanges, [
    { objectType: 'aircraft', before: 0, after: 2 },
    { objectType: 'earthquake', before: 1, after: 2 },
    { objectType: 'vessel', before: 0, after: 1 },
  ]);
  assert.ok(!r.countChanges.some((c) => c.objectType === 'camera'), 'unchanged types are omitted');
});

test('whatChanged with history: status changes and counts come from snapshots', async () => {
  const { clock, store, state } = synthetic();
  const calls: string[] = [];
  const history: HistoryReader = {
    objectsAt(cursor) {
      calls.push(cursor);
      return [
        quake('old1', 3.0, 19.4, -155.3, iso(-2 * DAY), { status: 'automatic' }),
        obj({ id: 'camera:cctv:hnl', type: 'camera', lat: 21.31, lon: -157.86, observedAt: iso(-3 * DAY) }),
        obj({ id: 'vessel:mmsi:222222222', type: 'vessel', lat: 21.3, lon: -157.87, observedAt: iso(-25 * HOUR) }),
        quake('japan-old', 4.0, 36, 140, iso(-2 * DAY)),
      ];
    },
  };
  const r = await whatChanged(
    { region: hawaii, time: last24h },
    { events: store, state, history, now: () => clock.now() },
  );
  assert.deepEqual(calls, [last24h.start], 'range end is now → after comes from live state');
  assert.deepEqual(r.statusChanges, [
    { objectId: 'earthquake:usgs:old1', from: 'automatic', to: 'reviewed', at: iso(-2 * DAY) },
  ]);
  assert.deepEqual(
    r.countChanges,
    [
      { objectType: 'aircraft', before: 0, after: 2 },
      { objectType: 'earthquake', before: 1, after: 2 },
    ],
    'vessel 1→1 and camera 1→1 unchanged; Japan quake outside region ignored',
  );
  // A range that ended long ago reads both ends from history.
  const past = { start: iso(-3 * DAY), end: iso(-2 * DAY) };
  calls.length = 0;
  const r2 = await whatChanged(
    { region: hawaii, time: past },
    { events: store, state, history, now: () => clock.now() },
  );
  assert.deepEqual(calls, [past.start, past.end]);
  assert.deepEqual(
    r2.newEvents.map((e) => e.id),
    ['event:earthquake:usgs:old1'],
  );
  assert.deepEqual(r2.countChanges, []);
  assert.deepEqual(r2.statusChanges, []);
});
