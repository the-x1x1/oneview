import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { CircularOrbitPropagator } from './circular-orbit-propagator.js';
import { createSatelliteReprojector, elementsFromProperties } from './reproject.js';

const EPOCH = '2026-09-21T03:12:34.123Z';

function iss(overrides: Record<string, unknown> = {}): WorldObject {
  return {
    id: 'satellite:norad:25544',
    type: 'satellite',
    sourceRefs: [],
    // Where the first propagation of this element set happened to put it.
    position: { latitude: 10, longitude: 20, altitudeM: 420_000, altitudeDatum: 'orbit' },
    observedAt: EPOCH,
    updatedAt: EPOCH,
    freshness: 'HISTORICAL',
    confidence: 0.7,
    labels: { name: 'ISS (ZARYA)' },
    properties: {
      name: 'ISS (ZARYA)',
      noradId: 25544,
      epoch: EPOCH,
      meanMotion: 15.49812345,
      eccentricity: 0.0006703,
      inclination: 51.6416,
      raan: 247.4627,
      argPerigee: 130.536,
      meanAnomaly: 325.0288,
      bstar: 0.0001027,
      propagatedAt: EPOCH,
      ...overrides,
    },
    provenance: { providerId: 'celestrak', sourceName: 'CelesTrak', origin: 'historical', receivedAt: EPOCH },
  } as WorldObject;
}

test('replay: a satellite is put where its element set says it was at the cursor', async () => {
  const propagator = new CircularOrbitPropagator();
  const r = createSatelliteReprojector(propagator);
  await r.prepare();
  const t1 = Date.parse('2026-09-21T06:00:00Z');
  const t2 = t1 + 20 * 60_000;
  const a = r.at(iss(), t1);
  const b = r.at(iss(), t2);
  assert.ok(a?.position && b?.position);
  const direct = propagator.propagate(elementsFromProperties(iss().properties)!, t1)!;
  assert.ok(Math.abs(a.position.latitude - direct.latitude) < 1e-9);
  assert.ok(Math.abs(a.position.longitude - direct.longitude) < 1e-9);
  assert.notDeepEqual(a.position, b.position, 'twenty minutes later it is somewhere else');
  assert.notDeepEqual(a.position, iss().position, 'not the stored position');
  assert.equal(a.properties['propagatedAt'], new Date(t1).toISOString());
  assert.equal(a.id, iss().id);
});

test('replay: without a usable element set, or too far from its epoch, the stored position stands', async () => {
  const r = createSatelliteReprojector(new CircularOrbitPropagator());
  await r.prepare();
  const t = Date.parse('2026-09-21T06:00:00Z');
  assert.equal(r.at(iss({ meanMotion: 'x' }), t), undefined, 'incomplete');
  assert.equal(r.at(iss({ eccentricity: 1.5 }), t), undefined, 'invalid');
  assert.equal(r.at(iss(), t + 60 * 86_400_000), undefined, 'two months after the epoch');
  assert.equal(r.at({ ...iss(), type: 'aircraft' }, t), undefined, 'satellites only');

  // A propagator that has not loaded yet answers nothing rather than guessing.
  const slow = createSatelliteReprojector({
    name: 'slow',
    prepare: () => new Promise<void>(() => undefined),
    propagate: () => ({ latitude: 0, longitude: 0, altitudeM: 1, speedMps: 1 }),
  });
  void slow.prepare();
  assert.equal(slow.at(iss(), t), undefined);
});

test('replay: the live poll’s next position is not carried into a replayed moment', async () => {
  const r = createSatelliteReprojector(new CircularOrbitPropagator());
  await r.prepare();
  const at = Date.parse(EPOCH) + 3600_000;
  const moved = r.at(iss({ nextPosition: [1, 2, 420_000, Date.parse(EPOCH) + 15_000] }), at)!;
  assert.equal(moved.properties['nextPosition'], undefined);
  assert.equal(moved.properties['propagatedAt'], new Date(at).toISOString());
});
