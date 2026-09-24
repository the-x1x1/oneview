import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMapping, MappingError, mapRecord } from './mapping.js';
import { parsePath, readPath, formatPath } from './path.js';
import { resolveTransform, TRANSFORMS } from './transforms.js';
import { parseDefinition, definitionToManifest, checkUrl, openedPolicyFields } from './definition.js';
import { extractRecords, mapRecords } from './records.js';

test('paths: dots, indexes, negative indexes, quoted keys and $; nothing else', () => {
  const rec = { a: { 'x.y': [1, 2, { z: 3 }], list: [{ v: 'first' }, { v: 'last' }] }, n: null };
  assert.equal(readPath(rec, 'a["x.y"][-1].z'), 3);
  assert.equal(readPath(rec, 'a.list[1].v'), 'last');
  assert.equal(readPath(rec, '$.a.list[-1].v'), 'last');
  assert.deepEqual(readPath(rec, '$'), rec);
  assert.equal(readPath(rec, 'a.missing.deeper'), undefined);
  assert.equal(readPath(rec, 'n.x'), undefined, 'through null is nothing');
  assert.equal(readPath(rec, 'a.list.v'), undefined, 'a key into an array is nothing');
  assert.equal(readPath({ __proto__: { p: 1 } }, 'p'), undefined, 'own properties only');
  assert.equal(formatPath(parsePath('a["x.y"][-1].z')), 'a["x.y"][-1].z');
  for (const bad of ['', 'a..b', 'a[', 'a[x]', 'a.', '.a', 'a[1', 'x'.repeat(300)])
    assert.throws(() => parsePath(bad), bad);
  assert.throws(() => parsePath(Array.from({ length: 40 }, (_, i) => `k${i}`).join('.')), /deeper/);
});

test('transforms: the registry is closed; the parametrised forms take one number or a date pattern', () => {
  assert.equal(TRANSFORMS['fahrenheitToCelsius']!(212), 100);
  assert.equal(TRANSFORMS['knotsToMps']!('10'), 5.144);
  assert.equal(TRANSFORMS['unixSeconds']!(1758640000), '2025-09-23T15:06:40.000Z');
  assert.equal(TRANSFORMS['unixMillis']!(1758640000000), '2025-09-23T15:06:40.000Z');
  assert.equal(TRANSFORMS['unixSeconds']!(-5), undefined, 'not a live timestamp');
  assert.equal(TRANSFORMS['isoTimestamp']!('2026-09-23 10:00:00'), '2026-09-23T10:00:00.000Z');
  assert.equal(TRANSFORMS['boolean']!('Yes'), true);
  assert.equal(TRANSFORMS['boolean']!('nope'), undefined);
  assert.equal(resolveTransform('scale:0.3048')!(100), 30.48);
  assert.equal(resolveTransform('offset:-273.15')!(300), 26.850000000000023);
  assert.equal(resolveTransform('timestamp:YYYY/MM/DD HH:mm:ss')!('2026/09/23 10:11:12'), '2026-09-23T10:11:12.000Z');
  assert.equal(resolveTransform('timestamp:DD.MM.YYYY HH:mm')!('23.09.2026 12:30 +02:00'), '2026-09-23T10:30:00.000Z');
  assert.equal(resolveTransform('scale:abc'), undefined);
  assert.equal(resolveTransform('eval:1'), undefined);
  assert.equal(resolveTransform('timestamp:${x}'), undefined);
  assert.equal(TRANSFORMS['headingDegrees']!(-90), 270);
});

test('a mapping compiles once and rejects what it cannot express; records map, filter and reject with reasons', () => {
  const m = compileMapping({
    externalId: { path: 'id', fallback: ['properties.id', 'code'] },
    observedAt: { path: 'properties.time', transform: 'unixMillis' },
    position: { geometry: 'geometry', altitude: false },
    labels: { name: 'properties.place', kind: { literal: 'quake' } },
    properties: {
      magnitude: { path: 'properties.mag', transform: ['number', 'round1'], required: true },
      depthKm: 'geometry.coordinates[2]',
      note: { path: 'properties.note', default: 'none' },
    },
    motion: { speedMps: { path: 'properties.kn', transform: 'knotsToMps' } },
    filter: [
      { path: 'properties.status', in: ['reviewed', 'automatic'] },
      { path: 'properties.mag', min: 1 },
    ],
  });
  const good = mapRecord(
    {
      code: 'q1',
      properties: { time: 1758640000000, mag: 4.55, place: 'Somewhere', status: 'reviewed', kn: 10 },
      geometry: { type: 'Point', coordinates: [-158, 21.3, 10] },
    },
    m,
  );
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.record.externalId, 'q1', 'the last fallback');
    assert.equal(good.record.observedAt, '2025-09-23T15:06:40.000Z');
    assert.deepEqual(
      good.record.position,
      { latitude: 21.3, longitude: -158 },
      'no altitude from the third coordinate',
    );
    assert.deepEqual(good.record.labels, { name: 'Somewhere', kind: 'quake' });
    assert.deepEqual(good.record.properties, { magnitude: 4.6, depthKm: 10, note: 'none', speedMps: 5.144 });
  }
  const filtered = mapRecord(
    { id: 'q2', properties: { mag: 0.5, status: 'reviewed' }, geometry: { type: 'Point', coordinates: [0, 0] } },
    m,
  );
  assert.deepEqual(filtered, { ok: false, skipped: true });
  const missing = mapRecord(
    { id: 'q3', properties: { status: 'automatic', mag: 2 }, geometry: { type: 'Point', coordinates: [0, 0] } },
    m,
  );
  assert.ok(missing.ok, 'mag present');
  const noMag = mapRecord({ id: 'q4', properties: { status: 'automatic' } }, m);
  assert.deepEqual(noMag, { ok: false, skipped: true }, 'min on a missing value filters');
  const noId = mapRecord({ properties: { status: 'reviewed', mag: 3 } }, m);
  assert.ok(!noId.ok && 'reason' in noId && /externalId/.test(noId.reason));
  assert.ok(!mapRecord('text', m).ok);
  for (const bad of [
    { externalId: 'id', labels: { name: { literal: 'x', path: 'y' } } },
    { externalId: 'id', properties: { a: { transform: 'eval', path: 'x' } } },
    { externalId: 'id', position: { lat: 'a' } },
    { externalId: 'id', labels: { 'bad key!': 'x' } },
    { externalId: { path: 'a..b' } },
  ])
    assert.throws(() => compileMapping(bad as never), MappingError, JSON.stringify(bad));
});

test('a definition validates: object type, URL policy, credential references, policy fail-closed; and becomes a manifest', () => {
  const doc = {
    schema: 'oneview.connector.v1',
    id: 'my-source',
    name: 'My source',
    connector: 'rest-json',
    objectType: 'sensor',
    endpoint: { url: 'https://api.example.com/items', intervalSeconds: 60, credential: { name: 'key', as: 'header' } },
    credentials: { key: { secretRef: 'my-source.key' } },
    response: { itemsPath: 'results' },
    mapping: { externalId: 'id', position: { lat: 'latitude', lon: 'longitude' }, labels: { name: 'name' } },
    attribution: { text: 'Example Corp' },
  };
  const r = parseDefinition(doc);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    const m = definitionToManifest(r.definition, 'REST JSON');
    assert.equal(m.id, 'my-source');
    assert.deepEqual(m.allowedHosts, ['api.example.com']);
    assert.equal(m.transport, 'http');
    assert.equal(m.dataPolicy.commercialUseAllowed, 'unknown', 'fail closed');
    assert.equal(m.dataPolicy.exportAllowed, false);
    assert.equal(m.commercialReview, 'manual-review-required');
    assert.equal(m.enabledByDefault, false);
    assert.deepEqual(
      m.credentials.map((c) => c.key),
      ['my-source.key'],
    );
    assert.match(m.description!, /Connector: REST JSON/);
    assert.ok(m.refreshPolicy.maxRequestsPerMinute * m.refreshPolicy.intervalMs >= 60_000);
  }
  const bad = (patch: Record<string, unknown>, re: RegExp) => {
    const x = parseDefinition({ ...doc, ...patch });
    assert.ok(!x.ok && x.issues.some((i) => re.test(i)), `${JSON.stringify(patch)} → ${JSON.stringify(x)}`);
  };
  bad({ objectType: 'environment.observation' }, /objectType/);
  bad({ objectType: 'widget' }, /not a world-model object type/);
  bad({ endpoint: { url: 'http://api.example.com/items' } }, /must be https/);
  bad({ endpoint: { url: 'https://user:pw@api.example.com/items' } }, /credentials/);
  bad({ endpoint: { url: 'https://127.0.0.1/items' } }, /private, loopback/);
  bad({ endpoint: { url: 'https://169.254.169.254/latest/meta-data' } }, /link-local/);
  bad({ endpoint: { url: 'https://localhost/items' } }, /public host/);
  bad(
    { endpoint: { url: 'https://api.example.com/items', credential: { name: 'nope', as: 'header' } } },
    /credentials does not declare/,
  );
  bad({ dataPolicy: { redistributionAllowed: true } }, /user-configured definition may not/);
  bad({ mapping: { externalId: { path: 'id', transform: 'shell:rm' } } }, /unknown transform/);
  assert.equal(checkUrl('https://api.example.com', ['https:']), undefined);
  assert.deepEqual(openedPolicyFields({ exportAllowed: true, commercialUseAllowed: 'conditional' }), [
    'exportAllowed',
    'commercialUseAllowed',
  ]);
  const bundled = parseDefinition({ ...doc, review: 'bundled', dataPolicy: { exportAllowed: true }, enabled: true });
  assert.ok(bundled.ok);
  if (bundled.ok) {
    const m = definitionToManifest(bundled.definition, 'REST JSON');
    assert.equal(m.commercialReview, 'conditional');
    assert.equal(m.enabledByDefault, true);
    assert.equal(m.dataPolicy.exportAllowed, true);
  }
});

test('a paged definition at a slow cadence still gets a request budget that covers one poll, and a poll budget for its pages', () => {
  const doc = {
    schema: 'oneview.connector.v1',
    id: 'paged-source',
    name: 'Paged source',
    connector: 'rest-json',
    objectType: 'sensor',
    endpoint: { url: 'https://api.example.com/items', intervalSeconds: 300, timeoutSeconds: 20 },
    pagination: { strategy: 'page-number', pageParam: 'page', startPage: 1, maxPages: 10 },
    mapping: { externalId: 'id', position: { lat: 'latitude', lon: 'longitude' } },
    attribution: { text: 'Example Corp' },
  };
  const r = parseDefinition(doc);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    const m = definitionToManifest(r.definition, 'REST JSON').refreshPolicy;
    // Eleven requests in one burst (ten pages and the first request), with a retry: never fewer than 23 a minute.
    assert.equal(m.maxRequestsPerMinute, 23);
    assert.equal(m.pollBudgetMs, 20_000 * 11 + 5000);
    const single = parseDefinition({ ...doc, pagination: undefined });
    assert.ok(single.ok);
    if (single.ok)
      assert.equal(definitionToManifest(single.definition, 'REST JSON').refreshPolicy.pollBudgetMs, undefined);
  }
});

test('a definition may carry a telemetry descriptor, which its manifest carries as is', () => {
  const doc = {
    schema: 'oneview.connector.v1',
    id: 'my-station',
    name: 'My station',
    connector: 'rest-json',
    objectType: 'weather-station',
    endpoint: { url: 'https://api.example.com/station' },
    mapping: { externalId: 'id', position: { lat: 'lat', lon: 'lon' } },
    attribution: { text: 'Me' },
    telemetry: { series: [{ key: 'temperatureC', name: 'Temperature', units: '°C', format: 'celsius' }] },
  };
  const r = parseDefinition(doc);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) assert.deepEqual(definitionToManifest(r.definition, 'REST JSON').telemetry, doc.telemetry);
  const bad = parseDefinition({ ...doc, telemetry: { series: [{ key: 'x', name: 'X', format: 'fahrenheit' }] } });
  assert.ok(!bad.ok);
});

test('a file definition keeps its file block, checks the path, and becomes a filesystem manifest with no hosts', () => {
  const doc = {
    schema: 'oneview.connector.v1',
    id: 'my-tracks',
    name: 'My tracks',
    connector: 'local-file',
    objectType: 'sensor',
    file: { path: 'gps/./walk.gpx', format: 'gpx', intervalSeconds: 10, maxBytes: 2048, layers: ['tracks'] },
    mapping: { externalId: 'id', position: { geometry: 'geometry' } },
    attribution: { text: 'Me' },
  };
  const r = parseDefinition(doc);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    assert.deepEqual(r.definition.file, {
      path: 'gps/./walk.gpx',
      format: 'gpx',
      intervalSeconds: 10,
      maxBytes: 2048,
      layers: ['tracks'],
    });
    const m = definitionToManifest(r.definition, 'Local file');
    assert.equal(m.transport, 'filesystem');
    assert.deepEqual(m.allowedHosts, []);
    assert.equal(m.capabilities.offline, true);
    assert.equal(m.capabilities.live, false);
  }
  const bad = (file: Record<string, unknown>, re: RegExp) => {
    const x = parseDefinition({ ...doc, file });
    assert.ok(!x.ok && x.issues.some((i) => re.test(i)), `${JSON.stringify(file)} → ${JSON.stringify(x)}`);
  };
  bad({ path: '../secret.gpx' }, /climbs out/);
  bad({ path: 'C:/walk.gpx' }, /names a drive/);
  bad({ path: '/walk.gpx' }, /absolute/);
  bad({ path: 'walk.gpx', format: 'shp' }, /format/);
  bad({ path: 'walk.gpx', intervalSeconds: 1 }, /intervalSeconds/);
  bad({ path: 'walk.gpx', layers: ['-lco'] }, /layers/);
});

test('records: itemsPath to an array, one object, or entries; mapped into observations with the fetch time flagged', () => {
  assert.deepEqual(extractRecords({ data: { items: [1, 2] } }, { itemsPath: 'data.items' }), { records: [1, 2] });
  assert.deepEqual(extractRecords({ a: 1 }, undefined), { records: [{ a: 1 }] });
  assert.deepEqual(extractRecords({ byId: { x: { v: 1 }, y: 2 } }, { itemsPath: 'byId', itemsAs: 'entries' }), {
    records: [
      { _key: 'x', v: 1 },
      { _key: 'y', value: 2 },
    ],
  });
  assert.ok('malformed' in extractRecords({ data: 'text' }, { itemsPath: 'data' }));
  assert.ok('malformed' in extractRecords({}, { itemsPath: 'nothing' }));
  const r = parseDefinition({
    schema: 'oneview.connector.v1',
    id: 'xy',
    name: 'X',
    connector: 'rest-json',
    objectType: 'sensor',
    endpoint: { url: 'https://api.example.com/x' },
    mapping: { externalId: 'id', position: { lat: 'lat', lon: 'lon' } },
    attribution: { text: 'X' },
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  const manifest = definitionToManifest(r.definition, 'REST JSON');
  const out = mapRecords(
    [{ id: 'a', lat: 1, lon: 2 }, { id: 'a', lat: 1, lon: 2 }, { id: 'b' }, { id: 'c', lat: 91, lon: 0 }],
    {
      manifest,
      definition: r.definition,
      mapping: compileMapping(r.definition.mapping),
      receivedAt: '2026-09-23T20:00:00.000Z',
      origin: 'live',
      sourceRef: 'https://api.example.com/x',
    },
  );
  assert.equal(out.observations.length, 1);
  assert.deepEqual(
    out.rejected.map((x) => x.reason),
    ['duplicate id a', 'no position', 'no position'],
  );
  const o = out.observations[0]!;
  assert.equal(o.observedAt, '2026-09-23T20:00:00.000Z');
  assert.deepEqual(o.quality.flags, ['fetch-time']);
  assert.equal(o.providerId, 'xy');
  assert.equal(o.rawPayloadHash, undefined, 'raw retention is closed by default');
});
