import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '@worldview/world-model';
import {
  MIN_ETA_SPEED_MPS,
  estimateArrivalMs,
  greatCirclePath,
  greatCirclePoint,
  remainingPath,
  routeProgress,
} from './flight-route.js';
import { presentObjects, routeFeatures } from './presentation.js';
import { themeEntry } from './theme.js';

/** Airport positions rounded to 0.01° (as the seed airports carry them); the flights are invented. */
const LHR = { latitude: 51.47, longitude: -0.46 };
const JFK = { latitude: 40.64, longitude: -73.78 };
const SFO = { latitude: 37.62, longitude: -122.38 };
const HNL = { latitude: 21.32, longitude: -157.92 };
const NRT = { latitude: 35.77, longitude: 140.39 };

const km = (m: number) => Math.round(m / 1000);

test('great circle: London–New York is about 5,540 km; the midpoint lies north of both', () => {
  assert.ok(Math.abs(km(haversineMeters(LHR, JFK)) - 5540) < 15, String(km(haversineMeters(LHR, JFK))));
  const mid = greatCirclePoint(LHR, JFK, 0.5);
  assert.ok(mid.latitude > 52, `the great circle bows north (${mid.latitude.toFixed(2)})`);
  assert.deepEqual(greatCirclePoint(LHR, LHR, 0.5), LHR);
  const path = greatCirclePath(LHR, JFK, 100_000);
  assert.equal(path.length, 57, 'one point per 100 km or less, both ends');
  assert.deepEqual(path[0], LHR, 'exactly the ends given');
  assert.deepEqual(path.at(-1), JFK);
  for (let i = 1; i < path.length; i++) assert.ok(haversineMeters(path[i - 1]!, path[i]!) <= 100_001);
});

test('great circle across the Pacific keeps longitudes in range and jumps at ±180', () => {
  const path = greatCirclePath(HNL, NRT, 200_000);
  assert.ok(path.every((p) => p.longitude >= -180 && p.longitude <= 180));
  const jumps = path.filter((p, i) => i > 0 && Math.abs(p.longitude - path[i - 1]!.longitude) > 180);
  assert.equal(jumps.length, 1, 'crosses the antimeridian once (presentation cuts it there)');
});

test('routeProgress: flown, to go, and which leg of a route with a stop', () => {
  // Invented flight halfway from London to New York.
  const half = greatCirclePoint(LHR, JFK, 0.5);
  const p = routeProgress(half, [LHR, JFK])!;
  assert.equal(p.leg, 0);
  assert.ok(Math.abs(p.flownM - p.remainingM) < 1000, 'halfway');
  assert.ok(Math.abs(p.flownM + p.remainingM - p.totalM) < 1000);
  assert.ok(p.detourM < 1000, 'on the great circle');
  // San Francisco → Honolulu → Tokyo, somewhere past Honolulu: the second leg.
  const past = greatCirclePoint(HNL, NRT, 0.25);
  const q = routeProgress(past, [SFO, HNL, NRT])!;
  assert.equal(q.leg, 1);
  assert.ok(Math.abs(q.toNextM - q.remainingM) < 1, 'nothing after the destination');
  assert.ok(Math.abs(q.flownM - (haversineMeters(SFO, HNL) + haversineMeters(HNL, past))) < 1);
  const early = routeProgress(greatCirclePoint(SFO, HNL, 0.5), [SFO, HNL, NRT])!;
  assert.equal(early.leg, 0);
  assert.ok(Math.abs(early.remainingM - (early.toNextM + haversineMeters(HNL, NRT))) < 1, 'through the stop');
  // A position nowhere near the route says so.
  assert.ok(routeProgress({ latitude: -33.9, longitude: 151.2 }, [LHR, JFK])!.detourM > 10_000_000);
  assert.equal(routeProgress(LHR, [LHR]), undefined);
});

test('estimateArrivalMs: distance at ground speed, nothing when too slow or unknown', () => {
  const now = Date.parse('2026-09-28T08:00:00.000Z');
  assert.equal(estimateArrivalMs(900_000, 250, now), now + 3_600_000);
  assert.equal(estimateArrivalMs(900_000, MIN_ETA_SPEED_MPS - 1, now), undefined, 'taxiing');
  assert.equal(estimateArrivalMs(900_000, undefined, now), undefined);
  assert.equal(estimateArrivalMs(Number.NaN, 250, now), undefined);
});

test('remainingPath: from the aircraft down to the next airport, then on through later stops', () => {
  const at = { ...greatCirclePoint(SFO, HNL, 0.5), altitudeM: 11_000 };
  const path = remainingPath(at, [SFO, { ...HNL, elevationM: 4 }, NRT], 0, 200_000);
  assert.equal(path[0]!.altitudeM, 11_000);
  const atHnl = path.findIndex((p) => p.latitude === HNL.latitude && p.longitude === HNL.longitude);
  assert.ok(atHnl > 0);
  assert.equal(path[atHnl]!.altitudeM, 4, 'at the airport elevation');
  assert.deepEqual(path.at(-1), { ...NRT, altitudeM: 0 });
  assert.deepEqual(remainingPath(at, [SFO, HNL], 1), [], 'past the last leg: nothing');
});

test('routeFeatures: a dashed line cut at the antimeridian and a labelled point per airport', () => {
  const at = { ...greatCirclePoint(HNL, NRT, 0.3), altitudeM: 10_000 };
  const remaining = remainingPath(at, [HNL, NRT], 0);
  const features = routeFeatures('aircraft:icao24:abc123', {
    remaining,
    airports: [
      { position: HNL, label: 'HNL', role: 'origin' },
      { position: NRT, label: 'NRT', role: 'destination' },
    ],
  });
  const lines = features.filter((f) => f.geometry.kind === 'line');
  assert.equal(lines.length, 2, 'two pieces, one each side of ±180');
  for (const l of lines) {
    assert.equal(l.style.lineStyle, 'dashed');
    assert.equal(l.style.styleClass, 'trail.route');
    assert.equal(l.interactive, false);
    const lons = (l.geometry as { positions: { longitude: number }[] }).positions.map((p) => p.longitude);
    assert.ok(Math.max(...lons) - Math.min(...lons) <= 180, 'no piece spans the map');
  }
  const points = features.filter((f) => f.geometry.kind === 'point');
  assert.deepEqual(
    points.map((p) => [p.style.label, p.style.styleClass]),
    [
      ['HNL', 'route.airport.origin'],
      ['NRT', 'route.airport.destination'],
    ],
  );
  assert.equal(themeEntry('route.airport.origin').color, themeEntry('route.airport').color);
  assert.notEqual(themeEntry('trail.route').color, themeEntry('trail.predicted').color);
});

test('presentObjects draws the route only for the selected object', () => {
  const route = { remaining: remainingPath({ ...LHR, altitudeM: 0 }, [LHR, JFK], 0), airports: [] };
  const view = { center: LHR, altitudeM: 1e7, zoom: 3, headingDegrees: 0, pitchDegrees: -90 };
  const withSel = presentObjects({ objects: [], view, selectedId: 'aircraft:icao24:abc123', selectedRoute: route });
  assert.ok(withSel.upsert.some((f) => f.id === 'route:aircraft:icao24:abc123'));
  const none = presentObjects({ objects: [], view, selectedId: null, selectedRoute: route });
  assert.ok(!none.upsert.some((f) => f.id.startsWith('route:')));
});
