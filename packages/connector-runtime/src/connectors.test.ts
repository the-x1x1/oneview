import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import { runConnectorSuite, formatSuite } from './testing/suite.js';
import { defaultConnectorRegistry, RestJsonProvider, loadDefinitionsFrom, parseCsv, createPaginator } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'connectors', name), 'utf8');
const usgsFixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'usgs', name), 'utf8');
const example = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(root, 'connectors', 'examples', name), 'utf8'));

const expectPass = (r: Awaited<ReturnType<typeof runConnectorSuite>>) => assert.ok(r.passed, '\n' + formatSuite(r));

test('demo A — a GeoJSON source (USGS earthquakes) through the geojson connector, no provider code', async () => {
  const usgs = JSON.parse(usgsFixture('normal.geojson')) as { features: unknown[] };
  const r = await runConnectorSuite(example('usgs-earthquakes-geojson.json'), {
    normal: usgsFixture('normal.geojson'),
    empty: usgsFixture('empty.geojson'),
    malformed: [usgsFixture('malformed-shape.json'), usgsFixture('malformed-notjson.txt'), '', '[]'],
    expectObservations: usgs.features.length,
    verify: (obs) => {
      const q = obs[0]!;
      if (typeof q.payload['magnitude'] !== 'number') return 'magnitude not mapped';
      if (q.position?.altitudeM !== undefined) return 'the depth became an altitude';
      if (typeof q.payload['depthKm'] !== 'number') return 'depthKm not mapped';
      if (!q.observedAt.startsWith('202')) return `observedAt ${q.observedAt}`;
      if (q.provenance.attribution !== 'U.S. Geological Survey Earthquake Hazards Program (public domain)')
        return 'attribution';
      return undefined;
    },
  });
  expectPass(r);
});

test('REST JSON — GBFS station information: itemsPath, literals, duplicates and positionless rows rejected', async () => {
  const r = await runConnectorSuite(example('citibike-stations-rest.json'), {
    normal: fixture('gbfs-station-information.json'),
    empty: fixture('gbfs-empty.json'),
    malformed: ['{"data":{"stations":"nope"}}', 'not json', '{"other":1}'],
    expectObservations: 2,
    expectIds: ['66db237e-0aca-11e7-82f6-3863bb44ef7c', '66db269c-0aca-11e7-82f6-3863bb44ef7c'],
    verify: (obs) => {
      const s = obs[0]!;
      if (s.payload['kind'] !== 'bike-share-station') return 'literal not applied';
      if (s.payload['capacity'] !== 55) return 'capacity not an integer';
      if (s.payload['name'] !== 'W 52 St & 11 Ave') return 'label missing';
      if (s.quality.flags?.[0] !== 'fetch-time') return 'fetch-time flag missing';
      return undefined;
    },
  });
  expectPass(r);
});

test('CSV — the USGS day feed as CSV: header row, typed by transforms, a bad row rejected', async () => {
  const r = await runConnectorSuite(example('usgs-earthquakes-csv.json'), {
    normal: fixture('usgs-all_day.csv'),
    empty: 'time,latitude,longitude,depth,mag,magType,id,place,status\n',
    malformed: ['"unterminated', ''],
    expectObservations: 2,
    expectIds: ['hv74567890', 'nc75123456'],
    verify: (obs) => {
      const q = obs.find((o) => o.externalId === 'hv74567890')!;
      if (q.payload['magnitude'] !== 2.02) return 'magnitude not typed';
      if (q.payload['place'] !== '5 km SE of Volcano, Hawaii') return 'quoted field with a comma';
      if (q.observedAt !== '2026-09-23T19:41:12.480Z') return `observedAt ${q.observedAt}`;
      if (Math.abs(q.position!.latitude - 19.4131660461426) > 1e-9) return 'latitude';
      return undefined;
    },
  });
  expectPass(r);
});

test('WebSocket JSON — the sample vehicle feed: subscribe with the secret, filter, itemsPath, motion', async () => {
  const doc = example('sample-websocket.json') as { websocket: Record<string, unknown> };
  doc.websocket['flushMs'] = 0;
  const r = await runConnectorSuite(doc, {
    normal: [fixture('vehicles-message.json'), '{"type":"heartbeat"}'],
    empty: '{"type":"positions","vehicles":[]}',
    malformed: ['not json', '{"type":"positions","vehicles":"x"}', '[1,2]'],
    expectObservations: 2,
    expectIds: ['bus-12', 'bus-13'],
    verify: (obs) => {
      const b = obs.find((o) => o.externalId === 'bus-12')!;
      if (b.payload['speedMps'] !== 10) return `speed ${b.payload['speedMps']}`;
      if (b.payload['headingDegrees'] !== 270) return 'heading';
      if (b.observedAt !== '2025-09-23T15:06:40.000Z') return `observedAt ${b.observedAt}`;
      return undefined;
    },
  });
  expectPass(r);
});

test('the subscribe frame carries the secret the host hands to onOpen, and never the placeholder', async () => {
  const doc = example('sample-websocket.json') as { credentials: Record<string, { secretRef: string }> };
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok && v.definition);
  const provider = defaultConnectorRegistry.createProvider(v.definition!);
  const sockets = new testing.FixtureSockets();
  sockets.secrets['sample-vehicle-feed.token'] = 's3cret';
  const ctx = testing.createFixtureContext({
    providerId: 'sample-vehicle-feed',
    sockets,
    credentials: ['sample-vehicle-feed.token'],
  });
  await provider.initialize(ctx);
  await provider.start();
  await provider.subscribe!({ signal: new AbortController().signal }, () => undefined);
  const opened = sockets.opened[0]!;
  assert.deepEqual(opened.credential, { key: 'sample-vehicle-feed.token' }, 'the host resolves the key');
  opened.handle.simulateOpen();
  assert.equal(opened.handle.sent[0], '{"action":"subscribe","channel":"positions","token":"s3cret"}');
});

test('pagination: page-number, offset-limit, cursor and next-link (own origin only)', () => {
  const page = createPaginator(
    { strategy: 'page-number', pageParam: 'page', sizeParam: 'per', size: 2, maxPages: 5 },
    'https://a.example/x',
  );
  assert.deepEqual(page.first(), { query: { page: '1', per: '2' } });
  assert.deepEqual(page.next({}, 2, 0), { query: { page: '2', per: '2' } });
  assert.equal(page.next({}, 1, 1), undefined, 'a short page is the last');
  const offset = createPaginator(
    { strategy: 'offset-limit', offsetParam: 'o', limitParam: 'l', limit: 100 },
    'https://a.example/x',
  );
  assert.deepEqual(offset.next({}, 100, 2), { query: { o: '300', l: '100' } });
  const cursor = createPaginator(
    { strategy: 'cursor', cursorParam: 'after', cursorPath: 'meta.next' },
    'https://a.example/x',
  );
  assert.deepEqual(cursor.next({ meta: { next: 'abc' } }, 5, 0), { query: { after: 'abc' } });
  assert.equal(cursor.next({ meta: {} }, 5, 0), undefined);
  const link = createPaginator({ strategy: 'next-link', nextLinkPath: 'next' }, 'https://a.example/x');
  assert.deepEqual(link.next({ next: '/x?page=2' }, 3, 0), { query: {}, url: 'https://a.example/x?page=2' });
  assert.equal(link.next({ next: 'https://evil.example/x' }, 3, 0), undefined, 'never off the origin');
  assert.equal(link.next({ next: 'https://u:p@a.example/x' }, 3, 0), undefined);
});

test('REST JSON follows next links across pages and merges them, within maxPages', async () => {
  const doc = {
    ...(example('citibike-stations-rest.json') as object),
    pagination: { strategy: 'next-link', nextLinkPath: 'next', maxPages: 5 },
  };
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok && v.definition, JSON.stringify(v.errors));
  const provider = defaultConnectorRegistry.createProvider(v.definition!) as RestJsonProvider;
  const ctx = testing.createFixtureContext({
    providerId: v.definition!.id,
    responder: (req) => ({
      status: 200,
      body: req.url.includes('page=2') ? fixture('gbfs-page2.json') : fixture('gbfs-page1.json'),
    }),
  });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.deepEqual(obs.map((o) => o.externalId).sort(), ['a', 'b', 'c']);
  assert.equal(ctx.http.requests.length, 2);
});

test('bounds placeholders are filled from the viewport, and the poll waits for one', async () => {
  const doc = {
    ...(example('citibike-stations-rest.json') as object),
    boundsQuery: true,
    endpoint: {
      url: 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json',
      query: { bbox: '{west},{south},{east},{north}' },
    },
  };
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const provider = defaultConnectorRegistry.createProvider(v.definition!) as RestJsonProvider;
  const ctx = testing.createFixtureContext({
    providerId: v.definition!.id,
    responder: () => ({ status: 200, body: fixture('gbfs-empty.json') }),
  });
  await provider.initialize(ctx);
  await provider.start();
  await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(ctx.http.requests.length, 0, 'no viewport yet: no request');
  assert.match((await provider.health()).message ?? '', /waiting for a viewport/);
  await provider.query({
    signal: new AbortController().signal,
    background: true,
    bounds: { west: -74.1, south: 40.6, east: -73.9, north: 40.8 },
  });
  assert.match(ctx.http.requests[0]!.url, /bbox=-74\.10000%2C40\.60000%2C-73\.90000%2C40\.80000/);
});

test('csv: quoting, CRLF, BOM, named columns, extra cells, row cap', () => {
  const r = parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n2,\r\n3,4,5\n');
  assert.deepEqual(r.columns, ['a', 'b']);
  assert.deepEqual(r.records, [{ a: '1', b: 'x, "y"' }, { a: '2' }, { a: '3', b: '4', _2: '5' }]);
  assert.deepEqual(parseCsv('1;2\n', { delimiter: ';', header: false, columns: ['x', 'y'] }).records, [
    { x: '1', y: '2' },
  ]);
  assert.ok(parseCsv('"open', {}).malformed);
  assert.equal(parseCsv('a\n1\n2\n3\n', { maxRows: 2 }).dropped, 1);
});

test('every example definition loads from connectors/examples; a broken file is reported, not thrown', () => {
  const loaded = loadDefinitionsFrom(path.join(root, 'connectors', 'examples'));
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.definitions.map((d) => d.id).sort(), [
    'citibike-nyc-stations',
    'sample-vehicle-feed',
    'usgs-earthquakes-connector',
    'usgs-earthquakes-csv',
  ]);
  assert.ok(
    loaded.definitions.every((d) => d.enabled === false),
    'examples are off',
  );
  const reserved = loadDefinitionsFrom(path.join(root, 'connectors', 'examples'), {
    reservedIds: ['usgs-earthquakes-csv'],
  });
  assert.equal(reserved.problems.length, 1);
  assert.match(reserved.problems[0]!.errors[0]!, /already used/);
  const forced = loadDefinitionsFrom(path.join(root, 'connectors', 'examples'), { review: 'user-configured' });
  assert.ok(
    forced.problems.some((p) => p.file === 'usgs-earthquakes-geojson.json'),
    'a bundled policy in a user folder is refused',
  );
});
