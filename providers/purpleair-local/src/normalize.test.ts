import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PURPLEAIR_LOCAL_MANIFEST } from './manifest.js';
import { combineChannels, normalizeSensorJson, parseSensorTime, sensorKey } from './normalize.js';
import { parsePurpleAirSettings, sensorEndpoint } from './index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'purpleair-local',
);
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const NOW = Date.parse('2026-09-23T20:00:00Z');
const opts = { receivedAt: '2026-09-23T20:00:00.000Z', nowMs: NOW, name: 'Porch' };
const run = (name: string, extra: Partial<Parameters<typeof normalizeSensorJson>[2]> = {}) =>
  normalizeSensorJson(load(name), PURPLEAIR_LOCAL_MANIFEST, { ...opts, ...extra });

test('the sensor’s time and id: the firmware’s form and ISO 8601; a MAC address in any spelling', () => {
  assert.equal(parseSensorTime('2026/09/23T19:58:10z'), Date.parse('2026-09-23T19:58:10Z'));
  assert.equal(parseSensorTime('2026-09-23T19:58:10Z'), Date.parse('2026-09-23T19:58:10Z'));
  assert.equal(parseSensorTime('2026-09-23 19:58'), undefined);
  assert.equal(sensorKey('68:C6:3A:8E:5A:1B'), '68c63a8e5a1b');
  assert.equal(sensorKey('68-c6-3a-8e-5a-1b'), '68c63a8e5a1b');
  assert.equal(sensorKey('not-a-mac'), undefined);
});

test('two laser channels: averaged; far apart by 5 µg/m³ and 70 % they disagree; one alone is single', () => {
  const both = combineChannels(4.6, 5.12)!;
  assert.ok(Math.abs(both.value - 4.86) < 1e-9 && both.agreement === 'agree');
  assert.equal(combineChannels(62.4, 8.9)!.agreement, 'disagree');
  assert.equal(combineChannels(40, 30)!.agreement, 'agree', '10 apart but only 29 %');
  assert.equal(combineChannels(3, 0.5)!.agreement, 'agree', '143 % but only 2.5 apart');
  assert.deepEqual(combineChannels(undefined, 7), { value: 7, agreement: 'single' });
  assert.equal(combineChannels(undefined, undefined), undefined);
});

test('an outdoor sensor: ATM, both channels, the device’s own AQI; nothing about the network is kept', () => {
  const r = run('normal.json');
  assert.ok('observation' in r);
  const o = r.observation;
  assert.equal(o.externalId, '68c63a8e5a1b');
  assert.equal(o.objectType, 'sensor');
  assert.deepEqual(o.payload, {
    name: 'Porch',
    sensorId: '68c63a8e5a1b',
    sensorKind: 'air-quality',
    pm25Ugm3: 4.9,
    pmEstimate: 'ATM',
    channels: 'agree',
    placement: 'outdoor',
    pm25AUgm3: 4.6,
    pm25BUgm3: 5.1,
    pm10Ugm3: 5.8,
    pm1Ugm3: 3.1,
    aqiUs: 20,
    temperatureC: 31.1,
    humidityPct: 49,
    dewPointC: 18.9,
    pressureHpa: 1012.4,
  });
  assert.equal(o.quality.flags, undefined);
});

test('smoke on one laser only: flagged, both kept', () => {
  const r = run('disagree.json');
  assert.ok('observation' in r);
  assert.equal(r.observation.payload['channels'], 'disagree');
  assert.deepEqual(r.observation.quality.flags, ['channels-disagree']);
  assert.equal(r.observation.payload['pm25AUgm3'], 62.4);
  assert.equal(r.observation.payload['pm25BUgm3'], 8.9);
});

test('an indoor sensor: CF=1, flagged indoor; with no position of its own it needs one from settings', () => {
  assert.match(String((run('indoor.json') as { error: string }).error), /set its latitude and longitude/);
  const r = run('indoor.json', { position: { latitude: 21.3, longitude: -157.85 } });
  assert.ok('observation' in r);
  assert.equal(r.observation.payload['pmEstimate'], 'CF=1');
  assert.equal(r.observation.payload['placement'], 'indoor');
  assert.deepEqual(r.observation.quality.flags, ['indoor']);
  assert.deepEqual(r.observation.position, { latitude: 21.3, longitude: -157.85 });
});

test('a sensor just started has nothing to show; a clock ahead, a bad id or the wrong device is refused', () => {
  assert.deepEqual(run('empty.json'), { error: 'no PM2.5 reading' });
  assert.match(String((run('malformed-rows.json') as { error: string }).error), /SensorId/);
  assert.match(String((run('malformed-shape.json') as { error: string }).error), /SensorId/);
  const ahead = normalizeSensorJson(
    { ...(load('normal.json') as object), DateTime: '2026/09/23T23:00:00z' },
    PURPLEAIR_LOCAL_MANIFEST,
    opts,
  );
  assert.match(String((ahead as { error: string }).error), /future/);
  const noTime = normalizeSensorJson(
    { ...(load('normal.json') as object), DateTime: 'soon' },
    PURPLEAIR_LOCAL_MANIFEST,
    opts,
  );
  assert.ok('observation' in noTime);
  assert.equal(noTime.observation.observedAt, '2026-09-23T20:00:00.000Z', 'dated when fetched');
  assert.deepEqual(noTime.observation.quality.flags, ['fetch-time']);
});

test('settings: the address is required; a position is both numbers or neither', () => {
  assert.equal(sensorEndpoint(parsePurpleAirSettings({})).ok, false);
  assert.deepEqual(sensorEndpoint(parsePurpleAirSettings({ host: '192.168.1.60' })), {
    ok: true,
    url: 'http://192.168.1.60/json',
    host: '192.168.1.60',
    trusted: true,
  });
  assert.equal(parsePurpleAirSettings({ latitude: 21.3 }).latitude, undefined, 'half a position is none');
  assert.deepEqual(parsePurpleAirSettings({ latitude: 21.3, longitude: -157.8, name: 'Porch' }), {
    name: 'Porch',
    latitude: 21.3,
    longitude: -157.8,
  });
});
