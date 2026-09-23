import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import { airQualityRule, aqiCategoryName, aqiSeverity } from './air-quality.js';

const T0 = Date.parse('2026-09-23T20:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function sensor(aqi: number | undefined, min: number, extra: Record<string, unknown> = {}): WorldObject {
  return {
    id: 'sensor:purpleair-local:68c63a8e5a1b',
    type: 'sensor',
    labels: { name: 'Porch' },
    position: { latitude: 21.31, longitude: -157.86 },
    observedAt: at(min),
    properties: {
      sensorKind: 'air-quality',
      channels: 'agree',
      pm25Ugm3: 60.1,
      ...(aqi === undefined ? {} : { aqiUs: aqi }),
      ...extra,
    },
    confidence: 0.9,
    freshness: 'LIVE',
    sourceRefs: [{ providerId: 'purpleair-local', observationId: `o${min}` }],
    provenance: { providerId: 'purpleair-local', sourceName: 'PurpleAir', origin: 'local', receivedAt: at(min) },
  } as unknown as WorldObject;
}

/** Run the rule like the engine does: each result replaces the stored event of its id. */
function runner() {
  const store = new Map<string, WorldEvent>();
  return {
    store,
    step(objects: WorldObject[], min: number): WorldEvent[] {
      const out = airQualityRule.evaluate(objects, {
        now: T0 + min * 60_000,
        nowIso: at(min),
        existing: () => [...store.values()],
      });
      for (const e of out) store.set(e.id, e);
      return out;
    },
  };
}

test('the EPA categories and the severity that follows them', () => {
  assert.deepEqual(
    [20, 75, 101, 151, 201, 301].map((a) => [aqiCategoryName(a), aqiSeverity(a)]),
    [
      ['Good', 'MINOR'],
      ['Moderate', 'MINOR'],
      ['Unhealthy for sensitive groups', 'MINOR'],
      ['Unhealthy', 'MODERATE'],
      ['Very unhealthy', 'SEVERE'],
      ['Hazardous', 'EXTREME'],
    ],
  );
});

test('an episode: raised at 101, follows the reading with its peak, ends at 90 or below — not at 100', () => {
  const r = runner();
  assert.deepEqual(r.step([sensor(85, 0)], 0), [], 'moderate air raises nothing');
  const [raised] = r.step([sensor(154, 2)], 2);
  assert.ok(raised);
  assert.equal(raised.id, `event:air-quality:purpleair-local:68c63a8e5a1b-${(T0 + 120_000) / 1000}`);
  assert.equal(raised.title, 'Unhealthy air at Porch');
  assert.equal(raised.severity, 'MODERATE');
  assert.equal(raised.startAt, at(2));
  assert.deepEqual(raised.geometry, { type: 'Point', coordinates: [-157.86, 21.31] });

  const [worse] = r.step([sensor(212, 4)], 4);
  assert.equal(worse!.id, raised.id, 'the same episode');
  assert.equal(worse!.severity, 'SEVERE');
  assert.equal(worse!.title, 'Very unhealthy air at Porch');
  assert.deepEqual(r.step([sensor(212, 6)], 6), [], 'nothing visible changed: no update');

  const [better] = r.step([sensor(120, 8)], 8);
  assert.equal(better!.properties!['peakAqi'], 212);
  assert.match(better!.summary!, /peak 212/);
  assert.deepEqual(
    r.step([sensor(97, 10)], 10).map((e) => e.endAt),
    [undefined],
    'at 97 the episode is still open (it moved, so it updates)',
  );
  const [ended] = r.step([sensor(88, 12)], 12);
  assert.equal(ended!.endAt, at(12));
  assert.match(ended!.summary!, /Cleared at AQI 88/);

  const [again] = r.step([sensor(130, 30)], 30);
  assert.notEqual(again!.id, raised.id, 'a second episode is a new event');
});

test('one laser alone is not trusted: a disagreeing reading neither raises nor ends', () => {
  const r = runner();
  assert.deepEqual(r.step([sensor(180, 0, { channels: 'disagree' })], 0), []);
  const [raised] = r.step([sensor(180, 2)], 2);
  assert.ok(raised);
  assert.deepEqual(r.step([sensor(40, 4, { channels: 'disagree' })], 4), [], 'kept open');
  assert.equal(r.step([sensor(40, 6)], 6)[0]!.endAt, at(6));
});

test('a sensor that goes away ends its episode; other sensor kinds are not air', () => {
  const r = runner();
  r.step([sensor(160, 0)], 0);
  const [ended] = r.step([], 5);
  assert.equal(ended!.endAt, at(5));
  assert.deepEqual(r.step([sensor(300, 6, { sensorKind: 'river-gauge' })], 6), []);
  const indoor = runner().step([sensor(155, 0, { placement: 'indoor' })], 0);
  assert.equal(indoor[0]!.title, 'Unhealthy air at Porch (indoors)');
});
