import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_TELEMETRY_SERIES,
  TELEMETRY_FORMATS,
  telemetryDescriptorSchema,
  type TelemetryDescriptor,
} from '@worldview/provider-sdk';
import {
  DEFAULT_READINGS,
  FORMAT_RULES,
  KNOWN_READINGS,
  MAX_SERIES,
  discoverReadings,
  formatReading,
  gapThreshold,
  limitBands,
  limitState,
  readingAt,
  readingsPath,
  resolveTelemetry,
  valueRange,
  type ReadingPoint,
} from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the package stays importable by the renderer: nothing from the provider SDK at run time, no Node built-ins', () => {
  const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.ok(files.length >= 6, files.join(', '));
  let seen = 0;
  for (const file of files) {
    const text = readFileSync(path.join(here, file), 'utf8');
    const imports = [
      ...[...text.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)].map((m) => ({
        typeOnly: Boolean(m[1]),
        spec: m[2]!,
      })),
      ...[...text.matchAll(/^import\s+'([^']+)'/gm)].map((m) => ({ typeOnly: false, spec: m[1]! })),
      ...[...text.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]/g)].map((m) => ({
        typeOnly: false,
        spec: m[1]!,
      })),
    ];
    for (const { typeOnly, spec } of imports) {
      seen++;
      assert.ok(!spec.startsWith('node:'), `${file} imports ${spec}`);
      if (spec === '@worldview/provider-sdk') assert.ok(typeOnly, `${file} imports the provider SDK at run time`);
      assert.ok(
        spec.startsWith('./') || spec === '@worldview/provider-sdk' || spec === '@worldview/world-model',
        `${file} imports ${spec}`,
      );
    }
  }
  assert.ok(seen >= 12, `read ${seen} import lines`);
});

test('the copies of the SDK’s limits agree with it', () => {
  assert.equal(MAX_SERIES, MAX_TELEMETRY_SERIES);
});

test('the known readings and the defaults are valid descriptors, and every default key is a known one', () => {
  const known: TelemetryDescriptor = { series: Object.entries(KNOWN_READINGS).map(([key, s]) => ({ key, ...s })) };
  assert.ok(known.series.length <= MAX_SERIES);
  const parsed = telemetryDescriptorSchema.parse(known);
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? '' : parsed.issues));
  for (const [type, entries] of Object.entries(DEFAULT_READINGS))
    for (const alternatives of entries)
      for (const key of alternatives) assert.ok(KNOWN_READINGS[key], `${type}: ${key} is not a known reading`);
});

test('every SDK format has a rule, and values read as the panel shows them', () => {
  assert.deepEqual(Object.keys(FORMAT_RULES).sort(), [...TELEMETRY_FORMATS].sort());
  assert.equal(formatReading(21.44, { format: 'celsius' }), '21.4 °C');
  assert.equal(formatReading(63.4, { format: 'percent' }), '63 %');
  assert.equal(formatReading(250, { format: 'degrees' }), '250°');
  assert.equal(formatReading(1013.25, { format: 'hpa' }), '1,013.3 hPa');
  assert.equal(formatReading(3.7, { format: 'volts' }), '3.70 V');
  assert.equal(formatReading(-0.04, { format: 'celsius' }), '0.0 °C');
  assert.equal(formatReading(12.345, {}), '12.35');
  assert.equal(formatReading(12, { units: 'mm' }), '12 mm');
  assert.equal(formatReading(1.5, { format: 'number:0', units: 'lx' }), '2 lx');
  assert.equal(formatReading(18.2, { format: 'ugm3', units: 'µg/m3' }), '18.2 µg/m3', 'the series’ units win');
  assert.equal(formatReading(Number.NaN, { format: 'celsius' }), '—');
});

test('limits: a value on a limit is inside it; critical wins over warning', () => {
  const limits = { critLow: 0, warnLow: 5, warnHigh: 30, critHigh: 35 };
  assert.equal(limitState(30, limits), 'normal');
  assert.equal(limitState(30.1, limits), 'warn-high');
  assert.equal(limitState(35.1, limits), 'crit-high');
  assert.equal(limitState(4, limits), 'warn-low');
  assert.equal(limitState(-1, limits), 'crit-low');
  assert.equal(limitState(99, undefined), 'normal');
  assert.equal(limitState(101, { warnHigh: 100 }), 'warn-high');
});

const station = {
  name: 'Back garden',
  stationId: '001D0A7100A1',
  temperatureC: 24.1,
  humidityPct: 58,
  pressureHpa: 1009.9,
  windSpeedMps: 2.4,
  transmitterId: 1,
  batteryLow: false,
};

test('resolution: the source’s descriptor first, only keys the object carries, first provider wins a key', () => {
  const a: TelemetryDescriptor = {
    series: [
      { key: 'temperatureC', name: 'Air temperature', format: 'celsius', limits: { warnHigh: 32 } },
      { key: 'soilMoisturePct', name: 'Soil', format: 'percent' },
    ],
  };
  const b: TelemetryDescriptor = {
    series: [
      { key: 'temperatureC', name: 'Other' },
      { key: 'windSpeedMps', name: 'Wind' },
    ],
  };
  const r = resolveTelemetry({
    objectType: 'weather-station',
    properties: station,
    sourceDescriptors: [undefined, a, b],
  });
  assert.equal(r?.origin, 'source');
  assert.deepEqual(
    r?.series.map((s) => [s.key, s.name]),
    [
      ['temperatureC', 'Air temperature'],
      ['windSpeedMps', 'Wind'],
    ],
  );
  // A descriptor none of whose keys the object carries falls through to the default.
  const none = resolveTelemetry({
    objectType: 'weather-station',
    properties: station,
    sourceDescriptors: [{ series: [{ key: 'soilMoisturePct', name: 'Soil' }] }],
  });
  assert.equal(none?.origin, 'default');
});

test('resolution: the weather-station default takes the first pressure the station reports', () => {
  const r = resolveTelemetry({ objectType: 'weather-station', properties: station });
  assert.equal(r?.origin, 'default');
  assert.deepEqual(
    r?.series.map((s) => s.key),
    ['temperatureC', 'humidityPct', 'pressureHpa', 'windSpeedMps'],
  );
  const sea = resolveTelemetry({
    objectType: 'weather-station',
    properties: { ...station, pressureSeaLevelHpa: 1015 },
  });
  assert.ok(sea?.series.some((s) => s.key === 'pressureSeaLevelHpa'));
  assert.ok(!sea?.series.some((s) => s.key === 'pressureHpa'));
});

test('resolution: a sensor’s numbers are its readings — known keys named, others by key, ids and coordinates not', () => {
  const r = resolveTelemetry({
    objectType: 'sensor',
    properties: {
      sensorId: 'pa-3f-21',
      pm25Ugm3: 12.1,
      aqiUs: 51,
      latitude: 21.3,
      transmitterId: 4,
      id: 7,
      sensor_index: 131075,
      timestamp: 1790000000,
      uptimeMs: 86400000,
      lastSeenAt: 5,
      elevationM: 12,
      humid: 3,
      lux: 320,
      state: 'ok',
      nan: Number.NaN,
      'bad key': 1,
      channels: 'agree',
    },
  });
  assert.equal(r?.origin, 'discovered');
  assert.deepEqual(
    r?.series.map((s) => [s.key, s.name]),
    [
      ['pm25Ugm3', 'PM2.5'],
      ['aqiUs', 'AQI (US EPA)'],
      ['humid', 'humid'],
      ['lux', 'lux'],
    ],
  );
  // A rain gauge (a weather station none of whose defaults it carries) is discovered too.
  const gauge = resolveTelemetry({ objectType: 'weather-station', properties: { gaugeId: 'MAN-01', rainMm24h: 3.2 } });
  assert.deepEqual(
    gauge?.series.map((s) => s.key),
    ['rainMm24h'],
  );
  // Other types show nothing unless a source describes them.
  assert.equal(resolveTelemetry({ objectType: 'vehicle', properties: { batteryPct: 80 } }), undefined);
  assert.equal(resolveTelemetry({ objectType: 'sensor', properties: { state: 'ok' } }), undefined);
  const tracked = resolveTelemetry({
    objectType: 'vehicle',
    properties: { batteryPct: 80 },
    sourceDescriptors: [{ series: [{ key: 'batteryPct', name: 'Battery', format: 'percent' }] }],
  });
  assert.equal(tracked?.origin, 'source');
});

test('discovery caps at 32 series and every discovered descriptor passes the SDK schema', () => {
  const many: Record<string, number> = {};
  for (let i = 0; i < 50; i++) many[`reading_${i}`] = i;
  const found = discoverReadings(many);
  assert.equal(found.length, MAX_SERIES);
  assert.ok(telemetryDescriptorSchema.parse({ series: found }).ok);
});

test('value range: fixed ends from the descriptor, the data elsewhere, a flat series padded', () => {
  const pts: ReadingPoint[] = [
    [0, 10],
    [1, 20],
  ];
  assert.deepEqual(valueRange(pts, {}), { min: 10, max: 20 });
  assert.deepEqual(valueRange(pts, { min: 0, max: 100 }), { min: 0, max: 100 });
  assert.deepEqual(valueRange(pts, { min: 0 }), { min: 0, max: 20 });
  assert.deepEqual(valueRange([[0, 50]], {}), { min: 47.5, max: 52.5 });
  assert.deepEqual(valueRange([[0, 0]], {}), { min: -1, max: 1 });
  assert.equal(valueRange([], {}), undefined);
  assert.deepEqual(valueRange([], { min: 0, max: 100 }), { min: 0, max: 100 });
  // Data entirely beyond a one-sided fixed end never inverts the range.
  assert.deepEqual(
    valueRange(
      [
        [0, -5],
        [1, -1],
      ],
      { min: 0 },
    ),
    { min: 0, max: 1 },
  );
  assert.deepEqual(
    valueRange(
      [
        [0, 120],
        [1, 130],
      ],
      { max: 100 },
    ),
    { min: 95, max: 100 },
  );
});

test('path: time across, value up, a break after a gap, values outside a fixed range clamped', () => {
  const window = { startMs: 0, endMs: 100 };
  const pts: ReadingPoint[] = [
    [0, 0],
    [10, 50],
    [20, 100],
    [80, 150],
    [90, 50],
  ];
  assert.equal(
    readingsPath(pts, { min: 0, max: 100 }, window, 100, 10, 30),
    'M0.0,10.0L10.0,5.0L20.0,0.0M80.0,0.0L90.0,5.0',
  );
  assert.equal(readingsPath([[5, 1]], { min: 1, max: 1 }, window, 100, 10), 'M5.0,5.0');
  assert.equal(gapThreshold(pts, 1), 30);
  assert.equal(gapThreshold(pts.slice(0, 2)), Number.POSITIVE_INFINITY);
});

test('reading at: the last reading at or before a moment', () => {
  const pts: ReadingPoint[] = [
    [10, 1],
    [20, 2],
    [30, 3],
  ];
  assert.equal(readingAt(pts, 5), undefined);
  assert.deepEqual(readingAt(pts, 20), [20, 2]);
  assert.deepEqual(readingAt(pts, 29), [20, 2]);
  assert.deepEqual(readingAt(pts, 99), [30, 3]);
});

test('limit bands: warning between the limits, critical beyond, clipped to the drawn range', () => {
  const bands = limitBands({ warnHigh: 100, critHigh: 150 }, { min: 0, max: 200 }, 100);
  assert.deepEqual(bands, [
    { kind: 'crit', y: 0, height: 25 },
    { kind: 'warn', y: 25, height: 25 },
  ]);
  // A range entirely below the warning limit shows no band; a lone low limit shades to the floor.
  assert.deepEqual(limitBands({ warnHigh: 100, critHigh: 150 }, { min: 0, max: 80 }, 100), []);
  assert.deepEqual(limitBands({ warnLow: 5 }, { min: 0, max: 10 }, 100), [{ kind: 'warn', y: 50, height: 50 }]);
  assert.deepEqual(limitBands(undefined, { min: 0, max: 10 }, 100), []);
});
