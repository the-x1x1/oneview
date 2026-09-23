import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { haversineMeters } from '@worldview/world-model';
import {
  MOTION_MAX_T,
  deadReckonedMotion,
  destinationPoint,
  motionFraction,
  motionSpeedMps,
  positionAlong,
} from './motion.js';
import { presentObjects } from './presentation.js';

const T0 = Date.parse('2026-09-23T20:00:00Z');

function aircraft(over: Partial<WorldObject> = {}, props: Record<string, unknown> = {}): WorldObject {
  return {
    id: 'aircraft:icao24:a1b2c3',
    type: 'aircraft',
    sourceRefs: [],
    observedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    freshness: 'LIVE',
    confidence: 0.9,
    labels: { callsign: 'TEST1' },
    properties: { onGround: false, ...props } as WorldObject['properties'],
    position: { latitude: 21.3, longitude: -157.9, altitudeM: 10_000 },
    motion: { speedMps: 250, headingDegrees: 90, verticalSpeedMps: 0 },
    ...over,
  } as WorldObject;
}

test('destinationPoint: 1° of latitude north is ~111 km; east across the antimeridian wraps', () => {
  const p = destinationPoint({ latitude: 0, longitude: 0 }, 0, 111_195);
  assert.ok(Math.abs(p.latitude - 1) < 1e-3 && Math.abs(p.longitude) < 1e-9);
  const q = destinationPoint({ latitude: 0, longitude: 179.9 }, 90, 22_239);
  assert.ok(Math.abs(q.longitude - -179.9) < 1e-3, `wrapped to ${q.longitude}`);
});

test('an aircraft in flight is dead reckoned 30 s along its track at its ground speed', () => {
  const m = deadReckonedMotion(aircraft())!;
  assert.ok(m);
  assert.equal(m.fromMs, T0);
  assert.equal(m.toMs, T0 + 30_000);
  const d = haversineMeters({ latitude: 21.3, longitude: -157.9 }, m.to);
  assert.ok(Math.abs(d - 7_500) < 5, `7.5 km in 30 s, got ${d}`);
  assert.ok(m.to.longitude > -157.9, 'east');
  assert.equal(m.to.altitudeM, 10_000, 'level flight keeps its altitude');
  assert.ok(Math.abs(motionSpeedMps(aircraft().position!, m) - 250) < 0.5);
});

test('a climb or descent is carried, but never below sea level over the extra span', () => {
  const climb = deadReckonedMotion(aircraft({ motion: { speedMps: 120, headingDegrees: 0, verticalSpeedMps: 10 } }))!;
  assert.equal(climb.to.altitudeM, 10_300);
  const landing = deadReckonedMotion(
    aircraft({
      position: { latitude: 21.3, longitude: -157.9, altitudeM: 200 },
      motion: { speedMps: 70, headingDegrees: 80, verticalSpeedMps: -8 },
    }),
  )!;
  // Held MOTION_MAX_T spans at most: 200 + 2 × (to − 200) must stay ≥ 0.
  assert.ok(200 + MOTION_MAX_T * (landing.to.altitudeM! - 200) >= 0, `to ${landing.to.altitudeM}`);
});

test('nothing is dead reckoned on the ground, too slow, too fast, without a track, or for other types', () => {
  assert.equal(deadReckonedMotion(aircraft({}, { onGround: true })), undefined, 'taxiways turn');
  assert.equal(deadReckonedMotion(aircraft({ motion: { speedMps: 2, headingDegrees: 10 } })), undefined);
  assert.equal(deadReckonedMotion(aircraft({ motion: { speedMps: 5000, headingDegrees: 10 } })), undefined);
  assert.equal(deadReckonedMotion(aircraft({ motion: { speedMps: 200 } })), undefined);
  assert.equal(deadReckonedMotion(aircraft({ type: 'earthquake' })), undefined);
  const ship = deadReckonedMotion(aircraft({ type: 'vessel', motion: { speedMps: 6, headingDegrees: 180 } }))!;
  assert.equal(ship.toMs - ship.fromMs, 60_000, 'a ship is carried a minute a span');
});

test('positionAlong moves in degrees, the short way across the antimeridian, held at MOTION_MAX_T', () => {
  const from = { latitude: 10, longitude: 179.99 };
  const motion = { to: { latitude: 10, longitude: -179.99 }, fromMs: 0, toMs: 10_000 };
  const [lon] = positionAlong(from, motion, 5_000);
  assert.ok(Math.abs(Math.abs(lon) - 180) < 1e-6, `halfway is on the antimeridian, got ${lon}`);
  assert.equal(motionFraction(motion, -5), 0);
  assert.equal(motionFraction(motion, 1e9), MOTION_MAX_T);
  const [lon2] = positionAlong(from, motion, 1e9);
  assert.ok(Math.abs(lon2 - -179.97) < 1e-6, `carried one span past at most, got ${lon2}`);
});

test('presentation gives aircraft their motion only while the timeline is live', () => {
  const view = {
    center: { latitude: 21, longitude: -158 },
    altitudeM: 200_000,
    zoom: 8,
    headingDegrees: 0,
    pitchDegrees: -90,
  };
  const live = presentObjects({ objects: [aircraft()], view, animate: true, cullToView: false });
  const f = live.upsert.find((u) => u.objectId === 'aircraft:icao24:a1b2c3');
  assert.ok(f?.motion, 'live: moving');
  const paused = presentObjects({ objects: [aircraft()], view, animate: false, cullToView: false });
  assert.equal(paused.upsert.find((u) => u.objectId === 'aircraft:icao24:a1b2c3')?.motion, undefined, 'paused: still');
});
