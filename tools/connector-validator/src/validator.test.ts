import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConnectorRegistry, runConnectorSuite, formatSuite } from '@worldview/connector-runtime';
import { draftDefinition, slugFromUrl } from './draft.js';
import { loadSidecar, parseSidecar, sidecarPathFor, verifyExpected } from './fixtures.js';
import { secretEnvName } from './live.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const examples = path.join(root, 'connectors', 'examples');

test('every example definition has a sidecar and passes the shared suite through it', async () => {
  for (const name of [
    'usgs-earthquakes-geojson',
    'citibike-stations-rest',
    'usgs-earthquakes-csv',
    'sample-websocket',
  ]) {
    const file = path.join(examples, `${name}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (doc['websocket']) (doc['websocket'] as Record<string, unknown>)['flushMs'] = 0;
    const fixtures = loadSidecar(sidecarPathFor(file), root);
    const r = await runConnectorSuite(doc, fixtures, defaultConnectorRegistry);
    assert.ok(r.passed, `${name}\n${formatSuite(r)}`);
  }
});

test('sidecar parsing refuses what it cannot run and keeps fixtures inside the repository', () => {
  assert.throws(() => parseSidecar('{"normal":"x"}', 's'), /"empty" is required/);
  assert.throws(
    () => parseSidecar('{"normal":"x","empty":"y","malformed":[],"expectObservations":-1}', 's'),
    /non-negative/,
  );
  assert.throws(
    () => parseSidecar('{"schema":"other","normal":"x","empty":"y","malformed":[],"expectObservations":0}', 's'),
    /schema/,
  );
  assert.throws(
    () =>
      loadSidecar(
        path.join(
          root,
          'tools',
          'connector-validator',
          'src',
          '..',
          '..',
          '..',
          'connectors',
          'examples',
          'usgs-earthquakes-csv.test.json',
        ),
        path.join(root, 'connectors'),
      ),
    /outside the repository|not found/,
  );
});

test('expectations compare fields with a numeric tolerance and report the first mismatch', () => {
  const obs = [
    {
      id: 'p:a:t',
      externalId: 'a',
      observedAt: '2026-09-23T00:00:00.000Z',
      position: { latitude: 1.0000001, longitude: 2 },
      payload: { n: 3, s: 'x', name: 'A' },
      quality: { flags: ['fetch-time'] },
      provenance: { attribution: 'Attr' },
    },
  ] as never;
  assert.equal(
    verifyExpected(obs, [
      {
        externalId: 'a',
        position: { latitude: 1 },
        payload: { n: 3, s: 'x', name: 'A' },
        flags: ['fetch-time'],
        attribution: 'Attr',
      },
    ]),
    undefined,
  );
  assert.match(verifyExpected(obs, [{ externalId: 'a', payload: { n: 4 } }])!, /payload\.n is 3/);
  assert.match(verifyExpected(obs, [{ externalId: 'b' }])!, /no observation/);
  assert.match(verifyExpected(obs, [{ externalId: 'a', position: { altitudeM: 5 } }])!, /altitudeM/);
});

test('connector:add drafts a GeoJSON, a JSON array and a CSV source fail-closed, and the drafts validate', () => {
  const geo = draftDefinition({
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    contentType: 'application/geo+json',
    text: readFileSync(path.join(root, 'fixtures', 'usgs', 'normal.geojson'), 'utf8'),
  });
  assert.equal(geo.connector, 'geojson');
  assert.equal(geo.definition['review'], 'user-configured');
  assert.equal(geo.definition['enabled'], false);
  assert.equal(geo.definition['dataPolicy'], undefined);
  const gv = defaultConnectorRegistry.validate(geo.definition);
  assert.ok(gv.ok, gv.errors.join('; '));
  assert.ok((geo.definition['mapping'] as { observedAt?: unknown }).observedAt, 'the time property was found');

  const json = draftDefinition({
    url: 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json',
    contentType: 'application/json',
    text: readFileSync(path.join(root, 'fixtures', 'connectors', 'gbfs-station-information.json'), 'utf8'),
  });
  assert.equal(json.connector, 'rest-json');
  assert.deepEqual(json.definition['response'], { itemsPath: 'data.stations' });
  const m = json.definition['mapping'] as { externalId?: string; position?: unknown };
  assert.equal(m.externalId, 'station_id');
  assert.deepEqual(m.position, { lat: 'lat', lon: 'lon' });
  assert.ok(json.todo.some((t) => t.startsWith('objectType')));
  const jv = defaultConnectorRegistry.validate(json.definition);
  assert.ok(jv.ok, jv.errors.join('; '));

  const csv = draftDefinition({
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.csv',
    contentType: 'text/csv',
    text: readFileSync(path.join(root, 'fixtures', 'connectors', 'usgs-all_day.csv'), 'utf8'),
  });
  assert.equal(csv.connector, 'csv');
  const cm = csv.definition['mapping'] as { externalId?: string; observedAt?: { transform?: string } };
  assert.equal(cm.externalId, 'id');
  assert.equal(cm.observedAt?.transform, 'isoTimestamp');
  const cv = defaultConnectorRegistry.validate(csv.definition);
  assert.ok(cv.ok, cv.errors.join('; '));

  assert.throws(() => draftDefinition({ url: 'https://a.example/x', text: '<html>' }), /neither JSON nor CSV/);
  assert.throws(() => draftDefinition({ url: 'https://a.example/x', text: '{"a":1}' }), /no array of records/);
  assert.equal(slugFromUrl('https://www.example.co.uk/api/v2/stations.json'), 'example-co-stations');
  assert.equal(secretEnvName('sample-vehicle-feed.token'), 'ONEVIEW_SECRET_SAMPLE_VEHICLE_FEED_TOKEN');
});
