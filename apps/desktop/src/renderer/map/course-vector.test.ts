import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeoPosition, WorldObject } from '@worldview/world-model';
import { haversineMeters } from '@worldview/world-model';
import { COURSE_VECTOR_LAYER, courseVectorFeatures, courseVectorKey, moverOf } from './course-vector.js';

const T0 = '2026-10-05T19:00:00.000Z';
const NOW = Date.parse(T0);
const obj = (
  id: string,
  type: 'vessel' | 'aircraft',
  lat: number,
  lon: number,
  course: number,
  speedMps: number,
  props: Record<string, number | boolean | string> = {},
): WorldObject => ({
  id,
  type,
  sourceRefs: [],
  position: { latitude: lat, longitude: lon, ...(type === 'aircraft' ? { altitudeM: 10_000 } : {}) },
  motion: { speedMps, headingDegrees: course },
  observedAt: T0,
  updatedAt: T0,
  freshness: 'LIVE',
  confidence: 0.9,
  labels: {},
  properties: type === 'vessel' ? { courseDegrees: course, speedMps, ...props } : props,
  provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: T0 },
});
const pos = (f: { geometry: unknown }) => (f.geometry as { position: GeoPosition }).position;
const kn = (k: number) => (k * 1852) / 3600;

test("a ship's vector: twelve minutes along its course over ground, a tick every three, the last named", () => {
  const ship = obj('ship', 'vessel', 21, -158, 90, kn(10));
  const fs = courseVectorFeatures(ship, undefined, NOW);
  const line = fs.find((f) => f.id === 'course-vector:line')!;
  assert.equal(line.style.lineStyle, 'dashed');
  assert.equal(line.style.heightMode, undefined, 'a ship on the water');
  const ticks = fs.filter((f) => f.id.startsWith('course-vector:tick:'));
  assert.deepEqual(
    ticks.map((f) => f.id),
    ['course-vector:tick:3', 'course-vector:tick:6', 'course-vector:tick:9', 'course-vector:tick:12'],
  );
  // 10 kn for 12 minutes is 2 nm, due east.
  const end = pos(ticks.at(-1)!);
  assert.ok(Math.abs(haversineMeters(ship.position!, end) - 2 * 1852) < 5);
  assert.ok(end.longitude > -158 && Math.abs(end.latitude - 21) < 0.001);
  assert.equal(ticks.at(-1)!.style.label, '12 min');
  assert.equal(ticks[0]!.style.label, undefined);
  for (const f of fs) {
    assert.equal(f.layer, COURSE_VECTOR_LAYER);
    assert.equal(f.interactive, false);
  }
});

test('an aircraft: five minutes along its track; nothing on the ground, too slow, too old or without a course', () => {
  const plane = obj('a', 'aircraft', 21, -158, 0, 250);
  const ticks = courseVectorFeatures(plane, undefined, NOW).filter((f) => f.id.includes(':tick:'));
  assert.equal(ticks.length, 5);
  assert.ok(Math.abs(haversineMeters(plane.position!, pos(ticks.at(-1)!)) - 75_000) < 50);
  // Drawn at the aircraft's height on the globe, from the aircraft: not on the ground beneath it.
  const line = courseVectorFeatures(plane, undefined, NOW).find((f) => f.id === 'course-vector:line')!;
  assert.equal(line.style.heightMode, 'absolute');
  assert.ok((line.geometry as { positions: GeoPosition[] }).positions.every((p) => p.altitudeM === 10_000));
  assert.equal(pos(ticks.at(-1)!).altitudeM, 10_000);
  assert.equal(ticks.at(-1)!.style.heightMode, 'absolute');
  assert.equal(moverOf(obj('g', 'aircraft', 21, -158, 0, 10, { onGround: true }), NOW), undefined);
  assert.equal(moverOf(obj('moored', 'vessel', 21, -158, 0, 0.2), NOW), undefined);
  assert.equal(moverOf(plane, NOW + 11 * 60_000), undefined, 'last heard eleven minutes ago');
  assert.ok(moverOf(plane, NOW + 9 * 60_000));
  assert.deepEqual(courseVectorFeatures(plane, undefined, NOW + 11 * 60_000), [], 'nothing drawn from an old report');
  assert.equal(moverOf(plane, NOW - 11 * 60_000), undefined, 'replaying, a report from well after the time shown');
  // A ship's heading alone is where it points, not where it goes.
  const headingOnly = { ...obj('h', 'vessel', 21, -158, 0, kn(8)), properties: { speedMps: kn(8) } };
  assert.equal(moverOf(headingOnly, NOW), undefined);
  assert.deepEqual(courseVectorFeatures(headingOnly, undefined, NOW), []);
  assert.equal(courseVectorKey(headingOnly, undefined, NOW), '', 'nothing to draw: nothing sent');
});

test('with the boat on the map: its vector too, and where the two will be closest, joined and named', () => {
  const own = obj('own', 'vessel', 21, -158, 0, kn(10), { ownVessel: true });
  const ship = obj('ship', 'vessel', 21, -158 + 5 / (60 * Math.cos((21 * Math.PI) / 180)), 270, kn(10));
  const fs = courseVectorFeatures(ship, own, NOW);
  assert.ok(fs.some((f) => f.id === 'course-vector:own:line' && f.style.styleClass === 'course-vector.own'));
  const a = fs.find((f) => f.id === 'course-vector:cpa:own')!;
  const b = fs.find((f) => f.id === 'course-vector:cpa:other')!;
  assert.equal(b.style.label, 'CPA 3.5 nm · 15 min');
  // In 15 minutes the boat has gone 2.5 nm north and the ship 2.5 nm west: 3.5 nm apart.
  assert.ok(Math.abs(haversineMeters(own.position!, pos(a)) - 2.5 * 1852) < 30);
  assert.ok(Math.abs(haversineMeters(pos(a), pos(b)) / 1852 - 3.54) < 0.02);
  assert.equal(a.style.styleClass, 'course-vector.cpa', 'not close');
  // Head on: close, in red.
  const ahead = obj('ahead', 'vessel', 21 + 2 / 60, -158, 180, kn(10));
  assert.equal(
    courseVectorFeatures(ahead, own, NOW).find((f) => f.id === 'course-vector:cpa:other')?.style.styleClass,
    'course-vector.cpa-close',
  );
  // Going away: the vectors, no closest point.
  const astern = obj('astern', 'vessel', 21 - 2 / 60, -158, 180, kn(10));
  assert.ok(!courseVectorFeatures(astern, own, NOW).some((f) => f.id.startsWith('course-vector:cpa')));
  // The boat selected: only its own vector, once.
  assert.ok(!courseVectorFeatures(own, own, NOW).some((f) => f.id.startsWith('course-vector:own')));
  // An aircraft selected: the boat is not drawn.
  assert.ok(!courseVectorFeatures(obj('a', 'aircraft', 21, -158, 0, 250), own, NOW).some((f) => f.id.includes('own')));
});

test('the key changes with a new report, and with the minute only while a closest point is drawn', () => {
  const ship = obj('ship', 'vessel', 21, -158, 90, kn(10));
  const k = courseVectorKey(ship, undefined, NOW);
  assert.equal(courseVectorKey(ship, undefined, NOW + 90_000), k, 'alone: the clock does not redraw it');
  assert.notEqual(courseVectorKey({ ...ship, observedAt: '2026-10-05T19:00:10.000Z' }, undefined, NOW), k);
  const own = obj('own', 'vessel', 21, -158.05, 0, kn(10), { ownVessel: true });
  const withOwn = courseVectorKey(ship, own, NOW);
  assert.notEqual(courseVectorKey(ship, own, NOW + 60_000), withOwn);
  assert.equal(courseVectorKey(null, own, NOW), '');
});
