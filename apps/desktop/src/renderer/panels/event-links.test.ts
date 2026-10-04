import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent } from '@worldview/world-model';
import { aftershockSequence, eventHistory, eventLinks, eventSeries, seriesPath } from './event-links.js';

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

test('aftershock sequence: the quakes naming a mainshock, counted, the largest, newest first', () => {
  const quake = (id: string, at: string, magnitude: number | undefined, main?: string) =>
    ({
      id,
      type: 'earthquake',
      title: `quake ${id}`,
      startAt: at,
      properties: { ...(magnitude !== undefined ? { magnitude } : {}), ...(main ? { mainshockEventId: main } : {}) },
    }) as unknown as WorldEvent;
  const main = quake('event:earthquake:us:main', '2026-10-01T00:00:00Z', 7.1);
  const events = [
    main,
    quake('a1', '2026-10-01T01:00:00Z', 5.2, main.id),
    quake('a2', '2026-10-02T03:00:00Z', 6.0, main.id),
    quake('a3', '2026-10-03T05:00:00Z', undefined, main.id),
    quake('other', '2026-10-02T00:00:00Z', 4.0, 'event:earthquake:us:else'),
  ];
  const seq = aftershockSequence(main, [...events, events[1]!]);
  assert.ok(seq);
  assert.equal(seq.count, 3, 'a duplicate is counted once; another sequence is not');
  assert.deepEqual(seq.largest, { eventId: 'a2', magnitude: 6 });
  assert.equal(seq.first, '2026-10-01T01:00:00Z');
  assert.equal(seq.last, '2026-10-03T05:00:00Z');
  assert.deepEqual(
    seq.rows.map((r) => r.eventId),
    ['a3', 'a2', 'a1'],
  );
  assert.equal(aftershockSequence(events[1]!, events), undefined, 'an aftershock has none of its own');
  assert.equal(aftershockSequence({ id: 'x', type: 'storm' }, events), undefined);
});

test('event series: a fire cluster’s detections and a storm’s wind over time, oldest first', () => {
  const fire = eventSeries({
    type: 'wildfire-cluster',
    properties: {
      growth: [
        { at: '2026-10-04T06:00:00Z', count: 30 },
        { at: '2026-10-04T00:00:00Z', count: 12 },
        { at: 'not a time', count: 99 },
      ],
    },
  });
  assert.deepEqual(
    fire?.points.map((p) => p.v),
    [12, 30],
  );
  assert.equal(fire?.label, 'Detections');
  const storm = eventSeries({
    type: 'storm',
    properties: {
      track: [
        { at: '2026-10-04T00:00:00Z', intensityKt: 45 },
        { at: '2026-10-04T06:00:00Z', intensityKt: 65 },
      ],
    },
  });
  assert.equal(storm?.unit, 'kt');
  assert.equal(
    eventSeries({ type: 'storm', properties: { track: [{ at: '2026-10-04T00:00:00Z', intensityKt: 45 }] } }),
    undefined,
  );
  assert.equal(eventSeries({ type: 'earthquake', properties: {} }), undefined);
  assert.equal(
    seriesPath(
      [
        { t: 0, v: 0 },
        { t: 10, v: 10 },
      ],
      100,
      50,
    ),
    'M0.0,50.0L100.0,0.0',
    'from the bottom left to the top right',
  );
});
