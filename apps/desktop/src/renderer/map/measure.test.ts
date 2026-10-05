import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  densifyRing,
  formatArea,
  formatAreaAlt,
  formatDistance,
  formatDistanceAlt,
  greatCircle,
  initialBearingDeg,
  measureArea,
  measureFeatures,
  measureSummary,
  outlineCrosses,
} from './measure.js';
import { formatBearing } from './measure-panel.js';

const LHR = { latitude: 51.47, longitude: -0.4543 };
const JFK = { latitude: 40.6413, longitude: -73.7781 };

test('measure: the great-circle distance and initial bearing of a known route', () => {
  const { legs, totalM } = measureSummary([LHR, JFK]);
  assert.equal(legs.length, 1);
  // London Heathrow → New York JFK: about 5,540 km, leaving west-north-west (~288°).
  assert.ok(Math.abs(totalM / 1000 - 5540) < 15, `${totalM / 1000} km`);
  assert.ok(Math.abs(legs[0]!.bearingDeg - 288.1) < 1, `${legs[0]!.bearingDeg}°`);
  assert.equal(Math.round(initialBearingDeg({ latitude: 0, longitude: 0 }, { latitude: 10, longitude: 0 })), 0);
  assert.equal(Math.round(initialBearingDeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 10 })), 90);
  assert.equal(measureSummary([LHR]).totalM, 0);
  assert.equal(measureSummary([]).legs.length, 0);
});

test('measure: the drawn line follows the great circle and is cut at 180°', () => {
  const path = greatCircle(LHR, JFK);
  assert.ok(path.length > 100, 'a vertex at least every 50 km');
  assert.deepEqual(path[0], { latitude: LHR.latitude, longitude: LHR.longitude });
  assert.deepEqual(path.at(-1), { latitude: JFK.latitude, longitude: JFK.longitude });
  // The great circle bows north of both ends (over Ireland and Newfoundland).
  assert.ok(Math.max(...path.map((p) => p.latitude)) > 52);
  const fiji = { latitude: -17.7, longitude: 178.4 };
  const samoa = { latitude: -13.8, longitude: -172.1 };
  const features = measureFeatures([fiji, samoa]);
  const lines = features.filter((f) => f.geometry.kind === 'line');
  assert.equal(lines.length, 2, 'two pieces, one each side of 180°');
  const points = features.filter((f) => f.geometry.kind === 'point');
  assert.equal(points.length, 2);
  assert.equal(points[0]!.style.label, undefined, 'the start has no running total');
  assert.match(points[1]!.style.label ?? '', /km$/);
  assert.ok(features.every((f) => f.layer === 'measure' && f.interactive === false));
});

test('measure: distances and bearings in words', () => {
  assert.equal(formatDistance(850), '850 m');
  assert.equal(formatDistance(12_440), '12.4 km');
  assert.equal(formatDistance(1_204_000), '1,204 km');
  assert.equal(formatDistanceAlt(1852), '1.0 nm · 1.2 mi');
  assert.equal(formatBearing(63.4), '063° ENE');
  assert.equal(formatBearing(359.7), '000° N');
});

test('measure: distances and bearings on the ellipsoid, as GeographicLib gives them', () => {
  // GeodSolve -i: 51.4778 -0.0015 → 40.6413 -73.7781 is 5,584,539.270 m leaving at 288.257°.
  const { legs, totalM } = measureSummary([
    { latitude: 51.4778, longitude: -0.0015 },
    { latitude: 40.6413, longitude: -73.7781 },
  ]);
  assert.ok(Math.abs(totalM - 5_584_539.27) < 0.01, `${totalM}`);
  assert.ok(Math.abs(legs[0]!.bearingDeg - (360 - 71.742862318341)) < 1e-6);
});

test('measure: with Area on, the shape closes back to its start and its area is given', () => {
  // Planimeter: the one-degree square on the equator, 443,770.917 m round, 12,308,778,361.5 m².
  const square = [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 },
    { latitude: 1, longitude: 1 },
    { latitude: 1, longitude: 0 },
  ];
  const open = measureSummary(square);
  const closed = measureSummary(square, true);
  assert.equal(open.legs.length, 3);
  assert.equal(closed.legs.length, 4, 'the leg back to the start');
  assert.deepEqual(closed.legs[3]!.to, square[0]);
  assert.ok(Math.abs(closed.totalM - 443_770.917) < 0.01, `${closed.totalM}`);
  const a = measureArea(square);
  assert.ok(a && 'areaM2' in a && Math.abs(a.areaM2 - 12_308_778_361.5) / 12_308_778_361.5 < 1e-6);
  assert.equal(formatArea(a && 'areaM2' in a ? a.areaM2 : 0), '12,309 km²');
  assert.equal(measureSummary(square.slice(0, 2), true).legs.length, 1, 'two points: nothing to close');
  assert.equal(measureArea(square.slice(0, 2)), undefined);
  // A bow tie crosses itself: no area.
  const bowTie = [square[0]!, square[2]!, square[1]!, square[3]!];
  assert.deepEqual(measureArea(bowTie), { crossing: true });
  assert.equal(outlineCrosses(square), false);
  // The closing leg is drawn dashed, only when closed.
  const ids = (fs: ReturnType<typeof measureFeatures>) => fs.filter((f) => f.id.startsWith('measure:closing'));
  assert.equal(ids(measureFeatures(square)).length, 0);
  const closing = ids(measureFeatures(square, true));
  assert.equal(closing.length, 1);
  assert.equal(closing[0]!.style.lineStyle, 'dashed');
});

test('measure: areas in words', () => {
  assert.equal(formatArea(8_500), '8,500 m²');
  assert.equal(formatArea(12_310_000), '12.31 km²');
  assert.equal(formatArea(438_240_000), '438.2 km²');
  assert.equal(formatArea(1_204_301e6), '1,204,301 km²');
  assert.equal(formatAreaAlt(40_468.564224), '4.0 ha · 10.0 ac');
  assert.equal(formatAreaAlt(1852 * 1852 * 150), '150 nmi² · 199 mi²');
});

test('a shape densified along its legs: corners kept, never more points than asked', () => {
  const pts = [
    { latitude: 60, longitude: 0 },
    { latitude: 60, longitude: 40 },
    { latitude: 50, longitude: 20 },
  ];
  const ring = densifyRing(pts);
  assert.deepEqual(ring[0], { latitude: 60, longitude: 0 });
  assert.ok(ring.length > 3);
  assert.ok(densifyRing(pts, 50).length <= 50);
});
