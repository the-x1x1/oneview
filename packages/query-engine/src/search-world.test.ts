import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinGazetteer } from './builtin-gazetteer.js';
import { searchWorld } from './search-world.js';
import { FixedClock, T0, eventFrom, stateWith } from './test-fixtures.js';

const gazetteer = new BuiltinGazetteer();

function fixture() {
  const clock = new FixedClock();
  const state = stateWith(clock, [
    { providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us1', lat: 36.0, lon: 140.0, payload: { magnitude: 5.7, place: '20 km E of Tokyo, Japan' } },
    { providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us2', lat: 35.5, lon: 139.5, payload: { magnitude: 4.1, place: 'Near Yokohama, Japan' } },
    { providerId: 'usgs-earthquakes', objectType: 'earthquake', externalId: 'us3', lat: 19.4, lon: -155.3, payload: { magnitude: 2.1, place: 'Kilauea, Hawaii' } },
    { providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'a1b2c3', lat: 21.4, lon: -157.9, altitudeM: 10_000, payload: { icao24: 'a1b2c3', callsign: 'UA123' } },
    { providerId: 'adsb-lol', objectType: 'aircraft', externalId: 'c0ffee', lat: 34.0, lon: -118.0, altitudeM: 2_000, payload: { icao24: 'c0ffee', callsign: 'HAL45' } },
    { providerId: 'cctv-public', objectType: 'camera', externalId: 'cam-1', lat: 21.31, lon: -157.86, payload: { name: 'Honolulu Harbor' } },
    { providerId: 'cctv-public', objectType: 'camera', externalId: 'cam-2', lat: 51.5, lon: -0.12, payload: { name: 'Honolulu Street London' } },
  ]);
  return { clock, state, now: () => clock.now() };
}

test('searchWorld: "Honolulu" ranks the place first, then live objects with matching labels', () => {
  const { state, now } = fixture();
  const results = searchWorld('Honolulu', { state, gazetteer, now });
  assert.equal(results[0]!.kind, 'place');
  assert.equal(results[0]!.id, 'place:builtin:honolulu');
  assert.equal(results[0]!.source, 'local-index');
  assert.deepEqual(results[0]!.position, { latitude: 21.3069, longitude: -157.8583 });
  const objects = results.filter((r) => r.kind === 'object');
  assert.deepEqual(objects.map((r) => r.id).sort(), ['camera:cctv-public:cam-1', 'camera:cctv-public:cam-2']);
  assert.ok(objects.every((r) => r.source === 'world-state'));
  assert.ok(results.every((r) => r.score >= 0 && r.score <= 1));
  const scores = results.map((r) => r.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'sorted by score');
});

test('searchWorld: "ISS" is an object result first (present or not in live state)', () => {
  const { state, now, clock } = fixture();
  const absent = searchWorld('ISS', { state, gazetteer, now });
  assert.equal(absent[0]!.kind, 'object');
  assert.equal(absent[0]!.id, 'satellite:norad:25544');
  assert.match(absent[0]!.subtitle ?? '', /not in live state/);
  state.ingest([{
    id: 'celestrak:25544:' + new Date(clock.now()).toISOString(), providerId: 'celestrak', externalId: '25544', objectType: 'satellite',
    observedAt: new Date(clock.now()).toISOString(), receivedAt: new Date(clock.now()).toISOString(), position: { latitude: 10, longitude: 20, altitudeM: 420_000 },
    payload: { noradId: 25544, name: 'ISS (ZARYA)' }, quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: { providerId: 'celestrak', sourceName: 'CelesTrak', origin: 'live', receivedAt: new Date(clock.now()).toISOString() },
  }], { snapshot: false, providerId: 'celestrak' });
  state.flush();
  const present = searchWorld('ISS', { state, gazetteer, now });
  assert.equal(present[0]!.id, 'satellite:norad:25544');
  assert.equal(present[0]!.title, 'ISS (ZARYA)');
  assert.ok(present[0]!.score > absent[0]!.score);
});

test('searchWorld: "source health" resolves to the Open Source Health command', () => {
  const { state, now } = fixture();
  const results = searchWorld('source health', { state, gazetteer, now });
  assert.equal(results[0]!.kind, 'command');
  assert.equal(results[0]!.id, 'command:open-source-health');
  assert.equal(results[0]!.title, 'Open Source Health');
  assert.equal(results[0]!.source, 'command');
  assert.equal(searchWorld('Open Diagnostics', { state, gazetteer, now })[0]!.id, 'command:open-diagnostics');
  assert.equal(searchWorld('disaster lens', { state, gazetteer, now })[0]!.id, 'command:lens-disasters');
  assert.equal(searchWorld('switch 2d', { state, gazetteer, now })[0]!.id, 'command:switch-2d');
});

test('searchWorld: query intents carry the WorldQuery and a live count in the title', () => {
  const { state, now } = fixture();
  const results = searchWorld('earthquakes near Japan', { state, gazetteer, now });
  assert.equal(results[0]!.kind, 'query');
  assert.equal(results[0]!.title, 'Earthquakes near Japan (2)');
  assert.deepEqual(results[0]!.query!.objectTypes, ['earthquake']);
  assert.equal(results[0]!.query!.region!.kind, 'bounds');
  assert.ok(results[0]!.bounds, 'bounds exposed for framing');
  assert.equal(results[0]!.source, 'parser');
  assert.equal(searchWorld('M5+ earthquakes', { state, gazetteer, now })[0]!.title, 'M5+ earthquakes (1)');
  const cs = searchWorld('UA123', { state, gazetteer, now });
  assert.equal(cs[0]!.kind, 'object', 'callsign filter also surfaces the matching live aircraft');
  assert.equal(cs[0]!.id, 'aircraft:icao24:a1b2c3');
  assert.ok(cs.some((r) => r.kind === 'query' && r.title === 'Aircraft UA123 (1)'));
  assert.equal(searchWorld('a1b2c3', { state, gazetteer, now })[0]!.id, 'aircraft:icao24:a1b2c3');
});

test('searchWorld: distance bias, limit, events and determinism', () => {
  const { state, now } = fixture();
  const noBias = searchWorld('Honolulu', { state, gazetteer, now });
  const london = noBias.find((r) => r.id === 'camera:cctv-public:cam-2')!;
  const harbor = noBias.find((r) => r.id === 'camera:cctv-public:cam-1')!;
  assert.equal(london.score, harbor.score, 'identical label prefix → identical score without bias');
  const biased = searchWorld('Honolulu', { state, gazetteer, now, bias: { latitude: 21.3, longitude: -157.86 } });
  const bh = biased.find((r) => r.id === 'camera:cctv-public:cam-1')!;
  const bl = biased.find((r) => r.id === 'camera:cctv-public:cam-2')!;
  assert.ok(bh.score > bl.score, 'nearby object wins with bias');
  assert.equal(searchWorld('Honolulu', { state, gazetteer, now, limit: 2 }).length, 2);
  const events = { all: () => [eventFrom({ id: 'event:earthquake:usgs:us1', type: 'earthquake', title: 'M5.7 earthquake — Tokyo', startAt: new Date(T0).toISOString(), severity: 'SEVERE', geometry: { type: 'Point', coordinates: [140, 36] } })] };
  const withEvents = searchWorld('Tokyo', { state, gazetteer, now, events });
  assert.ok(withEvents.some((r) => r.kind === 'event' && r.id === 'event:earthquake:usgs:us1'));
  assert.deepEqual(searchWorld('fires near Los Angeles', { state, gazetteer, now }), searchWorld('fires near Los Angeles', { state, gazetteer, now }));
  assert.deepEqual(searchWorld('', { state, gazetteer, now }), []);
});
