import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventHistory, eventLinks } from './event-links.js';

test('an event lists the events it names: its replacement, what it replaces, its mainshock', () => {
  assert.deepEqual(eventLinks({}), []);
  assert.deepEqual(eventLinks({ properties: { supersededBy: 'event:weather-alert:nws-alerts:2' } }), [
    { label: 'Replaced by a later message', eventId: 'event:weather-alert:nws-alerts:2' },
  ]);
  assert.deepEqual(
    eventLinks({ properties: { supersedes: ['a', 'b'] } }).map((l) => l.label),
    ['Replaces earlier message 1', 'Replaces earlier message 2'],
  );
  assert.deepEqual(eventLinks({ properties: { mainshockEventId: 'event:earthquake:usgs:m' } }), [
    { label: 'Aftershock of', eventId: 'event:earthquake:usgs:m' },
  ]);
  assert.deepEqual(eventLinks({ properties: { supersedes: 'not a list', supersededBy: 3 } }), []);
});

test('an event’s own history: a storm’s track and a fire’s growth, newest first', () => {
  const storm = eventHistory({
    type: 'storm',
    properties: {
      track: [
        { at: '2026-09-22T15:00:00.000Z', latitude: 15.2, longitude: -130.1, intensityKt: 50, classification: 'TS' },
        { at: '2026-09-23T15:00:00.000Z', latitude: 16, longitude: -127.9, intensityKt: 65, classification: 'HU' },
        { at: 'bad' },
      ],
    },
  });
  assert.deepEqual(storm.rows, [
    { at: '2026-09-23T15:00:00.000Z', text: 'HU · 65 kt · 16.0°N 127.9°W' },
    { at: '2026-09-22T15:00:00.000Z', text: 'TS · 50 kt · 15.2°N 130.1°W' },
  ]);
  const fire = eventHistory({
    type: 'wildfire-cluster',
    properties: {
      growth: Array.from({ length: 15 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 8, 23, i)).toISOString(),
        count: i + 1,
        areaKm2: i,
      })),
    },
  });
  assert.equal(fire.rows.length, 12);
  assert.equal(fire.earlier, 3);
  assert.equal(fire.rows[0]!.text, '15 detections · 14 km²');
  assert.equal(fire.rows[11]!.text, '4 detections · 3 km²');
  assert.deepEqual(eventHistory({ type: 'earthquake', properties: {} }), { rows: [], earlier: 0 });
});
