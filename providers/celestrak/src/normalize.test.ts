import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationSchema, formatIssues } from '@worldview/world-model';
import { CircularOrbitPropagator } from './circular-orbit-propagator.js';
import { normalizeElements, elementsToDraft } from './normalize.js';
import type { GpElements } from './elements.js';
import type { Propagator } from './propagator.js';

const NOW = Date.parse('2026-09-21T08:05:00Z');
const ISS: GpElements = {
  noradId: 25544,
  name: 'ISS (ZARYA)',
  intlDesignator: '1998-067A',
  epoch: '2026-09-21T03:12:34.123Z',
  meanMotion: 15.49812345,
  eccentricity: 0.0006703,
  inclination: 51.6416,
  raan: 247.4627,
  argPerigee: 130.536,
  meanAnomaly: 325.0288,
  bstar: 0.0001027,
  line1: '1 25544U 98067A   26264.13372828  .00016717  00000+0  10270-3 0  9998',
  line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49812345563533',
};
const base = {
  receivedAt: new Date(NOW).toISOString(),
  nowMs: NOW,
  propagator: new CircularOrbitPropagator(),
  group: 'stations',
  sourceRef: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
  hash: (s: string) => 'a'.repeat(63) + String(s.length % 10),
};

test('an element set becomes one valid satellite observation keyed by NORAD id', () => {
  const r = normalizeElements([ISS], base);
  assert.equal(r.rejected.length, 0);
  const o = r.observations[0]!;
  const parsed = observationSchema.parse(o);
  assert.ok(parsed.ok, parsed.ok ? '' : formatIssues(parsed.issues));
  assert.equal(o.id, 'celestrak:25544:2026-09-21T03:12:34.123Z');
  assert.equal(o.externalId, '25544');
  assert.equal(o.objectType, 'satellite');
  assert.equal(o.observedAt, '2026-09-21T03:12:34.123Z');
  assert.equal(o.effectiveFrom, '2026-09-21T03:12:34.123Z');
  assert.equal(o.effectiveUntil, '2026-09-28T03:12:34.123Z');
  assert.equal(o.position?.altitudeDatum, 'orbit');
  assert.equal(o.payload['noradId'], 25544);
  assert.equal(o.payload['line1'], ISS.line1);
  assert.equal(o.payload['group'], 'stations');
  assert.equal(o.payload['propagatedAt'], '2026-09-21T08:05:00.000Z');
  assert.equal(o.payload['bstar'], 0.0001027);
  assert.deepEqual(o.quality.flags, ['propagated']);
  assert.equal(o.quality.sourceQuality, 'authoritative');
  assert.equal(o.provenance.sourceRef, base.sourceRef);
  assert.match(o.rawPayloadHash ?? '', /^[0-9a-f]{64}$/);
});

test('observedAt is clamped to now for element sets with a (slightly) future epoch', () => {
  const future = { ...ISS, epoch: '2026-09-21T09:00:00.000Z' };
  const d = elementsToDraft(future, base);
  assert.ok(typeof d !== 'string');
  assert.equal(d.observedAt, '2026-09-21T08:05:00.000Z');
  assert.equal(d.effectiveFrom, '2026-09-21T09:00:00.000Z');
});

test('aging, expired and too-old element sets are flagged or skipped', () => {
  const aging = elementsToDraft({ ...ISS, epoch: '2026-09-17T00:00:00.000Z' }, base);
  assert.ok(typeof aging !== 'string' && aging.quality?.flags?.includes('elements-aging'));
  const expired = elementsToDraft({ ...ISS, epoch: '2026-09-10T00:00:00.000Z' }, base);
  assert.ok(typeof expired !== 'string' && expired.quality?.flags?.includes('elements-expired'));
  assert.equal(
    elementsToDraft({ ...ISS, epoch: '2026-07-01T00:00:00.000Z' }, base),
    'element set too old to propagate',
  );
  assert.equal(
    elementsToDraft({ ...ISS, epoch: '2026-12-01T00:00:00.000Z' }, base),
    'element set epoch too far in the future',
  );
});

test('propagator failures and duplicates are rejected with reasons, never thrown', () => {
  const failing: Propagator = {
    name: 'always-fails',
    propagate: () => {
      throw new Error('boom');
    },
  };
  const r = normalizeElements([ISS, ISS], { ...base, propagator: failing });
  assert.equal(r.observations.length, 0);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ['propagation failed (decayed or invalid element set)', 'propagation failed (decayed or invalid element set)'],
  );
  const dup = normalizeElements([ISS, { ...ISS, name: 'ISS COPY' }], base);
  assert.equal(dup.observations.length, 1);
  assert.equal(dup.rejected[0]?.reason, 'duplicate NORAD id 25544');
  const bogus: Propagator = {
    name: 'bogus',
    propagate: () => ({ latitude: 91, longitude: 0, altitudeM: 1, speedMps: 1 }),
  };
  assert.equal(
    normalizeElements([ISS], { ...base, propagator: bogus }).rejected[0]?.reason,
    'propagated position invalid',
  );
});

test('with a lead, the observation also says where the satellite will be at the next poll', () => {
  const r = normalizeElements([ISS], { ...base, leadMs: 15_000 });
  const o = r.observations[0]!;
  const next = o.payload['nextPosition'] as [number, number, number, number];
  assert.ok(Array.isArray(next) && next.length === 4);
  assert.equal(next[3], NOW + 15_000, 'the instant it is for');
  const later = normalizeElements([ISS], { ...base, nowMs: NOW + 15_000 }).observations[0]!;
  assert.ok(Math.abs(next[0] - later.position!.latitude) < 1e-4, 'the same propagation the next poll will make');
  assert.ok(Math.abs(next[1] - later.position!.longitude) < 1e-4);
  assert.notDeepEqual([next[0], next[1]], [o.position!.latitude, o.position!.longitude], 'and it has moved');
  assert.equal(normalizeElements([ISS], base).observations[0]!.payload['nextPosition'], undefined, 'no lead, none');
  const parsed = observationSchema.parse(o);
  assert.ok(parsed.ok, parsed.ok ? '' : formatIssues(parsed.issues));
});
