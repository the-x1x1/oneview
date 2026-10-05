import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDistance,
  formatDistanceAlt,
  greatCircle,
  initialBearingDeg,
  measureFeatures,
  measureSummary,
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
