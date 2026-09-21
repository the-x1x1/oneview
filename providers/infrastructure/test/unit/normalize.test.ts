import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, type ProviderError } from '@worldview/provider-sdk';
import { SEED_AIRPORTS_MANIFEST, SEED_AIRPORTS_FILE } from '../../src/manifest.js';
import { airportFeatureToDraft, normalizeAirportCollection, normalizeDatasetDate } from '../../src/normalize.js';
import { SeedAirportsProvider } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'airports');
const opts = { receivedAt: '2026-09-21T08:00:10.000Z' };
const feature = (props: Record<string, unknown>, coords: unknown = [-157.92, 21.32], geometryType = 'Point') => ({ type: 'Feature', geometry: { type: geometryType, coordinates: coords }, properties: props });
const hnl = { id: 'PHNL', name: 'Daniel K. Inouye International Airport', iata: 'HNL', icao: 'PHNL', type: 'large_airport', municipality: 'Honolulu', countryCode: 'us' };

test('feature → airport draft: ICAO external id, dataset date, local origin, upper-cased country', () => {
  const d = airportFeatureToDraft(feature(hnl), '2026-09-01T00:00:00.000Z', opts);
  assert.ok(typeof d !== 'string', String(d));
  assert.equal(d.externalId, 'PHNL');
  assert.equal(d.objectType, 'airport');
  assert.equal(d.observedAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(d.position, { latitude: 21.32, longitude: -157.92 });
  assert.deepEqual(d.payload, { name: hnl.name, icao: 'PHNL', iata: 'HNL', type: 'large_airport', municipality: 'Honolulu', countryCode: 'US' });
  assert.equal(d.origin, 'local');
  assert.equal(d.quality?.sourceQuality, 'authoritative');
});

test('feature rejections: geometry, coordinates, icao, name; unknown optional values dropped', () => {
  assert.equal(airportFeatureToDraft('x', '2026-09-01T00:00:00.000Z', opts), 'feature not an object');
  assert.equal(airportFeatureToDraft({ type: 'Feature', geometry: null, properties: null }, '2026-09-01T00:00:00.000Z', opts), 'missing properties');
  assert.equal(airportFeatureToDraft(feature(hnl, [[0, 0], [1, 1]], 'LineString'), '2026-09-01T00:00:00.000Z', opts), 'missing point geometry');
  assert.equal(airportFeatureToDraft(feature(hnl, [-157.92, 121.32]), '2026-09-01T00:00:00.000Z', opts), 'invalid coordinates');
  assert.equal(airportFeatureToDraft(feature({ ...hnl, icao: 'ph-nl' }), '2026-09-01T00:00:00.000Z', opts), 'invalid icao');
  assert.equal(airportFeatureToDraft(feature({ ...hnl, name: '' }), '2026-09-01T00:00:00.000Z', opts), 'missing name');
  const loose = airportFeatureToDraft(feature({ ...hnl, iata: 'HONO', type: 'spaceport', countryCode: 'USA' }), '2026-09-01T00:00:00.000Z', opts);
  assert.ok(typeof loose !== 'string');
  assert.deepEqual(loose.payload, { name: hnl.name, icao: 'PHNL', municipality: 'Honolulu' });
});

test('collection: datasetDate handling, duplicates, non-collections', () => {
  const ok = normalizeAirportCollection({ type: 'FeatureCollection', datasetDate: '2025-05-05', features: [feature(hnl), feature(hnl), feature({ ...hnl, icao: 'PHOG', iata: 'OGG' }, [-156.43, 20.9])] }, SEED_AIRPORTS_MANIFEST, { ...opts, hash: () => 'a'.repeat(64) });
  assert.ok(typeof ok !== 'string');
  assert.equal(ok.datasetDate, '2025-05-05T00:00:00.000Z');
  assert.equal(ok.observations.length, 2);
  assert.deepEqual(ok.rejected, [{ index: 1, reason: 'duplicate icao PHNL' }]);
  assert.equal(ok.observations[0]?.id, 'worldview-seed-airports:PHNL:2025-05-05T00:00:00.000Z');
  assert.equal(ok.observations[0]?.rawPayloadHash, 'a'.repeat(64));
  assert.equal(normalizeAirportCollection({ type: 'Topology' }, SEED_AIRPORTS_MANIFEST, opts), 'not a FeatureCollection');
  assert.equal(normalizeAirportCollection({ type: 'FeatureCollection' }, SEED_AIRPORTS_MANIFEST, opts), 'FeatureCollection has no features array');
  assert.equal(normalizeAirportCollection({ type: 'FeatureCollection', datasetDate: 'soon', features: [] }, SEED_AIRPORTS_MANIFEST, opts), 'invalid datasetDate');
  assert.equal(normalizeDatasetDate(undefined), '2026-09-01T00:00:00.000Z');
  assert.equal(normalizeDatasetDate(42), undefined);
});

test('bundled dataset: 87 unique ICAO codes, every feature admitted, Hawaii present', () => {
  const payload = JSON.parse(readFileSync(path.join(fixtures, 'seed-airports.geojson'), 'utf8')) as unknown;
  const r = normalizeAirportCollection(payload, SEED_AIRPORTS_MANIFEST, opts);
  assert.ok(typeof r !== 'string');
  assert.equal(r.rejected.length, 0);
  assert.equal(r.observations.length, 87);
  assert.equal(new Set(r.observations.map((o) => o.externalId)).size, 87);
  assert.equal(new Set(r.observations.map((o) => o.payload['iata'])).size, 87, 'IATA codes unique');
  for (const code of ['PHNL', 'PHOG', 'PHKO', 'PHTO', 'PHLI']) assert.ok(r.observations.some((o) => o.externalId === code), code);
  for (const o of r.observations) {
    assert.match(String(o.payload['countryCode']), /^[A-Z]{2}$/);
    assert.equal(o.payload['type'], 'large_airport');
    for (const v of [o.position!.latitude, o.position!.longitude]) assert.equal(Math.abs(Number((v * 100).toFixed(6)) % 1), 0, `${o.externalId} coordinate ${v} not rounded to 0.01°`);
  }
});

test('provider: reads the granted file, works with the app offline, MALFORMED on a bad file', async () => {
  const bytes = new TextEncoder().encode(readFileSync(path.join(fixtures, 'seed-airports.geojson'), 'utf8'));
  const files: Record<string, Uint8Array> = { [SEED_AIRPORTS_FILE]: bytes };
  const p = new SeedAirportsProvider();
  const ctx = testing.createFixtureContext({ providerId: 'worldview-seed-airports', clock: new testing.VirtualClock(Date.parse('2026-09-21T08:00:10.000Z')), online: false, local: new testing.FixtureLocalAccess(files) });
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 87);
  assert.equal(p.loadedDatasetDate, '2026-09-01T00:00:00.000Z');
  assert.equal((await p.health()).status, 'LIVE');
  assert.equal(ctx.http.requests.length, 0, 'no network use');
  files[SEED_AIRPORTS_FILE] = new TextEncoder().encode('{"type":"FeatureCollection","features":["junk"]}');
  await assert.rejects(p.query({ signal: new AbortController().signal, background: true }), (e: ProviderError) => e.code === 'MALFORMED');
});
