import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import { pastLimit, readingLimitRule, type LimitedReading } from './reading-limit.js';

const T0 = Date.parse('2026-10-04T20:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function station(props: Record<string, unknown>, min: number): WorldObject {
  return {
    id: 'weather-station:weatherlink-local:roof',
    type: 'weather-station',
    labels: {},
    position: { latitude: 21.31, longitude: -157.86 },
    observedAt: at(min),
    properties: { name: 'Roof', ...props },
    confidence: 0.9,
    freshness: 'LIVE',
    sourceRefs: [{ providerId: 'weatherlink-local', observationId: `o${min}` }],
    provenance: { providerId: 'weatherlink-local', sourceName: 'WeatherLink', origin: 'local', receivedAt: at(min) },
  } as unknown as WorldObject;
}

const LIMITS: LimitedReading[] = [
  { key: 'temperatureC', name: 'Temperature', units: '°C', limits: { warnHigh: 35, critHigh: 40, warnLow: 2 } },
  { key: 'aqiUs', name: 'AQI', limits: { warnHigh: 100, critHigh: 150 } },
];

function runner(limits: LimitedReading[] = LIMITS) {
  const rule = readingLimitRule(() => limits);
  const store = new Map<string, WorldEvent>();
  return {
    store,
    step(objects: WorldObject[], min: number): WorldEvent[] {
      const out = rule.evaluate(objects, {
        now: T0 + min * 60_000,
        nowIso: at(min),
        existing: () => [...store.values()],
      });
      for (const e of out) store.set(e.id, e);
      return out;
    },
  };
}

test('reading limits: which limit a value is past, the critical one first', () => {
  const l = LIMITS[0]!.limits;
  assert.equal(pastLimit(30, l), undefined);
  assert.deepEqual(pastLimit(36, l), { side: 'high', level: 'warn', limit: 35 });
  assert.deepEqual(pastLimit(41, l), { side: 'high', level: 'crit', limit: 40 });
  assert.deepEqual(pastLimit(1, l), { side: 'low', level: 'warn', limit: 2 });
});

test('reading limits: one event per episode, rising with the reading, ended back inside with a margin', () => {
  const r = runner();
  assert.deepEqual(r.step([station({ temperatureC: 30 }, 0)], 0), [], 'inside: nothing');
  const [opened] = r.step([station({ temperatureC: 36.2 }, 5)], 5);
  assert.ok(opened);
  assert.equal(opened.type, 'reading-limit');
  assert.equal(opened.title, 'Temperature above its limit at Roof');
  assert.equal(opened.severity, 'MINOR');
  assert.match(opened.summary ?? '', /36\.2 °C, above its warning limit of 35 °C since/);
  assert.equal(opened.id, `event:reading-limit:weatherlink-local:roof.temperatureC-${(T0 + 5 * 60_000) / 1000}`);

  const [worse] = r.step([station({ temperatureC: 41 }, 10)], 10);
  assert.equal(worse?.id, opened.id, 'the same episode');
  assert.equal(worse?.severity, 'MODERATE', 'past the critical limit');
  assert.equal(worse?.properties?.['peak'], 41);

  assert.deepEqual(r.step([station({ temperatureC: 41 }, 11)], 11), [], 'nothing new: no event');
  const hovering = r.step([station({ temperatureC: 34.6 }, 15)], 15);
  assert.equal(hovering[0]?.endAt, undefined, 'just under the line is not the end (margin)');
  const [ended] = r.step([station({ temperatureC: 33 }, 20)], 20);
  assert.equal(ended?.endAt, at(20));
  assert.match(ended?.summary ?? '', /Back within the limit at 33 °C/);

  const [again] = r.step([station({ temperatureC: 37 }, 30)], 30);
  assert.notEqual(again?.id, opened.id, 'a second episode is a new event');
});

test('reading limits: the AQI is left to its own rule; no limits, nothing; a vanished reading ends it', () => {
  const r = runner();
  assert.deepEqual(r.step([station({ aqiUs: 180 }, 0)], 0), [], 'airQualityRule raises unhealthy air');
  assert.deepEqual(runner([]).step([station({ temperatureC: 50 }, 0)], 0), [], 'a source without limits');
  const [low] = r.step([station({ temperatureC: 1 }, 1)], 1);
  assert.equal(low?.title, 'Temperature below its limit at Roof');
  const [gone] = r.step([], 2);
  assert.equal(gone?.endAt, at(2), 'the station gone ends the episode');
});
