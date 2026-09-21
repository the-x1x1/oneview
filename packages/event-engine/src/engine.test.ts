import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceHealthRegistry } from '@worldview/source-health';
import type { ProviderManifest } from '@worldview/provider-sdk';
import { EventEngine } from './engine.js';
import { EventStore } from './store.js';
import { DAY, FixedClock, HOUR, T0, eventFrom, fire, iso, observationOf, quake, stateOf } from './test-fixtures.js';

test('EventStore: ordering, indexes, bound, unchanged detection, related', () => {
  const store = new EventStore({ maxEvents: 3 });
  const a = eventFrom({ id: 'event:earthquake:usgs:a', type: 'earthquake', startAt: iso(-3 * HOUR), objectIds: ['earthquake:usgs:a'], properties: { magnitude: 6 } });
  const b = eventFrom({ id: 'event:earthquake:usgs:b', type: 'earthquake', startAt: iso(-HOUR), objectIds: ['earthquake:usgs:b'], properties: { magnitude: 3, mainshockEventId: 'event:earthquake:usgs:a' } });
  const c = eventFrom({ id: 'event:weather-alert:nws:c', type: 'weather-alert', startAt: iso(-2 * HOUR), objectIds: ['weather-alert:nws:c'] });
  assert.equal(store.upsert(a), 'added');
  assert.equal(store.upsert(b), 'added');
  assert.equal(store.upsert(c), 'added');
  assert.deepEqual(store.all().map((e) => e.id), [b.id, c.id, a.id], 'startAt desc');
  assert.equal(store.upsert({ ...a, provenance: { ...a.provenance, receivedAt: iso(0) } }), 'unchanged', 'receivedAt alone is not a change');
  assert.equal(store.upsert({ ...a, title: 'renamed' }), 'updated');
  assert.equal(store.get(a.id)!.title, 'renamed');
  assert.deepEqual(store.ofType('earthquake').map((e) => e.id), [b.id, a.id]);
  assert.deepEqual(store.forObject('earthquake:usgs:b').map((e) => e.id), [b.id]);
  assert.deepEqual(store.related({ eventId: b.id }).map((e) => e.id), [a.id], 'aftershock → mainshock');
  assert.deepEqual(store.related({ eventId: a.id }).map((e) => e.id), [b.id], 'mainshock → aftershocks');
  assert.deepEqual(store.related({ objectId: 'weather-alert:nws:c' }).map((e) => e.id), [c.id]);
  assert.equal(store.list({ eventTypes: ['earthquake'], filters: [{ field: 'properties.magnitude', op: 'gte', value: 5 }] }, T0).items[0]!.id, a.id);
  const d = eventFrom({ id: 'event:earthquake:usgs:d', type: 'earthquake', startAt: iso(-30 * 60_000) });
  store.upsert(d);
  assert.equal(store.size, 3, 'bounded');
  assert.equal(store.has(a.id), false, 'oldest evicted');
  assert.equal(store.remove(d.id), true);
  assert.equal(store.remove(d.id), false);
});

test('EventEngine: ingestBatch runs rules deterministically, emits added/updated, keeps memory for cluster rules', () => {
  const clock = new FixedClock();
  const engine = new EventEngine({ clock });
  const changes: string[] = [];
  engine.on('event', ({ event, outcome }) => changes.push(`${outcome}:${event.id}`));
  const r1 = engine.ingestBatch([quake('q1', 5.8, 36, 140, iso(-HOUR)), fire('f1', 34.1, -118.5, iso(-2 * HOUR), 10)]);
  assert.equal(r1.added.length, 2);
  assert.equal(r1.updated.length, 0);
  assert.deepEqual(changes, ['added:event:earthquake:usgs:q1', ...r1.added.filter((e) => e.type === 'wildfire-cluster').map((e) => `added:${e.id}`)]);
  const clusterId = r1.added.find((e) => e.type === 'wildfire-cluster')!.id;
  // Re-ingesting identical objects changes nothing.
  clock.advance(60_000);
  const r2 = engine.ingestBatch([quake('q1', 5.8, 36, 140, iso(-HOUR))]);
  assert.equal(r2.added.length + r2.updated.length, 0);
  assert.equal(r2.unchanged, 2, 'earthquake unchanged; cluster re-evaluated from memory and unchanged');
  // A second detection joins the remembered first one → cluster updated, id stable.
  const r3 = engine.ingestBatch([fire('f2', 34.11, -118.51, iso(-HOUR), 10)]);
  assert.equal(r3.updated.length, 1);
  assert.equal(r3.updated[0]!.id, clusterId);
  assert.equal(r3.updated[0]!.properties!['detectionCount'], 2);
  // Aftershock via store context.
  const r4 = engine.ingestBatch([quake('q2', 3.2, 36.05, 140.05, iso(-10 * 60_000))]);
  assert.equal(r4.added[0]!.properties!['mainshockEventId'], 'event:earthquake:usgs:q1');
  assert.deepEqual(engine.store.related({ eventId: 'event:earthquake:usgs:q1' }).map((e) => e.id), ['event:earthquake:usgs:q2']);
  // Memory window: detections older than 7 days drop out and the cluster ends.
  clock.set(T0 + 8 * DAY);
  const r5 = engine.reevaluate();
  assert.equal(r5.updated.length, 1);
  assert.equal(r5.updated[0]!.id, clusterId);
  assert.equal(r5.updated[0]!.endAt, iso(8 * DAY));
  engine.dispose();
});

test('EventEngine: attached to a WorldState it reacts to flushed changes and expirations', () => {
  const clock = new FixedClock();
  const state = stateOf(clock, []);
  const engine = new EventEngine({ clock });
  engine.attach(state);
  const q = quake('live1', 4.6, 21.3, -157.8, iso(-HOUR));
  state.ingest([observationOf(q)], { snapshot: false, providerId: 'usgs-earthquakes' });
  assert.equal(engine.store.size, 0, 'nothing until flush');
  state.flush();
  assert.equal(engine.store.get('event:earthquake:usgs:live1')!.severity, 'MODERATE');
  const f = [fire('lf1', 34.1, -118.5, iso(-HOUR), 100), fire('lf2', 34.11, -118.49, iso(-HOUR), 450)];
  state.ingest(f.map(observationOf), { snapshot: false, providerId: 'nasa-firms' });
  state.flush();
  const cluster = engine.store.ofType('wildfire-cluster')[0]!;
  assert.equal(cluster.severity, 'SEVERE', 'FRP sum 550 MW');
  assert.equal(cluster.objectIds.length, 2);
  // Provider removal → detections removed → cluster ends on the flushed change.
  state.removeProvider('nasa-firms');
  state.flush();
  assert.equal(engine.store.get(cluster.id)!.endAt, iso(0));
  engine.dispose();
});

test('EventEngine: source health transitions become throttled INFO events', () => {
  const clock = new FixedClock();
  const registry = new SourceHealthRegistry(clock);
  const manifest = {
    id: 'usgs-earthquakes', name: 'USGS Earthquakes', categories: ['disasters'], transport: 'http', credentials: [],
    attribution: { text: 'USGS' }, dataPolicy: { cacheAllowed: true }, refreshPolicy: { intervalMs: 60_000 }, commercialReview: 'not-required',
  } as unknown as ProviderManifest;
  registry.register(manifest, { enabled: true });
  const engine = new EventEngine({ clock, sourceHealth: registry });
  const base = registry.get('usgs-earthquakes')!.health;
  registry.update({ ...base, status: 'LIVE' });
  assert.equal(engine.store.size, 0, 'STARTING → LIVE is not notable');
  registry.update({ ...base, status: 'OFFLINE' });
  assert.equal(engine.store.size, 1);
  assert.equal(engine.store.all()[0]!.title, 'USGS Earthquakes: offline');
  clock.advance(60_000);
  registry.update({ ...base, status: 'LIVE' });
  assert.equal(engine.store.size, 1, 'throttled');
  clock.advance(10 * 60_000);
  registry.update({ ...base, status: 'ERROR' });
  assert.equal(engine.store.size, 2);
  engine.dispose();
});
