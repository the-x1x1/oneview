import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import {
  compactForecastTime,
  cycloneCategory,
  cycloneLabel,
  cycloneOf,
  hazardStyle,
  saffirSimpsonCategory,
  tornadoWarningRank,
} from './storm-style.js';
import { presentObjects } from './presentation.js';
import { themeEntry } from './theme.js';

test('category from wind: NHC thresholds, each edge on the right side', () => {
  const cases: Array<[number, string]> = [
    [0, 'td'],
    [33, 'td'],
    [34, 'ts'],
    [63, 'ts'],
    [64, 'cat1'],
    [82, 'cat1'],
    [83, 'cat2'],
    [95, 'cat2'],
    [96, 'cat3'],
    [112, 'cat3'],
    [113, 'cat4'],
    [136, 'cat4'],
    [137, 'cat5'],
    [160, 'cat5'],
  ];
  for (const [kt, cat] of cases) assert.equal(cycloneCategory(kt), cat, `${kt} kt`);
  assert.equal(saffirSimpsonCategory(63), undefined, 'not a hurricane');
  assert.equal(saffirSimpsonCategory(Number.NaN), undefined);
});

test('an NHC storm: its name, category and wind in the label', () => {
  const nolo = cycloneOf({
    type: 'storm',
    properties: { name: 'Nolo', intensityKt: 125, classification: 'HU', pressureMb: 933 },
  })!;
  assert.deepEqual(nolo, { role: 'current', equivalent: false, post: false, name: 'Nolo', kt: 125, category: 'cat4' });
  assert.equal(cycloneLabel(nolo), 'Nolo · Cat 4 · 125 kt');
  assert.equal(
    cycloneLabel(cycloneOf({ type: 'storm', properties: { name: 'Polo', intensityKt: 100 } })!),
    'Polo · Cat 3 · 100 kt',
  );
  // 115 kt is Category 4 (113 kt and up), not 3: the thresholds are NHC's.
  assert.equal(cycloneCategory(115), 'cat4');
  assert.equal(
    cycloneLabel(cycloneOf({ type: 'storm', properties: { name: 'Fay', intensityKt: 30 } })!),
    'Fay · TD · 30 kt',
  );
  // No wind in the file: the classification decides, and the label says only what is known.
  assert.equal(
    cycloneLabel(cycloneOf({ type: 'storm', properties: { name: 'Hanna', classification: 'TS' } })!),
    'Hanna · TS',
  );
  assert.equal(
    cycloneLabel(cycloneOf({ type: 'storm', properties: { name: 'Ida', classification: 'PTC', intensityKt: 45 } })!),
    'Ida · Post-tropical · 45 kt',
  );
});

test('a GDACS cyclone: km/h to knots, the category an equivalent, the wind its peak', () => {
  const c = cycloneOf({
    type: 'weather-alert',
    properties: { gdacsEventType: 'TC', maxWindKmh: 231.5 },
    labels: { name: 'SAMPLE-26' },
  })!;
  assert.equal(c.kt, 125);
  assert.equal(c.category, 'cat4');
  assert.equal(c.peak, true, "GDACS gives the storm's maximum, not its wind now");
  assert.equal(cycloneLabel(c), 'SAMPLE-26 · peak Cat 4 eq., 125 kt');
  assert.equal(cycloneOf({ type: 'weather-alert', properties: { gdacsEventType: 'EQ' } }), undefined);
});

test('forecast positions: NHC time label compacted, with the category and wind at that time', () => {
  assert.equal(compactForecastTime('8:00 AM Tue', 'HST'), 'Tue 8 AM HST');
  assert.equal(compactForecastTime('12:30 PM Wed', 'CST'), 'Wed 12:30 PM CST');
  assert.equal(compactForecastTime('tomorrow', 'CST'), 'tomorrow CST');
  const point = cycloneOf({
    type: 'weather-alert',
    properties: {
      cycloneLayer: 'forecast-point',
      stormName: 'Hurricane Nolo',
      intensityKt: 110,
      stormType: 'MH',
      forecastTime: '8:00 AM Tue',
      timeZone: 'HST',
    },
  })!;
  assert.equal(point.role, 'forecast');
  assert.equal(cycloneLabel(point), 'Tue 8 AM HST · Cat 3 · 110 kt');
  const post = cycloneOf({
    type: 'weather-alert',
    properties: { cycloneLayer: 'forecast-point', intensityKt: 30, stormType: 'LO', forecastTime: '2:00 PM Thu' },
  })!;
  assert.equal(cycloneLabel(post), 'Thu 2 PM · Post-tropical · 30 kt');
});

test('past track: coloured by the category it was drawn at; before it formed, grey; no label', () => {
  const seg = (trackCategory: string, stormType: string) =>
    hazardStyle({ type: 'weather-alert', properties: { cycloneLayer: 'past-track', trackCategory, stormType } });
  assert.equal(seg('4', 'HU')?.styleClass, 'storm.cat4');
  assert.equal(seg('0', 'TS')?.styleClass, 'storm.ts');
  assert.equal(seg('0', 'DB')?.styleClass, 'storm.weak');
  assert.equal(seg('0', 'TD')?.label, undefined);
});

test('wind field rings and tornadoes', () => {
  const ring = (windRadiiKt: number) =>
    hazardStyle({ type: 'weather-alert', properties: { cycloneLayer: 'wind-field', windRadiiKt } })?.styleClass;
  assert.deepEqual([ring(34), ring(50), ring(64)], ['storm.wind-34', 'storm.wind-50', 'storm.wind-64']);
  const warning = (alertKind: string) => ({ type: 'weather-alert', properties: { alertKind } });
  assert.equal(tornadoWarningRank(warning('tornado-emergency')), 3);
  assert.equal(tornadoWarningRank(warning('tornado-pds')), 2);
  assert.equal(tornadoWarningRank(warning('tornado-warning')), 1);
  assert.equal(tornadoWarningRank(warning('tornado-watch')), 0, 'a watch is not a warning');
  assert.equal(hazardStyle(warning('tornado-warning'))?.icon, 'tornado');
  assert.equal(hazardStyle(warning('severe-thunderstorm-warning')), undefined);
  assert.equal(hazardStyle({ type: 'weather-alert', properties: { reportType: 'Funnel Cloud' } })?.icon, 'tornado');
  assert.equal(hazardStyle({ type: 'weather-alert', properties: { reportType: 'Hail' } }), undefined);
});

test('every class a storm can be drawn in has its own theme colour', () => {
  for (const c of ['td', 'ts', 'cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'post', 'weak', 'wind-34', 'wind-50', 'wind-64'])
    assert.notEqual(themeEntry(`storm.${c}`), themeEntry('storm'), c);
  const colours = new Set(
    ['td', 'ts', 'cat1', 'cat2', 'cat3', 'cat4', 'cat5'].map((c) => themeEntry(`storm.${c}`).color),
  );
  assert.equal(colours.size, 7);
});

const base = (id: string, type: string, properties: Record<string, unknown>, lat = 20, lon = -160): WorldObject =>
  ({
    id,
    type,
    labels: {},
    properties,
    position: { latitude: lat, longitude: lon },
    freshness: 'LIVE',
    observedAt: '2026-09-28T21:00:00.000Z',
    updatedAt: '2026-09-28T21:00:00.000Z',
    sourceIds: [],
    confidence: 1,
  }) as unknown as WorldObject;

test('presentation: a hurricane is its glyph and label at global zoom; a tornado warning outranks it', () => {
  const view = {
    center: { latitude: 0, longitude: 0 },
    zoom: 1.5,
    altitudeM: 2e7,
    headingDegrees: 0,
    pitchDegrees: -90,
  };
  const nolo = base('storm:nhc-storms:ep152026', 'storm', { name: 'Nolo', intensityKt: 125, classification: 'HU' });
  const tornado = base('weather-alert:weather:t1', 'weather-alert', { alertKind: 'tornado-warning' }, 35, -97);
  const frost = base('weather-alert:weather:f1', 'weather-alert', { severity: 'MINOR' }, 35, -96);
  const r = presentObjects({ objects: [nolo, tornado, frost], view, cullToView: false });
  const byId = new Map(r.upsert.map((f) => [f.objectId, f]));
  const n = byId.get(nolo.id)!;
  assert.equal(n.style.icon, 'cyclone');
  assert.equal(n.style.styleClass, 'storm.cat4');
  assert.equal(n.style.label, 'Nolo · Cat 4 · 125 kt');
  assert.equal(n.style.rotationDegrees, undefined);
  const t = byId.get(tornado.id)!;
  assert.equal(t.style.icon, 'tornado', 'a sprite in markers mode');
  assert.ok(t.priority > n.priority, 'the tornado warning is above the hurricane');
  assert.ok(n.priority > byId.get(frost.id)!.priority);
  assert.equal(byId.get(frost.id)!.style.icon, undefined, 'an ordinary alert stays a marker at this zoom');
});

test('presentation: an event its object already draws is not drawn again, unless selected', () => {
  const view = {
    center: { latitude: 0, longitude: 0 },
    zoom: 1.5,
    altitudeM: 2e7,
    headingDegrees: 0,
    pitchDegrees: -90,
  };
  const nolo = base('storm:nhc-storms:ep152026', 'storm', { name: 'Nolo', intensityKt: 125 });
  const event = {
    id: 'event:storm:nhc-storms:ep152026',
    type: 'storm',
    title: 'Hurricane Nolo (Category 4)',
    objectIds: [nolo.id],
    geometry: { type: 'Point', coordinates: [-160, 20] },
  } as never;
  const drawn = presentObjects({ objects: [nolo], events: [event], view, cullToView: false });
  assert.ok(!drawn.upsert.some((f) => f.eventId), 'the glyph is the storm');
  const alone = presentObjects({ objects: [], events: [event], view, cullToView: false });
  assert.equal(alone.upsert.filter((f) => f.eventId).length, 1, 'no object drawn: the event stands in');
  const chosen = presentObjects({
    objects: [nolo],
    events: [event],
    view,
    cullToView: false,
    selectedId: 'event:storm:nhc-storms:ep152026',
  });
  assert.equal(chosen.upsert.filter((f) => f.eventId).length, 1);
});

test('presentation: at the minimal detail level an alert is a point, so its event still draws the polygon', () => {
  const view = {
    center: { latitude: 0, longitude: 0 },
    zoom: 1.5,
    altitudeM: 2e7,
    headingDegrees: 0,
    pitchDegrees: -90,
  };
  const warning = {
    ...base('weather-alert:weather:t1', 'weather-alert', { alertKind: 'tornado-warning' }, 35, -97),
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-97, 35],
          [-96.8, 35],
          [-96.8, 35.2],
          [-97, 35],
        ],
      ],
    },
  } as unknown as WorldObject;
  const event = {
    id: 'event:weather-alert:weather:t1',
    type: 'weather-alert',
    title: 'Tornado Warning',
    objectIds: [warning.id],
    geometry: warning.geometry,
  } as never;
  const full = presentObjects({ objects: [warning], events: [event], view, cullToView: false });
  assert.ok(full.upsert.some((f) => f.id.endsWith(':geometry')));
  assert.ok(!full.upsert.some((f) => f.eventId));
  const minimal = presentObjects({ objects: [warning], events: [event], view, cullToView: false, detail: 2 });
  assert.ok(!minimal.upsert.some((f) => f.id.endsWith(':geometry')));
  assert.equal(minimal.upsert.filter((f) => f.eventId).length, 1);
});
