import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldState } from './index.js';
import { IdentityResolver, encodeValue } from '@worldview/identity';
import { GridSpatialIndex } from '@worldview/hot-spatial-index';
import { testing } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';

const { VirtualClock } = testing;
const T0 = Date.parse('2026-09-21T00:00:00.000Z');

function obs(partial: Partial<Observation> & { providerId: string; objectType: string; externalId: string; observedAt: string }): Observation {
  return {
    id: `${partial.providerId}:${partial.externalId}:${partial.observedAt}`,
    receivedAt: partial.observedAt,
    payload: {},
    quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: { providerId: partial.providerId, sourceName: partial.providerId, origin: 'live', receivedAt: partial.observedAt },
    ...partial,
  };
}

test('identity: authoritative joins and provider-scoped fallback', () => {
  const r = new IdentityResolver();
  const a = r.resolve(obs({ providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'A1B2C3', observedAt: '2026-09-21T00:00:00.000Z', payload: { icao24: 'A1B2C3' } }));
  const b = r.resolve(obs({ providerId: 'readsb-local', objectType: 'aircraft', externalId: 'a1b2c3', observedAt: '2026-09-21T00:00:01.000Z', payload: { icao24: 'a1b2c3' } }));
  assert.equal(a.objectId, b.objectId, 'same aircraft from two providers joins on icao24');
  assert.equal(a.authoritative, true);
  const q = r.resolve(obs({ providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us7000abcd', observedAt: '2026-09-21T00:00:00.000Z' }));
  assert.equal(q.objectId, 'earthquake:usgs:us7000abcd');
  const cam = r.resolve(obs({ providerId: 'fintraffic-cameras', objectType: 'camera', externalId: 'C01502 01', observedAt: '2026-09-21T00:00:00.000Z' }));
  assert.equal(cam.rule, 'provider-scoped');
  assert.equal(cam.authoritative, false);
  assert.equal(cam.objectId, `camera:fintraffic-cameras:${encodeValue('C01502 01')}`);
  const noName = r.resolve(obs({ providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'UA123', observedAt: '2026-09-21T00:00:00.000Z', payload: { callsign: 'UA123' } }));
  assert.equal(noName.rule, 'provider-scoped', 'callsign is never identity');
});

test('spatial index: bbox, radius, nearest, region, antimeridian, density', () => {
  const idx = new GridSpatialIndex({ cellSizeDeg: 1 });
  idx.upsert({ id: 'hnl', latitude: 21.3, longitude: -157.9, type: 'airport' });
  idx.upsert({ id: 'lax', latitude: 33.9, longitude: -118.4, type: 'airport' });
  idx.upsert({ id: 'fiji-e', latitude: -18, longitude: 178, type: 'vessel' });
  idx.upsert({ id: 'fiji-w', latitude: -18, longitude: -179, type: 'vessel' });
  assert.deepEqual(idx.withinBounds({ west: -160, south: 20, east: -150, north: 25 }).map((i) => i.id), ['hnl']);
  assert.deepEqual(idx.withinBounds({ west: 170, south: -25, east: -170, north: -10 }).map((i) => i.id).sort(), ['fiji-e', 'fiji-w']);
  assert.deepEqual(idx.withinRadius({ latitude: 21.3, longitude: -157.9 }, 100_000).map((i) => i.id), ['hnl']);
  assert.deepEqual(idx.nearest({ latitude: 21.3, longitude: -157.9 }, 2).map((i) => i.id), ['hnl', 'lax']);
  assert.deepEqual(idx.nearest({ latitude: -18, longitude: 179.8 }, 1, { types: ['vessel'] }).map((i) => i.id), ['fiji-w']);
  assert.deepEqual(idx.withinRegion({ kind: 'polygon', polygon: [[-160, 20], [-150, 20], [-150, 25], [-160, 25], [-160, 20]] }).map((i) => i.id), ['hnl']);
  idx.upsert({ id: 'hnl', latitude: 40, longitude: 0, type: 'airport' });
  assert.equal(idx.withinBounds({ west: -160, south: 20, east: -150, north: 25 }).length, 0, 'moved out of cell');
  assert.equal(idx.remove('hnl'), true);
  assert.equal(idx.size, 3);
  const density = idx.cellCounts({ west: 170, south: -25, east: -170, north: -10 });
  assert.equal(density.reduce((n, c) => n + c.count, 0), 2);
});

test('spatial index: 100k objects bbox query stays fast', () => {
  const idx = new GridSpatialIndex();
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const t0 = performance.now();
  for (let i = 0; i < 100_000; i++) idx.upsert({ id: `o${i}`, latitude: rnd() * 180 - 90, longitude: rnd() * 360 - 180, type: i % 2 ? 'aircraft' : 'vessel' });
  const insertMs = performance.now() - t0;
  const t1 = performance.now();
  const hits = idx.withinBounds({ west: -125, south: 32, east: -114, north: 42 }, { types: ['aircraft'] });
  const queryMs = performance.now() - t1;
  assert.ok(hits.length > 0);
  assert.ok(insertMs < 5000, `insert 100k took ${insertMs}ms`);
  assert.ok(queryMs < 200, `bbox query took ${queryMs}ms`);
  const t2 = performance.now();
  idx.nearest({ latitude: 37, longitude: -122 }, 10);
  assert.ok(performance.now() - t2 < 200);
});

test('state: ingest adds/updates/merges across providers and batches notifications', async () => {
  const clock = new VirtualClock(T0);
  const state = new WorldState({ clock, flushDelayMs: 0 });
  const changes: string[] = [];
  state.onChange((c) => changes.push(`+${c.added.length}/~${c.updated.length}/-${c.removed.length}`));

  const r1 = state.ingest([
    obs({ providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'a1b2c3', observedAt: '2026-09-21T00:00:00.000Z', position: { latitude: 21.3, longitude: -157.9, altitudeM: 3000 }, payload: { icao24: 'a1b2c3', callsign: 'UAL123', speedMps: 200, headingDegrees: 90 } }),
    obs({ providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'ffffff', observedAt: '2026-09-21T00:00:00.000Z', position: { latitude: 20, longitude: -156 }, payload: { icao24: 'ffffff' } }),
  ], { snapshot: true, providerId: 'adsb-lol' });
  assert.equal(r1.added, 2);
  assert.equal(state.size, 2);
  const o = state.get('aircraft:icao24:a1b2c3')!;
  assert.equal(o.labels.callsign, 'UAL123');
  assert.equal(o.motion?.speedMps, 200);
  assert.equal(o.freshness, 'LIVE');
  assert.ok(o.validUntil);

  // Second provider observes the same aircraft slightly later → merge, providerCount 2.
  clock.advance(5000);
  const r2 = state.ingest([
    obs({ providerId: 'readsb-local', objectType: 'aircraft', externalId: 'a1b2c3', observedAt: '2026-09-21T00:00:04.000Z', position: { latitude: 21.31, longitude: -157.89 }, payload: { icao24: 'a1b2c3', speedMps: 205 } }),
  ], { snapshot: false, providerId: 'readsb-local' });
  assert.equal(r2.updated, 1);
  const merged = state.get('aircraft:icao24:a1b2c3')!;
  assert.equal(merged.sourceRefs.length, 2);
  assert.equal(merged.motion?.speedMps, 205);
  assert.equal(merged.labels.callsign, 'UAL123', 'labels retained from earlier observation');
  assert.equal(merged.observedAt, '2026-09-21T00:00:04.000Z');
  assert.equal(state.ofProvider('readsb-local').length, 1);
  assert.equal(state.track('aircraft:icao24:a1b2c3').length, 2);

  // Older observation must not overwrite newer state.
  state.ingest([obs({ providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'a1b2c3', observedAt: '2026-09-21T00:00:01.000Z', position: { latitude: 0, longitude: 0 }, payload: { icao24: 'a1b2c3', speedMps: 1 } })], { snapshot: false, providerId: 'adsb-lol' });
  assert.equal(state.get('aircraft:icao24:a1b2c3')!.motion?.speedMps, 205);

  // Snapshot without ffffff removes it (solely sourced by adsb-lol).
  const r3 = state.ingest([obs({ providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'a1b2c3', observedAt: '2026-09-21T00:00:06.000Z', position: { latitude: 21.32, longitude: -157.88 }, payload: { icao24: 'a1b2c3' } })], { snapshot: true, providerId: 'adsb-lol' });
  assert.equal(r3.removed, 1);
  assert.equal(state.has('aircraft:icao24:ffffff'), false);

  const change = state.flush()!;
  assert.equal(change.added.length, 1, 'ffffff was added and removed within the batch: net nothing');
  assert.equal(change.removed.length, 0);
  assert.equal(change.objectCount, 1);
  assert.equal(changes.length, 1, 'one batched notification for four ingests');
  assert.equal(state.flush(), undefined);
});

test('state: sweep reclassifies freshness and expires by type policy; spatial queries', () => {
  const clock = new VirtualClock(T0);
  const state = new WorldState({ clock, flushDelayMs: 0 });
  state.ingest([
    obs({ providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'a1b2c3', observedAt: new Date(T0).toISOString(), position: { latitude: 21.3, longitude: -157.9 }, payload: { icao24: 'a1b2c3' } }),
    obs({ providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us1', observedAt: new Date(T0).toISOString(), position: { latitude: 19.4, longitude: -155.3 }, payload: { magnitude: 5.1 } }),
  ], { snapshot: false, providerId: 'adsb-lol' });
  // providerId mismatch for usgs obs under adsb-lol meta → rejected
  assert.equal(state.size, 1);
  state.ingest([obs({ providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us1', observedAt: new Date(T0).toISOString(), position: { latitude: 19.4, longitude: -155.3 }, payload: { magnitude: 5.1 } })], { snapshot: false, providerId: 'usgs-earthquakes' });
  assert.equal(state.size, 2);
  assert.deepEqual(state.countsByType(), { aircraft: 1, earthquake: 1 });

  clock.advance(60_000);
  let s = state.sweep();
  assert.equal(s.refreshed.length, 1);
  assert.equal(state.get('aircraft:icao24:a1b2c3')!.freshness, 'RECENT');
  assert.equal(state.get('earthquake:usgs:us1')!.freshness, 'LIVE');

  clock.advance(11 * 60_000);
  s = state.sweep();
  assert.deepEqual(s.expired, ['aircraft:icao24:a1b2c3']);
  assert.equal(state.size, 1);
  assert.equal(state.withinRadius(19.4, -155.3, 50_000).length, 1);
  assert.equal(state.withinBounds({ west: -160, south: 15, east: -150, north: 25 }, ['earthquake']).length, 1);
  assert.equal(state.nearest({ latitude: 0, longitude: 0 }, 1)[0]!.object.id, 'earthquake:usgs:us1');
  clock.advance(48 * 3600 * 1000);
  s = state.sweep();
  assert.equal(state.get('earthquake:usgs:us1')!.freshness, 'STALE', 'earthquakes never expire but do go stale');
  assert.equal(state.removeProvider('usgs-earthquakes'), 1);
  assert.equal(state.size, 0);
});

declare module './index.js' {
  interface WorldState { withinRadius(lat: number, lon: number, r: number): unknown[] }
}
WorldState.prototype.withinRadius = function (this: WorldState, lat: number, lon: number, r: number) {
  return this.spatial.withinRadius({ latitude: lat, longitude: lon }, r);
};
