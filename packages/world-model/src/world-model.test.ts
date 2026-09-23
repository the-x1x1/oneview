import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters,
  boundsContain,
  clampBounds,
  boundsIntersect,
  circleBounds,
  regionContains,
  normalizeLongitude,
  pointInPolygon,
  simplifyRing,
  classifyFreshness,
  isExpired,
  freshnessPolicyFor,
  computeConfidence,
  classifyConfidence,
  makeObjectId,
  parseObjectId,
  Ids,
  isAuthoritativeId,
  observationSchema,
  worldQuerySchema,
  s,
  stableStringify,
  epochToIso,
  isIsoTimestamp,
  type Observation,
} from './index.js';

test('haversine: Honolulu → Los Angeles ≈ 4,116 km', () => {
  const d = haversineMeters({ latitude: 21.3069, longitude: -157.8583 }, { latitude: 34.0522, longitude: -118.2437 });
  assert.ok(Math.abs(d - 4_116_000) < 10_000, `got ${d}`);
});

test('bounds: antimeridian-crossing containment and intersection', () => {
  const fiji = { west: 170, south: -25, east: -170, north: -10 };
  assert.equal(boundsContain(fiji, { latitude: -18, longitude: 178 }), true);
  assert.equal(boundsContain(fiji, { latitude: -18, longitude: -178 }), true);
  assert.equal(boundsContain(fiji, { latitude: -18, longitude: 0 }), false);
  assert.equal(boundsIntersect(fiji, { west: -175, south: -20, east: -160, north: -15 }), true);
  assert.equal(boundsIntersect(fiji, { west: 0, south: -20, east: 10, north: -15 }), false);
  assert.equal(normalizeLongitude(190), -170);
  assert.equal(normalizeLongitude(-190), 170);
});

test('circle bounds and region containment', () => {
  const center = { latitude: 21.3, longitude: -157.9 };
  const b = circleBounds(center, 50_000);
  assert.ok(b.north > 21.7 && b.south < 20.9);
  assert.equal(
    regionContains({ kind: 'circle', center, radiusM: 50_000 }, { latitude: 21.5, longitude: -157.9 }),
    true,
  );
  assert.equal(
    regionContains({ kind: 'circle', center, radiusM: 50_000 }, { latitude: 22.5, longitude: -157.9 }),
    false,
  );
  const polar = circleBounds({ latitude: 89.9, longitude: 0 }, 100_000);
  assert.equal(polar.west, -180);
  assert.equal(polar.east, 180);
});

test('point in polygon', () => {
  const square: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  assert.equal(pointInPolygon({ latitude: 5, longitude: 5 }, square), true);
  assert.equal(pointInPolygon({ latitude: 15, longitude: 5 }, square), false);
});

test('freshness uses per-type policies, no global timeout', () => {
  const now = Date.parse('2026-09-21T00:10:00Z');
  const aircraft = freshnessPolicyFor('aircraft');
  const infra = freshnessPolicyFor('infrastructure');
  const t = Date.parse('2026-09-21T00:00:00Z');
  assert.equal(classifyFreshness(t, now, aircraft), 'STALE');
  assert.equal(classifyFreshness(t, now, infra), 'LIVE');
  assert.equal(classifyFreshness(now - 10_000, now, aircraft), 'LIVE');
  assert.equal(classifyFreshness(now - 60_000, now, aircraft), 'RECENT');
  assert.equal(classifyFreshness(Number.NaN, now, aircraft), 'UNKNOWN');
  assert.equal(isExpired(now - 700_000, now, aircraft), true);
  assert.equal(isExpired(now - 700_000, now, freshnessPolicyFor('earthquake')), false);
});

test('confidence is deterministic and classed', () => {
  const high = computeConfidence({
    sourceQuality: 'authoritative',
    freshness: 'LIVE',
    positionAccuracyM: 10,
    providerCount: 2,
    identityAuthoritative: true,
  });
  const low = computeConfidence({
    sourceQuality: 'unknown',
    freshness: 'STALE',
    providerCount: 1,
    identityAuthoritative: false,
  });
  assert.equal(high, 1);
  assert.equal(classifyConfidence(high), 'HIGH');
  assert.ok(low < 0.5, `low=${low}`);
  assert.equal(classifyConfidence(low), 'LOW');
  assert.equal(
    computeConfidence({
      sourceQuality: 'authoritative',
      freshness: 'LIVE',
      providerCount: 1,
      identityAuthoritative: true,
    }),
    computeConfidence({
      sourceQuality: 'authoritative',
      freshness: 'LIVE',
      providerCount: 1,
      identityAuthoritative: true,
    }),
  );
});

test('identifiers are deterministic and never display names', () => {
  assert.equal(Ids.aircraftByIcao24('A1B2C3'), 'aircraft:icao24:a1b2c3');
  assert.equal(Ids.vesselByMmsi(123456789), 'vessel:mmsi:123456789');
  assert.equal(Ids.satelliteByNorad(25544), 'satellite:norad:25544');
  assert.equal(Ids.earthquakeByUsgs('us7000abcd'), 'earthquake:usgs:us7000abcd');
  assert.deepEqual(parseObjectId('camera:fintraffic:C0150201'), {
    type: 'camera',
    namespace: 'fintraffic',
    value: 'C0150201',
  });
  assert.equal(isAuthoritativeId('satellite:norad:25544'), true);
  assert.equal(isAuthoritativeId('camera:fintraffic:C0150201'), false);
  assert.throws(() => makeObjectId('aircraft', 'icao24', 'United Airlines 123'));
  assert.equal(parseObjectId('nope'), undefined);
});

test('observation schema accepts a valid USGS-style observation and rejects malformed ones', () => {
  const obs: Observation = {
    id: 'usgs-earthquakes:us7000abcd:2026-09-21T00:00:00.000Z',
    providerId: 'usgs-earthquakes',
    externalId: 'us7000abcd',
    objectType: 'earthquake',
    observedAt: '2026-09-21T00:00:00.000Z',
    receivedAt: '2026-09-21T00:01:00.000Z',
    position: { latitude: 19.4, longitude: -155.3, altitudeM: -10_000, altitudeDatum: 'msl' },
    payload: { magnitude: 5.7, depthKm: 10, place: '10 km S of Volcano, Hawaii' },
    quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: {
      providerId: 'usgs-earthquakes',
      sourceName: 'USGS',
      origin: 'live',
      receivedAt: '2026-09-21T00:01:00.000Z',
    },
  };
  assert.equal(observationSchema.parse(obs).ok, true);
  const bad = observationSchema.parse({ ...obs, observedAt: 'yesterday' });
  assert.equal(bad.ok, false);
  const mismatch = observationSchema.parse({ ...obs, provenance: { ...obs.provenance, providerId: 'other' } });
  assert.equal(mismatch.ok, false);
  const nan = observationSchema.parse({ ...obs, payload: { magnitude: Number.NaN } });
  assert.equal(nan.ok, false);
  const fn = observationSchema.parse({ ...obs, payload: { f: () => 1 } });
  assert.equal(fn.ok, false);
});

test('world query schema', () => {
  assert.equal(
    worldQuerySchema.parse({
      objectTypes: ['earthquake'],
      region: { kind: 'circle', center: { latitude: 35, longitude: 138 }, radiusM: 500_000 },
      limit: 50,
    }).ok,
    true,
  );
  assert.equal(worldQuerySchema.parse({ limit: 0 }).ok, false);
  assert.equal(
    worldQuerySchema.parse({ time: { start: '2026-09-21T01:00:00Z', end: '2026-09-21T00:00:00Z' } }).ok,
    false,
  );
});

test('schema combinators: strict objects, unions, records', () => {
  const sch = s.object({ a: s.number(), b: s.optional(s.string()) }, { strict: true });
  assert.equal(sch.parse({ a: 1 }).ok, true);
  assert.equal(sch.parse({ a: 1, c: 2 }).ok, false);
  const u = s.union([s.literal('x'), s.number({ integer: true })]);
  assert.equal(u.parse('x').ok, true);
  assert.equal(u.parse(1.5).ok, false);
  assert.equal(s.record(s.number(), { keyPattern: /^[a-z]+$/ }).parse({ ok: 1, 'no-good': 2 }).ok, false);
});

test('time helpers', () => {
  assert.equal(isIsoTimestamp('2026-09-21T09:27:01.715Z'), true);
  assert.equal(isIsoTimestamp('2026-09-21 09:27:01'), false);
  assert.equal(epochToIso(1_758_000_000, 's'), '2025-09-16T05:20:00.000Z');
  assert.equal(epochToIso(-5), undefined);
  assert.equal(stableStringify({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
});

test('clampBounds: a viewport that overshoots the world is pulled back to its edge', () => {
  // The exact value that broke this in production: Cesium's view rectangle is radians, and
  // Math.PI converted to degrees is 180.00000000000003 — three parts in 10^17 outside the
  // world, and enough for the IPC validator to reject every `world.viewport` call from a
  // view wide enough to see the whole globe. The application log holds twenty of those
  // rejections ("bounds.east: expected <= 180" and its west-side twin), and on each one the
  // backend went without learning where the operator was looking.
  const overshoot = clampBounds({
    west: (-Math.PI * 180) / Math.PI,
    south: (-Math.PI / 2 / Math.PI) * 180,
    east: (Math.PI / Math.PI) * 180 + 3e-14,
    north: ((Math.PI / 2) * 180) / Math.PI + 3e-14,
  });
  assert.ok(overshoot.east <= 180 && overshoot.west >= -180);
  assert.ok(overshoot.north <= 90 && overshoot.south >= -90);
  assert.equal(overshoot.east, 180);
  assert.equal(overshoot.north, 90);

  // A rectangle already inside the world is returned unchanged, including one that crosses
  // the antimeridian (west > east is legal and must not be "fixed" into an inverted box).
  const fiji = { west: 177, south: -19, east: -178, north: -16 };
  assert.deepEqual(clampBounds(fiji), fiji);

  // Non-finite values are left alone rather than silently becoming an edge of the world:
  // a NaN bound is a bug upstream and should fail validation loudly, not be papered over.
  const broken = clampBounds({ west: Number.NaN, south: -19, east: 10, north: -16 });
  assert.ok(Number.isNaN(broken.west));
});

test('simplifyRing: a detailed outline keeps its shape within the tolerance, closed, with far fewer vertices', () => {
  // A 10,000-vertex circle of radius 1° with ±0.001° of wobble, like a traced coastline.
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < 10_000; i++) {
    const a = (i / 10_000) * 2 * Math.PI;
    const r = 1 + 0.001 * Math.sin(i * 7.3);
    ring.push([-120 + r * Math.cos(a), 40 + r * Math.sin(a)]);
  }
  ring.push([...ring[0]!] as [number, number]);
  const tol = 0.005;
  const out = simplifyRing(ring, tol);
  assert.ok(out.length < 200, `10,001 → ${out.length}`);
  assert.deepEqual(out[0], out.at(-1), 'still closed');
  // Every dropped vertex lies within the tolerance (plus rounding) of the simplified outline.
  const dist = (p: [number, number], a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
  };
  let worst = 0;
  for (const p of ring) {
    let best = Infinity;
    for (let i = 0; i + 1 < out.length; i++) best = Math.min(best, dist(p, out[i]!, out[i + 1]!));
    worst = Math.max(worst, best);
  }
  assert.ok(worst <= tol + 1e-5, `worst deviation ${worst}`);
});

test('simplifyRing: small rings survive, altitude rides along, coordinates are rounded', () => {
  const tiny: Array<[number, number]> = [
    [0, 0],
    [0.0001, 0],
    [0.0001, 0.0001],
    [0, 0],
  ];
  assert.deepEqual(simplifyRing(tiny, 0.005), tiny, 'a triangle is not collapsed into a line');
  const sliver: Array<[number, number, number]> = [
    [0, 0, 5],
    [0.001, 0, 5],
    [0.002, 0.00001, 5],
    [0.003, 0, 5],
    [0.001, 0.001, 5],
    [0, 0, 5],
  ];
  const s = simplifyRing(sliver, 0.005);
  assert.ok(s.length >= 4, 'never below a closed triangle');
  assert.ok(s.every((c) => c.length === 3 && c[2] === 5));
  assert.deepEqual(
    simplifyRing(
      [
        [1.123456789, 2.987654321],
        [3, 4],
        [5, 6],
        [1.123456789, 2.987654321],
      ],
      0,
    ),
    [
      [1.12346, 2.98765],
      [3, 4],
      [5, 6],
      [1.12346, 2.98765],
    ],
  );
});
