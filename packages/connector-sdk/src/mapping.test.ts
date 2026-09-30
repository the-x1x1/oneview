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
  assert.equal(TRANSFORMS['spacesToUnderscores']!(' Tstm  Wnd\tGst '), 'Tstm_Wnd_Gst');
  assert.equal(TRANSFORMS['spacesToUnderscores']!(12), 12);
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
  // A trailing dot names the same host; private-use suffixes and single labels are not public.
  for (const url of [
    'https://localhost./x',
    'https://foo.localhost./x',
    'https://printer.local./x',
    'https://metadata.google.internal/x',
    'https://router.lan/x',
    'https://nas.home.arpa/x',
    'https://intranet/x',
  ])
    assert.match(checkUrl(url, ['https:']) ?? '', /public host/, url);
  assert.match(checkUrl('https://127.0.0.1./x', ['https:']) ?? '', /private, loopback/);
  assert.match(checkUrl('https://2130706433/x', ['https:']) ?? '', /private, loopback/, 'decimal IPv4 is normalised');
  assert.equal(checkUrl('https://api.example.com./x', ['https:']), undefined);
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
    [
      { id: 'a', lat: 1, lon: 2 },
      { id: 'a', lat: 1, lon: 2 },
      { id: 'a', lat: 3, lon: 4 },
      { id: 'b' },
      { id: 'c', lat: 91, lon: 0 },
    ],
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
    'the exact repeat is dropped quietly; the same id elsewhere is refused',
  );
  assert.equal(out.repeated, 1);
  const o = out.observations[0]!;
  assert.equal(o.observedAt, '2026-09-23T20:00:00.000Z');
  assert.deepEqual(o.quality.flags, ['fetch-time']);
  assert.equal(o.providerId, 'xy');
  assert.equal(o.rawPayloadHash, undefined, 'raw retention is closed by default');
});

test('mapRecords: a backlog of one object gives one observation per time, not the first listed (R4)', () => {
  const r = parseDefinition({
    schema: 'oneview.connector.v1',
    id: 'log',
    name: 'Log',
    connector: 'rest-json',
    objectType: 'sensor',
    endpoint: { url: 'https://api.example.com/log' },
    mapping: { externalId: 'id', observedAt: 't', position: { lat: 'lat', lon: 'lon' } },
    attribution: { text: 'X' },
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = mapRecords(
    [
      { id: 'a', t: '2026-09-23T18:00:00Z', lat: 1, lon: 2 },
      { id: 'a', t: '2026-09-23T18:10:00Z', lat: 1, lon: 2 },
      { id: 'a', t: '2026-09-23T18:10:00Z', lat: 1, lon: 2 },
      { id: 'b', t: '2026-09-23T18:10:00Z', lat: 3, lon: 4 },
    ],
    {
      manifest: definitionToManifest(r.definition, 'REST JSON'),
      definition: r.definition,
      mapping: compileMapping(r.definition.mapping),
      receivedAt: '2026-09-23T20:00:00.000Z',
      origin: 'live',
      sourceRef: 'https://api.example.com/log',
    },
  );
  assert.deepEqual(
    out.observations.map((o) => [o.externalId, o.observedAt]),
    [
      ['a', '2026-09-23T18:00:00.000Z'],
      ['a', '2026-09-23T18:10:00.000Z'],
      ['b', '2026-09-23T18:10:00.000Z'],
    ],
  );
  // The same object at the same time twice is still one observation, and a word-for-word
  // repeat is not a rejection.
  assert.deepEqual(out.rejected, []);
  assert.equal(out.repeated, 1);
});

test('manifestDescription keeps the connector name whole and the text within the manifest cap (R5)', async () => {
  const { manifestDescription, MAX_MANIFEST_DESCRIPTION } = await import('./definition.js');
  assert.equal(manifestDescription('Stations.', 'REST JSON'), 'Stations. Connector: REST JSON.');
  assert.equal(manifestDescription(undefined, 'CSV'), 'Connector: CSV.');
  const long = manifestDescription('x'.repeat(499), 'Local file');
  assert.equal(long.length <= MAX_MANIFEST_DESCRIPTION, true);
  assert.match(long, /^x+… Connector: Local file\.$/);
});

test('a line or an area is placed on itself: half-way along a line, inside an area, across 180°', () => {
  const m = compileMapping({ externalId: 'id', position: { geometry: 'geometry' } });
  const at = (geometry: unknown) => {
    const r = mapRecord({ id: 'x', geometry }, m);
    return r.ok ? r.record.position : undefined;
  };
  // A line: half its length along it, not its first point.
  assert.deepEqual(
    at({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0, 2],
        [0, 10],
      ],
    }),
    { latitude: 5, longitude: 0 },
  );
  // A square: its centre.
  const square = [
    [10, 10],
    [12, 10],
    [12, 12],
    [10, 12],
    [10, 10],
  ];
  assert.deepEqual(at({ type: 'Polygon', coordinates: [square] }), { latitude: 11, longitude: 11 });
  // A U shape, whose centroid is in the gap: a point inside one of its arms instead.
  const u = [
    [0, 0],
    [3, 0],
    [3, 3],
    [2, 3],
    [2, 1],
    [1, 1],
    [1, 3],
    [0, 3],
    [0, 0],
  ];
  const inU = at({ type: 'Polygon', coordinates: [u] })!;
  const insideU =
    (inU.longitude < 1 || inU.longitude > 2 || inU.latitude < 1) && inU.longitude > 0 && inU.longitude < 3;
  assert.ok(insideU, `inside the U: ${JSON.stringify(inU)}`);
  // Several areas: inside the largest.
  assert.deepEqual(
    at({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [0.1, 0],
            [0.1, 0.1],
            [0, 0],
          ],
        ],
        [square],
      ],
    }),
    { latitude: 11, longitude: 11 },
  );
  // Across the antimeridian: the middle of the box from 179° E to 179° W is on 180°, not 0°.
  const across = at({
    type: 'Polygon',
    coordinates: [
      [
        [179, -1],
        [-179, -1],
        [-179, 1],
        [179, 1],
        [179, -1],
      ],
    ],
  })!;
  assert.equal(Math.abs(across.longitude), 180);
  assert.equal(across.latitude, 0);
  // A point keeps its altitude only when asked; a line or an area has none.
  assert.deepEqual(at({ type: 'Point', coordinates: [5, 6, 100] }), { latitude: 6, longitude: 5, altitudeM: 100 });
});

test('concat: several fields joined into one id, missing when any part is', () => {
  const m = compileMapping({
    externalId: { concat: ['properties.bin', 'properties.tau'] },
    position: { lat: 'lat', lon: 'lon' },
    properties: { slot: { concat: ['properties.bin', 'properties.tau'], separator: '/' } },
  });
  const r = mapRecord({ lat: 1, lon: 2, properties: { bin: 'CP2', tau: 24 } }, m);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.record.externalId, 'CP2:24');
    assert.equal(r.record.properties['slot'], 'CP2/24');
  }
  assert.equal(mapRecord({ lat: 1, lon: 2, properties: { bin: 'CP2' } }, m).ok, false, 'no tau: no id');
  assert.equal(
    mapRecord({ lat: 1, lon: 2, properties: { bin: 'CP2', tau: { h: 1 } } }, m).ok,
    false,
    'an object is not text',
  );
  assert.throws(() => compileMapping({ externalId: { concat: ['a'] } }), /concat must list 2 to 8 paths/);
  assert.throws(() => compileMapping({ externalId: { concat: ['a', 'b'], path: 'c' } }), /both concat and a path/);
  assert.throws(
    () => compileMapping({ externalId: { concat: ['a', 'b'], literal: 'x' } }),
    /both a literal and a path/,
  );
});

test('concat: a part may list alternatives, the first holding a value is used', () => {
  // A line's first vertex, whether the service sends a LineString or a MultiLineString.
  const m = compileMapping({
    externalId: {
      concat: [
        'properties.storm',
        ['geometry.coordinates[0][0]', 'geometry.coordinates[0][0][0]'],
        ['geometry.coordinates[0][1]', 'geometry.coordinates[0][0][1]'],
      ],
    },
    position: { geometry: 'geometry' },
  });
  const line = {
    type: 'LineString',
    coordinates: [
      [-102.7, 7],
      [-105.1, 14.5],
    ],
  };
  const multi = {
    type: 'MultiLineString',
    coordinates: [
      [
        [179.5, 20],
        [180, 20.5],
      ],
      [
        [-180, 20.5],
        [-179.5, 21],
      ],
    ],
  };
  const a = mapRecord({ properties: { storm: 'EP172026' }, geometry: line }, m);
  const b = mapRecord({ properties: { storm: 'WP012026' }, geometry: multi }, m);
  assert.ok(a.ok && b.ok);
  if (a.ok) assert.equal(a.record.externalId, 'EP172026:-102.7:7');
  if (b.ok) assert.equal(b.record.externalId, 'WP012026:179.5:20');
  assert.equal(
    mapRecord({ properties: { storm: 'X' }, geometry: { type: 'Point', coordinates: [1, 2] } }, m).ok,
    false,
  );
  assert.throws(
    () => compileMapping({ externalId: { concat: ['a', ['b', 'c', 'd', 'e', 'f']] } }),
    /a concat part lists 1 to 4 paths/,
  );
  assert.throws(() => compileMapping({ externalId: { concat: ['a', []] } }), /a concat part lists 1 to 4 paths/);
});
