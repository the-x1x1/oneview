import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject, WorldQuery } from '@worldview/world-model';
import { executeEventQuery, executeQuery, executeQueryWithHistory, type HistoryReader } from './execute.js';
import { matchesFilter } from './filters.js';
import { compareValues, resolveObjectField } from './fields.js';
import { FixedClock, T0, eventFrom, objectFrom, stateWith } from './test-fixtures.js';

const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function fixtureState(clock: FixedClock) {
  return stateWith(clock, [
    { providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us1', lat: 36.0, lon: 140.0, observedAt: iso(-3_600_000), payload: { magnitude: 5.7, depthKm: 10, place: '20 km E of Tokyo, Japan', status: 'reviewed' } },
    { providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us2', lat: 19.4, lon: -155.3, observedAt: iso(-7_200_000), payload: { magnitude: 2.1, depthKm: 3, place: 'Kilauea, Hawaii', status: 'automatic' } },
    { providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us3', lat: 34.1, lon: -118.2, observedAt: iso(-60_000), payload: { magnitude: 4.4, place: 'Los Angeles, CA', status: 'reviewed', tsunami: false } },
    { providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'a1b2c3', lat: 21.4, lon: -157.9, altitudeM: 10_000, payload: { icao24: 'a1b2c3', callsign: 'UAL123', speedMps: 240 } },
    { providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'c0ffee', lat: 34.0, lon: -118.0, altitudeM: 2_000, payload: { icao24: 'c0ffee', callsign: 'HAL45', speedMps: 120 } },
    { providerId: 'aisstream', objectType: 'vessel', externalId: '366123456', lat: 21.3, lon: -157.87, payload: { mmsi: '366123456', name: 'Aloha Star', speedMps: 6 } },
  ]);
}

test('executeQuery: objectTypes, providerIds, region and default ordering are deterministic', () => {
  const clock = new FixedClock();
  const state = fixtureState(clock);
  const all = executeQuery({}, { state, now: () => clock.now() });
  assert.equal(all.total, 6);
  assert.equal(all.basis, 'live');
  assert.equal(all.truncated, false);
  assert.equal(all.evaluatedAt, iso(0));
  // newest observedAt first, id tie-break
  assert.equal(all.items[0]!.type !== 'earthquake' || all.items[0]!.id === 'earthquake:usgs:us3', true);

  const quakes = executeQuery({ objectTypes: ['earthquake'] }, { state, now: () => clock.now() });
  assert.deepEqual(quakes.items.map((o) => o.id), ['earthquake:usgs:us3', 'earthquake:usgs:us1', 'earthquake:usgs:us2']);

  const byProvider = executeQuery({ providerIds: ['aisstream'] }, { state, now: () => clock.now() });
  assert.deepEqual(byProvider.items.map((o) => o.id), ['vessel:mmsi:366123456']);

  const hawaii = executeQuery({ region: { kind: 'bounds', bounds: { west: -160.3, south: 18.9, east: -154.8, north: 22.3 } } }, { state, now: () => clock.now() });
  assert.deepEqual(hawaii.items.map((o) => o.id).sort(), ['aircraft:icao24:a1b2c3', 'earthquake:usgs:us2', 'vessel:mmsi:366123456']);

  const nearHnl = executeQuery({ region: { kind: 'circle', center: { latitude: 21.32, longitude: -157.92 }, radiusM: 20_000 }, objectTypes: ['aircraft', 'vessel'] }, { state, now: () => clock.now() });
  assert.deepEqual(nearHnl.items.map((o) => o.id).sort(), ['aircraft:icao24:a1b2c3', 'vessel:mmsi:366123456']);

  const admin = executeQuery({ region: { kind: 'admin', regionId: 'iso3166-2:US-HI' } }, { state, now: () => clock.now() });
  assert.equal(admin.total, 0, 'admin region without bounds cannot be evaluated → empty');

  // Same input twice → identical output.
  const again = executeQuery({ objectTypes: ['earthquake'] }, { state, now: () => clock.now() });
  assert.deepEqual(again, quakes);
});

test('executeQuery: filters on properties/labels/motion/position/freshness/confidence/type/observedAt', () => {
  const clock = new FixedClock();
  const state = fixtureState(clock);
  const run = (q: WorldQuery) => executeQuery(q, { state, now: () => clock.now() }).items.map((o) => o.id).sort();
  assert.deepEqual(run({ filters: [{ field: 'properties.magnitude', op: 'gte', value: 5 }] }), ['earthquake:usgs:us1']);
  assert.deepEqual(run({ filters: [{ field: 'magnitude', op: 'gt', value: 4 }] }), ['earthquake:usgs:us1', 'earthquake:usgs:us3'], 'bare field falls back to properties');
  assert.deepEqual(run({ filters: [{ field: 'properties.magnitude', op: 'lt', value: 3 }] }), ['earthquake:usgs:us2']);
  assert.deepEqual(run({ filters: [{ field: 'properties.magnitude', op: 'lte', value: 2.1 }] }), ['earthquake:usgs:us2']);
  assert.deepEqual(run({ filters: [{ field: 'labels.callsign', op: 'eq', value: 'UAL123' }] }), ['aircraft:icao24:a1b2c3']);
  assert.deepEqual(run({ filters: [{ field: 'labels.callsign', op: 'neq', value: 'UAL123' }], objectTypes: ['aircraft'] }), ['aircraft:icao24:c0ffee']);
  assert.deepEqual(run({ filters: [{ field: 'labels.name', op: 'contains', value: 'aloha' }] }), ['vessel:mmsi:366123456'], 'contains is case-insensitive');
  assert.deepEqual(run({ filters: [{ field: 'properties.place', op: 'contains', value: 'HAWAII' }] }), ['earthquake:usgs:us2']);
  assert.deepEqual(run({ filters: [{ field: 'motion.speedMps', op: 'gte', value: 200 }] }), ['aircraft:icao24:a1b2c3']);
  assert.deepEqual(run({ filters: [{ field: 'position.altitudeM', op: 'gt', value: 5000 }] }), ['aircraft:icao24:a1b2c3']);
  assert.deepEqual(run({ filters: [{ field: 'freshness', op: 'in', value: ['LIVE'] }], objectTypes: ['aircraft', 'vessel'] }), ['aircraft:icao24:a1b2c3', 'aircraft:icao24:c0ffee', 'vessel:mmsi:366123456']);
  assert.deepEqual(run({ filters: [{ field: 'freshness', op: 'eq', value: 'RECENT' }] }), ['earthquake:usgs:us2', 'earthquake:usgs:us3'].filter((id) => id === 'earthquake:usgs:us2'), '2 h old quake is RECENT under the earthquake policy');
  assert.deepEqual(run({ filters: [{ field: 'type', op: 'in', value: ['vessel', 'aircraft'] }] }).length, 3);
  assert.deepEqual(run({ filters: [{ field: 'properties.tsunami', op: 'exists' }] }), ['earthquake:usgs:us3']);
  assert.deepEqual(run({ filters: [{ field: 'properties.depthKm', op: 'exists', value: false }], objectTypes: ['earthquake'] }), ['earthquake:usgs:us3']);
  assert.deepEqual(run({ filters: [{ field: 'observedAt', op: 'gte', value: iso(-120_000) }] }), ['aircraft:icao24:a1b2c3', 'aircraft:icao24:c0ffee', 'earthquake:usgs:us3', 'vessel:mmsi:366123456']);
  assert.deepEqual(run({ filters: [{ field: 'confidence', op: 'gte', value: 0.5 }] }).length, 6);
  assert.deepEqual(run({ filters: [{ field: 'properties.missing', op: 'gt', value: 1 }] }), [], 'missing field never satisfies ordering');
  assert.deepEqual(run({ filters: [{ field: 'providerId', op: 'eq', value: 'adsb-lol' }] }), ['aircraft:icao24:a1b2c3', 'aircraft:icao24:c0ffee']);
});

test('executeQuery: text matches ids, labels and external ids', () => {
  const clock = new FixedClock();
  const state = fixtureState(clock);
  const run = (text: string) => executeQuery({ text }, { state, now: () => clock.now() }).items.map((o) => o.id).sort();
  assert.deepEqual(run('aloha'), ['vessel:mmsi:366123456']);
  assert.deepEqual(run('UAL'), ['aircraft:icao24:a1b2c3']);
  assert.deepEqual(run('a1b2'), ['aircraft:icao24:a1b2c3']);
  assert.deepEqual(run('us3'), ['earthquake:usgs:us3']);
  assert.deepEqual(run('tokyo japan'), ['earthquake:usgs:us1']);
  assert.deepEqual(run('nothing-here'), []);
});

test('executeQuery: sort is type-aware, undefined sorts last, limit sets truncated', () => {
  const clock = new FixedClock();
  const state = fixtureState(clock);
  const now = () => clock.now();
  const desc = executeQuery({ objectTypes: ['earthquake'], sort: { field: 'properties.magnitude', direction: 'desc' } }, { state, now });
  assert.deepEqual(desc.items.map((o) => o.properties['magnitude']), [5.7, 4.4, 2.1]);
  const asc = executeQuery({ objectTypes: ['earthquake'], sort: { field: 'properties.magnitude', direction: 'asc' } }, { state, now });
  assert.deepEqual(asc.items.map((o) => o.properties['magnitude']), [2.1, 4.4, 5.7]);
  const byPlace = executeQuery({ objectTypes: ['earthquake'], sort: { field: 'properties.place', direction: 'asc' } }, { state, now });
  assert.deepEqual(byPlace.items.map((o) => o.id), ['earthquake:usgs:us1', 'earthquake:usgs:us2', 'earthquake:usgs:us3']);
  const byDate = executeQuery({ objectTypes: ['earthquake'], sort: { field: 'observedAt', direction: 'asc' } }, { state, now });
  assert.deepEqual(byDate.items.map((o) => o.id), ['earthquake:usgs:us2', 'earthquake:usgs:us1', 'earthquake:usgs:us3']);
  const depthDesc = executeQuery({ objectTypes: ['earthquake'], sort: { field: 'properties.depthKm', direction: 'desc' } }, { state, now });
  assert.equal(depthDesc.items[2]!.id, 'earthquake:usgs:us3', 'object without depth sorts last in desc');
  const depthAsc = executeQuery({ objectTypes: ['earthquake'], sort: { field: 'properties.depthKm', direction: 'asc' } }, { state, now });
  assert.equal(depthAsc.items[2]!.id, 'earthquake:usgs:us3', 'and last in asc');
  const limited = executeQuery({ objectTypes: ['earthquake'], sort: { field: 'properties.magnitude', direction: 'desc' }, limit: 2 }, { state, now });
  assert.equal(limited.total, 3);
  assert.equal(limited.items.length, 2);
  assert.equal(limited.truncated, true);
  const zero = executeQuery({ objectTypes: ['earthquake'], limit: 0 }, { state, now });
  assert.equal(zero.items.length, 0);
  assert.equal(zero.total, 3);
  assert.equal(zero.truncated, true);
});

test('executeQuery: time without history filters live objects by observedAt; with history uses the snapshot and basis historical', async () => {
  const clock = new FixedClock();
  const state = fixtureState(clock);
  const now = () => clock.now();
  const time = { start: iso(-90 * 60_000), end: iso(0) };
  const live = executeQuery({ objectTypes: ['earthquake'], time }, { state, now });
  assert.equal(live.basis, 'live');
  assert.deepEqual(live.items.map((o) => o.id), ['earthquake:usgs:us3', 'earthquake:usgs:us1']);

  const calls: Array<{ cursor: string; opts: unknown }> = [];
  const history: HistoryReader = {
    objectsAt(cursor, opts) {
      calls.push({ cursor, opts });
      return [
        objectFrom({ providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'old1', id: 'earthquake:usgs:old1', lat: 35.0, lon: 139.0, observedAt: iso(-5 * 86_400_000), freshness: 'HISTORICAL', payload: { magnitude: 6.1 }, origin: 'historical' }),
        objectFrom({ providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'old2', id: 'earthquake:usgs:old2', lat: 10.0, lon: 10.0, observedAt: iso(-4 * 86_400_000), freshness: 'HISTORICAL', payload: { magnitude: 3.0 }, origin: 'historical' }),
      ];
    },
  };
  const q: WorldQuery = { objectTypes: ['earthquake'], time: { start: iso(-7 * 86_400_000), end: iso(-3 * 86_400_000) }, region: { kind: 'bounds', bounds: { west: 122.9, south: 24, east: 146.1, north: 45.6 } }, filters: [{ field: 'properties.magnitude', op: 'gte', value: 5 }] };
  const hist = await executeQueryWithHistory(q, { state, history, now });
  assert.equal(hist.basis, 'historical');
  assert.deepEqual(hist.items.map((o) => o.id), ['earthquake:usgs:old1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cursor, q.time!.end);
  assert.deepEqual(calls[0]!.opts, { objectTypes: ['earthquake'], bounds: { west: 122.9, south: 24, east: 146.1, north: 45.6 }, lookbackSeconds: 4 * 86_400 });

  const noTime = await executeQueryWithHistory({ objectTypes: ['aircraft'] }, { state, history, now });
  assert.equal(noTime.basis, 'live');
  assert.equal(calls.length, 1, 'history is not consulted without query.time');
});

test('executeEventQuery: eventTypes, region (geometry intersection), time overlap, filters, sort, limit', () => {
  const clock = new FixedClock();
  const events = [
    eventFrom({ id: 'event:earthquake:usgs:us1', type: 'earthquake', title: 'M5.7 earthquake — Japan', startAt: iso(-3_600_000), severity: 'SEVERE', geometry: { type: 'Point', coordinates: [140, 36] }, properties: { magnitude: 5.7 } }),
    eventFrom({ id: 'event:earthquake:usgs:us2', type: 'earthquake', title: 'M2.1 earthquake — Hawaii', startAt: iso(-7_200_000), severity: 'INFO', geometry: { type: 'Point', coordinates: [-155.3, 19.4] }, properties: { magnitude: 2.1 } }),
    eventFrom({ id: 'event:weather-alert:nws:1', type: 'weather-alert', title: 'High Surf Advisory', startAt: iso(-86_400_000), endAt: iso(-3_600_000), severity: 'MINOR', geometry: { type: 'Polygon', coordinates: [[[-158.3, 21.2], [-157.6, 21.2], [-157.6, 21.8], [-158.3, 21.8], [-158.3, 21.2]]] } }),
    eventFrom({ id: 'event:source-status-change:usgs-earthquakes:1', type: 'source-status-change', title: 'USGS offline', startAt: iso(-60_000), severity: 'INFO' }),
  ];
  const src = { events: { all: () => events }, now: () => clock.now() };
  const all = executeEventQuery({}, src);
  assert.equal(all.total, 4);
  assert.deepEqual(all.items.map((e) => e.id), ['event:source-status-change:usgs-earthquakes:1', 'event:earthquake:usgs:us1', 'event:earthquake:usgs:us2', 'event:weather-alert:nws:1'], 'newest startAt first');
  assert.deepEqual(executeEventQuery({ eventTypes: ['earthquake'] }, src).items.map((e) => e.id), ['event:earthquake:usgs:us1', 'event:earthquake:usgs:us2']);
  const oahu = executeEventQuery({ region: { kind: 'circle', center: { latitude: 21.44, longitude: -158.0 }, radiusM: 60_000 } }, src);
  assert.deepEqual(oahu.items.map((e) => e.id), ['event:weather-alert:nws:1'], 'polygon alert intersects circle; events without geometry are excluded by region');
  const recent = executeEventQuery({ time: { start: iso(-5_400_000), end: iso(0) } }, src);
  assert.deepEqual(recent.items.map((e) => e.id).sort(), ['event:earthquake:usgs:us1', 'event:source-status-change:usgs-earthquakes:1', 'event:weather-alert:nws:1'], 'alert overlaps the window through endAt');
  assert.deepEqual(executeEventQuery({ filters: [{ field: 'severity', op: 'eq', value: 'SEVERE' }] }, src).items.map((e) => e.id), ['event:earthquake:usgs:us1']);
  assert.deepEqual(executeEventQuery({ filters: [{ field: 'properties.magnitude', op: 'gte', value: 2 }], sort: { field: 'properties.magnitude', direction: 'asc' } }, src).items.map((e) => e.id), ['event:earthquake:usgs:us2', 'event:earthquake:usgs:us1']);
  const limited = executeEventQuery({ limit: 1, eventTypes: ['earthquake'] }, src);
  assert.equal(limited.total, 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(executeEventQuery({ text: 'hawaii' }, src).items.map((e) => e.id), ['event:earthquake:usgs:us2'], 'text matches titles');
  assert.equal(executeEventQuery({ text: 'usgs-earthquakes' }, src).total, 1, 'text matches ids');
});

test('filters and field resolution edge cases', () => {
  assert.equal(matchesFilter('Aloha Star', { field: 'x', op: 'contains', value: 'STAR' }), true);
  assert.equal(matchesFilter(['a', 'b'], { field: 'x', op: 'contains', value: 'b' }), true);
  assert.equal(matchesFilter({ k: 1 }, { field: 'x', op: 'contains', value: 'k' }), true);
  assert.equal(matchesFilter(undefined, { field: 'x', op: 'exists' }), false);
  assert.equal(matchesFilter(undefined, { field: 'x', op: 'exists', value: false }), true);
  assert.equal(matchesFilter(undefined, { field: 'x', op: 'neq', value: 1 }), true);
  assert.equal(matchesFilter('5', { field: 'x', op: 'eq', value: 5 }), true, 'numeric strings compare numerically');
  assert.equal(matchesFilter('abc', { field: 'x', op: 'gt', value: 1 }), false);
  assert.equal(matchesFilter(3, { field: 'x', op: 'in', value: [1, 2, 3] }), true);
  assert.equal(compareValues(undefined, 1) > 0, true);
  assert.equal(compareValues('2026-09-21T00:00:00.000Z', '2026-09-20T00:00:00.000Z') > 0, true);
  assert.equal(compareValues('b', 'A') > 0, true);
  const obj: WorldObject = objectFrom({ providerId: 'p', objectType: 'aircraft', externalId: 'x', lat: 1, lon: 2, altitudeM: 300, payload: { nested: { deep: [10, 20] }, speedMps: 5 } });
  assert.equal(resolveObjectField(obj, 'properties.nested.deep.1'), 20);
  assert.equal(resolveObjectField(obj, 'position.altitudeM'), 300);
  assert.equal(resolveObjectField(obj, 'motion.speedMps'), 5);
  assert.equal(resolveObjectField(obj, 'motion.headingDegrees'), undefined);
  assert.equal(resolveObjectField(obj, 'labels.name'), undefined);
  assert.equal(resolveObjectField(obj, 'validUntil'), undefined);
});
