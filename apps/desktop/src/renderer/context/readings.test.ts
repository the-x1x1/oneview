import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JsonValue, WorldObject } from '@worldview/world-model';
import type { WorldClient } from '@worldview/ipc-contract';
import { projectReadings, resolveTelemetry, type ReadingPoint } from '@worldview/telemetry';
import history from '../../../../../fixtures/connectors/telemetry/local-sensors-history.json' with { type: 'json' };
import { contextRegistry } from './index.js';
import { ReadingsView, READING_WINDOWS } from './readings-view.js';
import {
  READINGS_SECTION_ID,
  Readings,
  historyQuery,
  objectProviders,
  readingsSection,
  readingsWindow,
} from './readings.js';
import { StoreProvider } from '../store/store.js';
import { initialState } from '../store/reducer.js';
import type { RootState } from '../store/types.js';

const WINDOW = { startMs: Date.parse('2026-09-20T00:00:00.000Z'), endMs: Date.parse('2026-09-20T06:00:00.000Z') };
const observations = history.observations as Array<{
  externalId: string;
  observedAt: string;
  payload: Record<string, JsonValue>;
}>;

/** The fixture's history of one source, as the projection reads it (history.test.ts reads it through a real store). */
function seriesOf(externalId: string, keys: string[]): Map<string, ReadingPoint[]> {
  return projectReadings(
    observations.filter((o) => o.externalId === externalId),
    externalId,
    keys,
    WINDOW,
  );
}

function objectOf(type: string, providerId: string, externalId: string): WorldObject {
  const last = observations.filter((o) => o.externalId === externalId).at(-1)!;
  return {
    id: `${type}:${providerId}:${externalId}`,
    type,
    sourceRefs: [{ observationId: 'x', providerId, observedAt: last.observedAt }],
    observedAt: last.observedAt,
    updatedAt: last.observedAt,
    freshness: 'LIVE',
    confidence: 0.9,
    labels: { name: String(last.payload['name']) },
    properties: last.payload,
    position: { latitude: 21.3069, longitude: -157.8583 },
    provenance: { providerId, sourceName: providerId, origin: 'local', receivedAt: last.observedAt },
  } as WorldObject;
}

const station = objectOf('weather-station', 'weatherlink-local', '001D0A7100A1-1');
const sensor = objectOf('sensor', 'purpleair-local', 'pa-3f-21');
const noop = () => {};

test('the panel draws the fixture station: one chart per default series, the gap broken, the value at the cursor', () => {
  const resolved = resolveTelemetry({ objectType: station.type, properties: station.properties })!;
  const keys = resolved.series.map((s) => s.key);
  assert.deepEqual(keys, ['temperatureC', 'humidityPct', 'pressureSeaLevelHpa', 'windSpeedMps']);
  const html = renderToStaticMarkup(
    createElement(ReadingsView, {
      series: resolved.series,
      data: seriesOf('001D0A7100A1-1', keys),
      window: WINDOW,
      cursorMs: Date.parse('2026-09-20T04:25:00.000Z'),
      windowMs: 6 * 3_600_000,
      onWindow: noop,
      origin: resolved.origin,
      stepMs: 600_000,
    }),
  );
  assert.equal((html.match(/<figure/g) ?? []).length, 4);
  for (const name of ['Temperature', 'Humidity', 'Pressure (sea level)', 'Wind'])
    assert.ok(html.includes(`<strong>${name}</strong>`), name);
  // The wind at the cursor is the 04:20 spike, in the format's units.
  assert.ok(html.includes('14.2 m/s at 04:20:00'), 'readout at the cursor');
  assert.ok(html.includes('1,007.8 hPa – 1,013.2 hPa'), 'the range in hPa');
  // Every series has the 03:00–04:00 gap, so each path is two sub-paths.
  const paths = [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(paths.length, 4);
  for (const d of paths) assert.equal((d.match(/M/g) ?? []).length, 2, d);
  assert.ok(html.includes('aria-pressed="true">6 h<'), 'the chosen window');
  assert.equal(READING_WINDOWS.length, 4);
  assert.ok(html.includes('At most one reading per 10m 00s'));
  assert.ok(!html.includes('No readings in this window'));
});

test('the panel shades the AQI’s limits and says when the value is past one', () => {
  const resolved = resolveTelemetry({ objectType: sensor.type, properties: sensor.properties })!;
  assert.equal(resolved.origin, 'discovered');
  const aqi = resolved.series.filter((s) => s.key === 'aqiUs');
  const html = renderToStaticMarkup(
    createElement(ReadingsView, {
      series: aqi,
      data: seriesOf('pa-3f-21', ['aqiUs']),
      window: WINDOW,
      cursorMs: WINDOW.endMs,
      windowMs: 6 * 3_600_000,
      onWindow: noop,
      origin: resolved.origin,
    }),
  );
  assert.ok(html.includes('wv-readings__band--warn'), 'warning band (100–150)');
  assert.ok(!html.includes('wv-readings__band--crit'), 'the data never reaches 150, so the range does not either');
  assert.ok(html.includes('133 at 06:00:00 · above the warning limit'));
  assert.ok(html.includes('Every number this object reports'));
});

test('an empty window says so; a series without readings says so; a failed read is admitted', () => {
  const resolved = resolveTelemetry({ objectType: station.type, properties: station.properties })!;
  const empty = new Map<string, ReadingPoint[]>();
  const props = {
    series: resolved.series,
    window: WINDOW,
    cursorMs: WINDOW.endMs,
    windowMs: 3_600_000,
    onWindow: noop,
    origin: resolved.origin,
  };
  assert.ok(
    renderToStaticMarkup(createElement(ReadingsView, { ...props, data: empty })).includes(
      'No readings in this window.',
    ),
  );
  assert.ok(
    renderToStaticMarkup(createElement(ReadingsView, { ...props, data: empty, loading: true })).includes(
      'Reading history…',
    ),
  );
  const some = new Map<string, ReadingPoint[]>([['temperatureC', [[WINDOW.startMs, 20]]]]);
  const html = renderToStaticMarkup(createElement(ReadingsView, { ...props, data: some, failed: 3 }));
  assert.ok(html.includes('No humidity readings in this window.'));
  assert.ok(html.includes('3 history reads failed'));
  assert.ok(html.includes('20.0 °C at 00:00:00'));
});

test('registered for weather stations and sensors, right after their own section; not for other types', () => {
  const ws = contextRegistry.sectionsFor('weather-station').map((s) => s.id);
  assert.equal(ws[ws.indexOf('weather-station') + 1], READINGS_SECTION_ID);
  const se = contextRegistry.sectionsFor('sensor').map((s) => s.id);
  assert.equal(se[se.indexOf('sensor') + 1], READINGS_SECTION_ID);
  assert.ok(!contextRegistry.sectionsFor('aircraft').some((s) => s.id === READINGS_SECTION_ID));
  const section = readingsSection('weather-station');
  const bare = { ...station, properties: { name: 'x', stationId: 'y' } };
  const props = { object: bare, track: [], related: { objects: [], events: [] }, sources: [], nowMs: 0 };
  assert.equal(section.render(props as never), null, 'nothing to read, no section');
  assert.notEqual(section.render({ ...props, object: station } as never), null);
});

test('the container renders inside the store: it resolves the series and waits for history', () => {
  const requests: string[] = [];
  const client = {
    request: async (channel: string) => {
      requests.push(channel);
      return null;
    },
    on: () => () => {},
  } as unknown as WorldClient;
  const state: RootState = initialState(WINDOW.endMs);
  const html = renderToStaticMarkup(
    createElement(
      StoreProvider,
      { client, initial: state },
      createElement(Readings, { object: station, nowMs: WINDOW.endMs }),
    ),
  );
  assert.ok(html.includes('Reading history…'));
  assert.ok(html.includes('aria-label="Readings window"'));
  // Until history answers, the object's own latest values are drawn.
  assert.ok(html.includes('26.0 °C at 06:00:00'));
  assert.deepEqual(requests, [], 'static rendering runs no effects');
});

test('in replay the live object’s later values are not drawn: the charts end at the cursor', () => {
  const client = { request: async () => null, on: () => () => {} } as unknown as WorldClient;
  const base: RootState = initialState(WINDOW.endMs);
  const cursorMs = Date.parse('2026-09-20T05:59:30.000Z');
  const state: RootState = {
    ...base,
    timeline: { ...base.timeline, control: { ...base.timeline.control, mode: 'REPLAY', cursorMs } },
  };
  const html = renderToStaticMarkup(
    createElement(
      StoreProvider,
      { client, initial: state },
      createElement(Readings, { object: station, nowMs: WINDOW.endMs }),
    ),
  );
  assert.ok(html.includes('Reading history…'));
  // The live 06:00 reading is inside the rounded-up window but after the cursor: nothing is drawn.
  assert.ok(!html.includes('<figure'), 'no chart from the live object in replay');
  assert.ok(
    html.includes('2026-09-20 05:00:00 UTC – 2026-09-20 06:00:00 UTC'),
    'the window rounded up past the cursor',
  );
});

test('window, providers and the history request', async () => {
  const hour = 3_600_000;
  assert.deepEqual(readingsWindow(Date.parse('2026-09-20T04:25:10.000Z'), hour), {
    startMs: Date.parse('2026-09-20T03:26:00.000Z'),
    endMs: Date.parse('2026-09-20T04:26:00.000Z'),
  });
  assert.deepEqual(readingsWindow(WINDOW.endMs, 6 * hour), WINDOW, 'an end on a slice stays put');
  assert.deepEqual(objectProviders({ ...station, sourceRefs: [...station.sourceRefs, ...station.sourceRefs] }), [
    'weatherlink-local',
  ]);
  const seen: Array<[string, unknown]> = [];
  const client = {
    request: async (channel: string, body: unknown) => {
      seen.push([channel, body]);
      return { items: [], total: 0, truncated: false, basis: 'historical', evaluatedAt: '' };
    },
  } as unknown as WorldClient;
  await historyQuery(client)({ objectTypes: ['sensor'] });
  assert.deepEqual(seen, [['history.query', { objectTypes: ['sensor'] }]]);
});
