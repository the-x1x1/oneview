import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderHealth } from '@worldview/provider-sdk';
import type { WorldGeometry } from '@worldview/world-model';
import { earthquakeRule } from './rules/earthquake.js';
import { wildfireClusterRule, clusterSeverity } from './rules/wildfire-cluster.js';
import { weatherAlertRule } from './rules/weather-alert.js';
import { launchRule } from './rules/launch.js';
import { SourceStatusTracker, isNotableTransition, type SourceChange } from './rules/source-status.js';
import { EventStore } from './store.js';
import { magnitudeSeverity } from './severity.js';
import { DAY, HOUR, T0, ctxAt, fire, iso, obj, quake } from './test-fixtures.js';

test('earthquakeRule: deterministic ids, severity by magnitude, title/summary from known data only', () => {
  const q = quake('us7000abcd', 5.7, 36.0, 140.0, iso(-HOUR), { magType: 'mww', status: 'reviewed', tsunami: true });
  const [e] = earthquakeRule.evaluate([q], ctxAt(T0));
  assert.ok(e);
  assert.equal(e.id, 'event:earthquake:usgs:us7000abcd');
  assert.equal(e.type, 'earthquake');
  assert.equal(e.title, 'M5.7 earthquake — Test place us7000abcd');
  assert.equal(e.severity, 'SEVERE');
  assert.equal(e.startAt, iso(-HOUR));
  assert.deepEqual(e.geometry, { type: 'Point', coordinates: [140, 36] });
  assert.deepEqual(e.objectIds, [q.id]);
  assert.equal(e.observationRefs.length, 1);
  assert.equal(e.summary, 'Magnitude 5.7 (mww), depth 10 km, 2026-09-21 11:00 UTC. Status: reviewed. Tsunami flag set by the source.');
  assert.equal(e.confidence, 'HIGH');
  assert.equal(e.provenance.origin, 'derived');
  assert.equal(e.provenance.providerId, 'worldview');
  assert.deepEqual(e.properties, { magnitude: 5.7, depthKm: 10, place: 'Test place us7000abcd', magType: 'mww', status: 'reviewed', tsunami: true });
  // same input → same output
  assert.deepEqual(earthquakeRule.evaluate([q], ctxAt(T0)), earthquakeRule.evaluate([q], ctxAt(T0)));
  // severity bands
  assert.deepEqual([2.9, 3, 4.4, 4.5, 5.4, 5.5, 6.9, 7, undefined].map(magnitudeSeverity), ['INFO', 'MINOR', 'MINOR', 'MODERATE', 'MODERATE', 'SEVERE', 'SEVERE', 'EXTREME', 'INFO']);
  const noMag = earthquakeRule.evaluate([obj({ id: 'earthquake:usgs:x1', type: 'earthquake', lat: 1, lon: 1, properties: { place: 'Somewhere' } })], ctxAt(T0))[0]!;
  assert.equal(noMag.title, 'Earthquake — Somewhere');
  assert.equal(noMag.severity, 'INFO');
  const recorded = earthquakeRule.evaluate([obj({ id: 'earthquake:usgs:x2', type: 'earthquake', lat: 1, lon: 1, origin: 'recorded', properties: { magnitude: 4 } })], ctxAt(T0))[0]!;
  assert.equal(recorded.provenance.origin, 'recorded', 'recorded inputs stay labelled recorded');
  const scoped = earthquakeRule.evaluate([obj({ id: 'earthquake:emsc:abc', type: 'earthquake', lat: 1, lon: 1, properties: { magnitude: 4 } })], ctxAt(T0))[0]!;
  assert.equal(scoped.id, 'event:earthquake:emsc:abc', 'provider-scoped ids keep their namespace');
});

test('earthquakeRule: aftershock linking is nearest larger earlier ≥5.5 within 100 km / 7 days', () => {
  const store = new EventStore();
  const main = quake('main', 6.2, 36.0, 140.0, iso(-2 * DAY));
  const farMain = quake('far', 6.8, 36.0, 141.5, iso(-DAY));          // ~135 km east
  const oldMain = quake('old', 7.0, 36.05, 140.05, iso(-10 * DAY));    // 8 days before `main` → too old
  const smallEarlier = quake('small', 5.0, 36.02, 140.02, iso(-3 * DAY)); // < 5.5, cannot be a mainshock
  for (const e of earthquakeRule.evaluate([main, farMain, oldMain, smallEarlier], ctxAt(T0 - HOUR))) store.upsert(e);
  const after = quake('after', 4.1, 36.1, 140.1, iso(-HOUR));
  const [e] = earthquakeRule.evaluate([after], ctxAt(T0, store));
  assert.equal(e!.properties!['mainshockEventId'], 'event:earthquake:usgs:main');
  assert.equal(store.get('event:earthquake:usgs:main')!.properties!['mainshockEventId'], undefined, 'mainshock itself is not an aftershock of the older 7.0 (outside 7 days)');
  // A larger quake is never an aftershock of a smaller one, even inside the window.
  const bigger = quake('bigger', 6.5, 36.01, 140.01, iso(-HOUR));
  const [b] = earthquakeRule.evaluate([bigger], ctxAt(T0, store));
  assert.equal(b!.properties!['mainshockEventId'], undefined);
  // Nearest wins over larger when two candidates qualify.
  const store2 = new EventStore();
  const near = quake('near', 5.6, 36.0, 140.0, iso(-DAY));
  const bigFar = quake('bigfar', 6.9, 36.5, 140.0, iso(-DAY));   // ~55 km
  for (const e2 of earthquakeRule.evaluate([near, bigFar], ctxAt(T0 - HOUR))) store2.upsert(e2);
  const [a2] = earthquakeRule.evaluate([quake('a2', 3.0, 36.05, 140.0, iso(-HOUR))], ctxAt(T0, store2));
  assert.equal(a2!.properties!['mainshockEventId'], 'event:earthquake:usgs:near');
  // Out-of-order arrival: a mainshock reported after its aftershock re-links the stored aftershock.
  const store3 = new EventStore();
  for (const e3 of earthquakeRule.evaluate([quake('late-after', 3.5, 36.0, 140.0, iso(-HOUR))], ctxAt(T0 - HOUR))) store3.upsert(e3);
  const out = earthquakeRule.evaluate([quake('late-main', 6.0, 36.02, 140.02, iso(-3 * HOUR))], ctxAt(T0, store3));
  const relinked = out.find((x) => x.id === 'event:earthquake:usgs:late-after');
  assert.ok(relinked);
  assert.equal(relinked.properties!['mainshockEventId'], 'event:earthquake:usgs:late-main');
});

test('wildfireClusterRule: stable ids, false-merge safety, severity thresholds, hull geometry', () => {
  const near = [fire('a', 34.10, -118.50, iso(-6 * HOUR), 12), fire('b', 34.12, -118.52, iso(-5 * HOUR), 30), fire('c', 34.11, -118.48, iso(-4 * HOUR), 8)];
  const far = [fire('d', 34.50, -118.50, iso(-5 * HOUR), 5)];             // ~44 km north → separate cluster
  const stale = [fire('e', 34.105, -118.505, iso(-40 * HOUR), 50)];       // same spot, > 24 h earlier → separate cluster
  const events = wildfireClusterRule.evaluate([...far, ...near, ...stale], ctxAt(T0));
  assert.equal(events.length, 3, 'far and stale detections never merge into the main cluster');
  const main = events.find((e) => e.objectIds.length === 3)!;
  assert.ok(main);
  assert.equal(main.type, 'wildfire-cluster');
  assert.match(main.id, /^event:wildfire-cluster:worldview:[0-9a-f]{16}$/);
  assert.deepEqual(main.objectIds, near.map((f) => f.id), 'members ordered by observedAt');
  assert.equal(main.startAt, iso(-6 * HOUR));
  assert.equal(main.severity, 'MINOR');
  assert.equal(main.properties!['detectionCount'], 3);
  assert.equal(main.properties!['frpSumMw'], 50);
  assert.equal(main.properties!['firstDetectionId'], 'fire-detection:nasa-firms:a');
  assert.equal(main.geometry!.type, 'Polygon');
  assert.equal(main.title, 'Wildfire cluster — 3 detections (50 MW)');
  assert.equal(main.provenance.origin, 'derived');
  // Determinism: order of input does not matter.
  const shuffled = wildfireClusterRule.evaluate([...stale, ...near.slice().reverse(), ...far], ctxAt(T0));
  assert.deepEqual(shuffled.map((e) => e.id).sort(), events.map((e) => e.id).sort());
  assert.deepEqual(shuffled.find((e) => e.id === main.id)!.objectIds, main.objectIds);
  // Severity thresholds.
  assert.equal(clusterSeverity(9, 0), 'MINOR');
  assert.equal(clusterSeverity(10, 0), 'MODERATE');
  assert.equal(clusterSeverity(50, 0), 'SEVERE');
  assert.equal(clusterSeverity(3, 500), 'SEVERE');
  assert.equal(clusterSeverity(3, undefined), 'MINOR');
  const big = Array.from({ length: 12 }, (_, i) => fire(`big${i}`, 40 + i * 0.01, 10, iso(-HOUR - i * 60_000), 1));
  assert.equal(wildfireClusterRule.evaluate(big, ctxAt(T0))[0]!.severity, 'MODERATE');
  // Single detection → padded bbox polygon; chain linkage (single-linkage) joins A–B–C even when A–C > 5 km.
  const single = wildfireClusterRule.evaluate([fire('s', 10, 10, iso(0), 2)], ctxAt(T0))[0]!;
  assert.equal(single.geometry!.type, 'Polygon');
  const chain = wildfireClusterRule.evaluate([fire('c1', 50, 10, iso(0)), fire('c2', 50.04, 10, iso(0)), fire('c3', 50.08, 10, iso(0))], ctxAt(T0));
  assert.equal(chain.length, 1);
  assert.equal(chain[0]!.objectIds.length, 3);
});

test('wildfireClusterRule: identity survives the earliest detection expiring; merges end the absorbed cluster', () => {
  const store = new EventStore();
  const a = fire('a', 34.10, -118.50, iso(-30 * HOUR), 5);
  const b = fire('b', 34.11, -118.51, iso(-20 * HOUR), 5);
  const first = wildfireClusterRule.evaluate([a, b], ctxAt(T0 - 10 * HOUR, store));
  for (const e of first) store.upsert(e);
  const id = first[0]!.id;
  // 'a' expired; 'c' joins 'b'. The cluster keeps its id although its earliest member changed.
  const c = fire('c', 34.115, -118.505, iso(-2 * HOUR), 5);
  const second = wildfireClusterRule.evaluate([b, c], ctxAt(T0, store));
  assert.equal(second.length, 1);
  assert.equal(second[0]!.id, id);
  assert.deepEqual(second[0]!.objectIds, [b.id, c.id]);
  assert.equal(second[0]!.properties!['firstDetectionId'], b.id);
  for (const e of second) store.upsert(e);
  // Two separate clusters that get bridged by a new detection merge: earliest keeps its id, the other ends.
  const store2 = new EventStore();
  const west = fire('w', 45.0, 10.0, iso(-5 * HOUR));
  const east = fire('e', 45.0, 10.10, iso(-4 * HOUR)); // ~7.9 km apart → two clusters
  const initial = wildfireClusterRule.evaluate([west, east], ctxAt(T0 - HOUR, store2));
  assert.equal(initial.length, 2);
  for (const e of initial) store2.upsert(e);
  const westId = initial.find((e) => e.objectIds[0] === west.id)!.id;
  const eastId = initial.find((e) => e.objectIds[0] === east.id)!.id;
  const bridge = fire('m', 45.0, 10.05, iso(-HOUR));
  const merged = wildfireClusterRule.evaluate([west, east, bridge], ctxAt(T0, store2));
  const survivor = merged.find((e) => e.id === westId)!;
  assert.deepEqual(survivor.objectIds, [west.id, east.id, bridge.id]);
  const absorbed = merged.find((e) => e.id === eastId)!;
  assert.equal(absorbed.endAt, iso(0));
  assert.equal(absorbed.properties!['mergedInto'], westId);
  // All detections gone → the active cluster ends.
  const ended = wildfireClusterRule.evaluate([], ctxAt(T0 + DAY, store));
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.id, id);
  assert.equal(ended[0]!.endAt, iso(DAY));
});

test('weatherAlertRule: severity from payload, endAt from validUntil, geometry passthrough', () => {
  const polygon: WorldGeometry = { type: 'Polygon', coordinates: [[[-158.3, 21.2], [-157.6, 21.2], [-157.6, 21.8], [-158.3, 21.8], [-158.3, 21.2]]] };
  const alert = obj({
    id: 'weather-alert:nws:abc-123', type: 'weather-alert', providerId: 'nws-alerts', observedAt: iso(-HOUR), validUntil: iso(5 * HOUR), geometry: polygon,
    labels: { title: 'High Surf Warning issued September 21' }, properties: { event: 'High Surf Warning', severity: 'Severe', areaDesc: 'Oahu North Shore', senderName: 'NWS Honolulu HI', effectiveFrom: iso(-HOUR), urgency: 'Expected', certainty: 'Likely' },
  });
  const [e] = weatherAlertRule.evaluate([alert], ctxAt(T0));
  assert.equal(e!.id, 'event:weather-alert:nws:abc-123');
  assert.equal(e!.severity, 'SEVERE');
  assert.equal(e!.title, 'High Surf Warning issued September 21');
  assert.equal(e!.startAt, iso(-HOUR));
  assert.equal(e!.endAt, iso(5 * HOUR));
  assert.deepEqual(e!.geometry, polygon);
  assert.equal(e!.summary, 'High Surf Warning for Oahu North Shore from 2026-09-21 11:00 UTC until 2026-09-21 17:00 UTC. Severity: Severe. Issued by NWS Honolulu HI.');
  assert.deepEqual([undefined, 'Unknown', 'Minor', 'Moderate', 'Severe', 'Extreme'].map((s) => weatherAlertRule.evaluate([obj({ id: 'weather-alert:nws:s', type: 'weather-alert', lat: 1, lon: 1, properties: s ? { severity: s } : {} })], ctxAt(T0))[0]!.severity), ['INFO', 'INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME']);
  const plain = weatherAlertRule.evaluate([obj({ id: 'weather-alert:nws:p', type: 'weather-alert', lat: 21.3, lon: -157.8, properties: { expires: iso(HOUR) } })], ctxAt(T0))[0]!;
  assert.equal(plain.title, 'Weather alert');
  assert.equal(plain.endAt, iso(HOUR));
  assert.deepEqual(plain.geometry, { type: 'Point', coordinates: [-157.8, 21.3] });
});

test('launchRule: INFO event with NET time and pad position', () => {
  const l = obj({ id: 'launch:ll2:abc', type: 'launch', providerId: 'launch-library', lat: 28.6, lon: -80.6, labels: { name: 'Starlink Group 9-1' }, properties: { net: iso(3 * HOUR), windowEnd: iso(5 * HOUR), vehicle: 'Falcon 9', launchProvider: 'SpaceX', pad: 'SLC-40', status: 'Go' } });
  const [e] = launchRule.evaluate([l], ctxAt(T0));
  assert.equal(e!.id, 'event:launch:ll2:abc');
  assert.equal(e!.title, 'Launch — Starlink Group 9-1');
  assert.equal(e!.severity, 'INFO');
  assert.equal(e!.startAt, iso(3 * HOUR));
  assert.equal(e!.endAt, iso(5 * HOUR));
  assert.equal(e!.summary, 'Falcon 9 by SpaceX from SLC-40 NET 2026-09-21 15:00 UTC. Status: Go.');
  assert.deepEqual(e!.geometry, { type: 'Point', coordinates: [-80.6, 28.6] });
});

test('sourceStatusRule: notable transitions only, throttled to one per provider per 10 minutes', () => {
  const health = (status: ProviderHealth['status']): ProviderHealth => ({ providerId: 'usgs-earthquakes', status, errorRate: 0, rateLimitState: { limited: false }, credentialState: 'not-required' });
  const change = (from: ProviderHealth['status'], to: ProviderHealth['status']): SourceChange => ({
    providerId: 'usgs-earthquakes', from, to,
    entry: { providerId: 'usgs-earthquakes', name: 'USGS Earthquakes', categories: ['disasters'], locality: 'remote', enabled: true, health: { ...health(to), lastError: { code: 'NETWORK', message: 'fetch failed', at: iso(0) } }, transitions: [], meta: { attribution: 'USGS', refreshIntervalMs: 60_000, cacheAllowed: true, credentialsRequired: [], commercialReview: 'not-required' as never } },
  });
  assert.equal(isNotableTransition({ from: 'LIVE', to: 'OFFLINE' }), true);
  assert.equal(isNotableTransition({ from: 'OFFLINE', to: 'LIVE' }), true);
  assert.equal(isNotableTransition({ from: 'LIVE', to: 'AUTH_REQUIRED' }), true);
  assert.equal(isNotableTransition({ from: 'ERROR', to: 'STARTING' }), true);
  assert.equal(isNotableTransition({ from: 'LIVE', to: 'DEGRADED' }), false);
  assert.equal(isNotableTransition({ from: 'STARTING', to: 'LIVE' }), false);
  const tracker = new SourceStatusTracker();
  const e = tracker.consider(change('LIVE', 'OFFLINE'), T0);
  assert.ok(e);
  assert.equal(e.id, 'event:source-status-change:usgs-earthquakes:20260921t120000000z');
  assert.equal(e.type, 'source-status-change');
  assert.equal(e.severity, 'INFO');
  assert.equal(e.title, 'USGS Earthquakes: offline');
  assert.equal(e.summary, 'USGS Earthquakes changed from live to offline at 2026-09-21 12:00 UTC. Last error: NETWORK.');
  assert.deepEqual(e.properties, { providerId: 'usgs-earthquakes', from: 'LIVE', to: 'OFFLINE', sourceName: 'USGS Earthquakes', errorCode: 'NETWORK' });
  assert.equal(e.provenance.origin, 'local');
  assert.equal(tracker.consider(change('OFFLINE', 'LIVE'), T0 + 5 * 60_000), undefined, 'throttled within 10 min');
  assert.equal(tracker.consider(change('LIVE', 'DEGRADED'), T0 + 11 * 60_000), undefined, 'not notable');
  const later = tracker.consider(change('LIVE', 'ERROR'), T0 + 10 * 60_000);
  assert.ok(later);
  assert.equal(later.title, 'USGS Earthquakes: error');
  const other: SourceChange = { ...change('LIVE', 'AUTH_REQUIRED'), providerId: 'nasa-firms' };
  assert.ok(tracker.consider(other, T0 + 10 * 60_000), 'throttle is per provider');
});
