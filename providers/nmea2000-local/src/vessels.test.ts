import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aisDraft, OwnVessel, POSITION_SOURCE_HOLD_MS, READING_TTL_MS, StaticStore, staticInfo } from './vessels.js';

const T0 = Date.parse('2026-10-05T12:00:00Z');
const opts = { externalId: 'own-vessel', name: 'Own vessel' };

test('the boat: position, course, heading made true with the variation, depth, wind, temperatures', () => {
  const v = new OwnVessel();
  assert.equal(v.draft(T0, opts), undefined, 'nothing until a position is heard');
  v.update({ kind: 'position', latitude: 21.3, longitude: -157.9 }, 3, T0);
  v.update({ kind: 'course', courseDeg: 123.4, magnetic: false, speedMps: 3.21 }, 3, T0);
  v.update({ kind: 'heading', headingDeg: 210.5, magnetic: true, variationDeg: 9.7 }, 5, T0);
  v.update({ kind: 'depth', depthM: 12.34, offsetM: 0.5 }, 35, T0);
  v.update({ kind: 'speed', throughWaterMps: 2.85 }, 35, T0);
  v.update({ kind: 'wind', reference: 2, speedMps: 7.5, angleDeg: 42 }, 9, T0);
  v.update({ kind: 'wind', reference: 1, speedMps: 6.1, angleDeg: 265 }, 9, T0);
  v.update({ kind: 'environment', waterTemperatureC: 18.55, airTemperatureC: 22.1, pressureHpa: 1013 }, 35, T0);
  const d = v.draft(T0 + 500, { ...opts, mmsi: '366123456' })!;
  assert.equal(d.objectType, 'vessel');
  assert.deepEqual(d.position, { latitude: 21.3, longitude: -157.9, altitudeM: 0, altitudeDatum: 'sea-surface' });
  const p = d.payload;
  assert.equal(p['ownVessel'], true);
  assert.equal(p['mmsi'], '366123456');
  assert.equal(p['flag'], 'United States', 'flag from the MMSI');
  assert.equal(p['speedMps'], 3.21);
  assert.equal(p['courseDegrees'], 123.4);
  assert.equal(p['headingDegrees'], 220.2, 'magnetic 210.5 + 9.7 E');
  assert.equal(p['depthM'], 12.34);
  assert.equal(p['depthBelowSurfaceM'], 12.84);
  assert.equal(p['speedThroughWaterMps'], 2.85);
  assert.equal(p['apparentWindSpeedMps'], 7.5);
  assert.equal(p['apparentWindAngleDeg'], 42);
  assert.equal(p['windSpeedMps'], 6.1);
  assert.equal(p['windDirectionDegrees'], 274.7, 'magnetic 265 + 9.7 E');
  assert.equal(p['waterTemperatureC'], 18.55);
  assert.equal(p['temperatureC'], 22.1);
  assert.equal(p['pressureHpa'], 1013);
});

test('the boat: one position source at a time; readings dropped when their instrument goes quiet', () => {
  const v = new OwnVessel();
  v.update({ kind: 'position', latitude: 10, longitude: 20 }, 3, T0);
  assert.equal(
    v.update({ kind: 'position', latitude: 10.001, longitude: 20 }, 7, T0 + 1000),
    false,
    'a second GNSS ignored',
  );
  assert.equal(v.draft(T0 + 1000, opts)!.position!.latitude, 10);
  v.update({ kind: 'position', latitude: 10.0005, longitude: 20 }, 3, T0 + 2000);
  // The first goes quiet: the second takes over.
  assert.equal(
    v.update({ kind: 'position', latitude: 10.002, longitude: 20 }, 7, T0 + 2000 + POSITION_SOURCE_HOLD_MS),
    true,
  );
  v.update({ kind: 'depth', depthM: 5 }, 35, T0);
  v.update({ kind: 'position', latitude: 10.003, longitude: 20 }, 7, T0 + READING_TTL_MS + 1);
  const later = v.draft(T0 + READING_TTL_MS + 1, opts)!;
  assert.equal(later.position!.latitude, 10.003);
  assert.equal(later.payload['depthM'], undefined, `depth older than ${READING_TTL_MS / 1000} s dropped`);
  // A magnetic heading with no variation known is not given as true.
  const w = new OwnVessel();
  w.update({ kind: 'position', latitude: 0, longitude: 0 }, 1, T0);
  w.update({ kind: 'heading', headingDeg: 90, magnetic: true }, 1, T0);
  assert.equal(w.draft(T0, opts)!.payload['headingDegrees'], undefined);
  assert.equal(w.draft(T0 + READING_TTL_MS + 1, opts), undefined, 'no position for a minute: no boat');
});

test('ships the boat hears: the AIS vocabulary, with what each said about itself', () => {
  const store = new StaticStore();
  store.merge(
    '366123456',
    staticInfo({
      kind: 'ais-static',
      mmsi: 366123456,
      name: 'PACIFIC TRADER',
      callSign: 'WDX1234',
      imo: 9876543,
      shipType: 70,
      lengthM: 182.3,
      beamM: 28.4,
      draughtM: 9.85,
      destination: 'HONOLULU',
      etaDays: Math.floor(Date.parse('2026-10-07T00:00:00Z') / 86_400_000),
      etaSeconds: 66_600,
    }),
  );
  const d = aisDraft(
    {
      kind: 'ais-position',
      aisClass: 'A',
      messageId: 1,
      mmsi: 366123456,
      latitude: 21.25,
      longitude: -157.9,
      accuracy: true,
      second: 33,
      courseDeg: 87.5,
      speedMps: 6.2,
      headingDeg: 90,
      navStatus: 0,
    },
    store,
    { receivedMs: Date.parse('2026-10-05T12:00:40Z') },
  )!;
  assert.equal(d.externalId, '366123456');
  assert.equal(d.observedAt, '2026-10-05T12:00:33.000Z', 'dated at its second');
  assert.equal(d.payload['name'], 'PACIFIC TRADER');
  assert.equal(d.payload['shipTypeText'], 'cargo');
  assert.equal(d.payload['navStatusText'], 'under way using engine');
  assert.equal(d.payload['imo'], '9876543');
  assert.deepEqual(d.payload['eta'], { month: 10, day: 7, hour: 18, minute: 30 });
  assert.equal(d.payload['lengthM'], 182.3);
  assert.equal(d.quality?.positionAccuracyM, 10);
  assert.equal(
    aisDraft(
      { kind: 'ais-position', aisClass: 'B', messageId: 18, mmsi: 0, latitude: 1, longitude: 1, accuracy: false },
      store,
      {
        receivedMs: T0,
      },
    ),
    undefined,
    'no MMSI, no ship',
  );
});
