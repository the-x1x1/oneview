import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, manifestSchema, testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import type { GeoBounds, Observation } from '@worldview/world-model';
import { defaultConnectorRegistry, formatSuite, runConnectorSuite, type SuiteFixtures } from '../../index.js';
import {
  ARCGIS_MAX_SHRINKS,
  ARCGIS_MIN_PAGE_SIZE,
  ArcGisFeatureProvider,
  LAYER_INFO_TTL_MS,
  envelopesFor,
  requestsPerPoll,
  validateArcGisFeature,
  wantsNextPage,
} from './feature.js';
import {
  arcgisError,
  esriFeatureSetToGeoJson,
  esriGeometryToGeoJson,
  geoJsonCrsProblem,
  readGeoJsonFeatureSet,
  spatialReferenceProblem,
  type GeoJsonGeometry,
} from './esri-json.js';
import { checkLayerInfo, layerDateFields, layerEndpoint, parseLayerInfo, preferredFormat } from './layer-info.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const examplesDir = path.join(root, 'connectors', 'examples', 'arcgis');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const fixture = (name: string) => read(`fixtures/connectors/arcgis/${name}`);
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(examplesDir, name), 'utf8')) as Record<string, unknown>;
const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const HAWAII: GeoBounds = { west: -160, south: 18, east: -154, north: 23 };

type Responder = (req: ProviderHttpRequest) => testing.FixtureResponse;
const ok = (body: string): testing.FixtureResponse => ({ status: 200, body });
const isQuery = (req: ProviderHttpRequest) => new URL(req.url).pathname.endsWith('/query');
const params = (req: ProviderHttpRequest) =>
  req.method === 'POST' ? new URLSearchParams(String(req.body)) : new URL(req.url).searchParams;
/** Layer description for `…/<n>?f=json`, query answers from `query` for `…/<n>/query`. */
const layerAndQuery =
  (layer: string, query: Responder): Responder =>
  (req) =>
    isQuery(req) ? query(req) : ok(layer);

async function start(doc: Record<string, unknown>, responder: Responder, credentials: string[] = []) {
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  const provider = defaultConnectorRegistry.createProvider(v.definition) as ArcGisFeatureProvider;
  assert.ok(provider instanceof ArcGisFeatureProvider);
  const clock = new testing.VirtualClock(NOW);
  const ctx = testing.createFixtureContext({ providerId: String(doc['id']), clock, responder, credentials });
  await provider.initialize(ctx);
  await provider.start();
  const poll = (bounds?: GeoBounds, signal = new AbortController().signal) =>
    provider.query!({ signal, background: true, ...(bounds ? { bounds } : {}) });
  return { provider, ctx, clock, poll, queries: () => ctx.http.requests.filter(isQuery) };
}

const incidents = () => example('nifc-wildfire-incidents.json');
const withQuery = (doc: Record<string, unknown>, query: Record<string, unknown>) => ({
  ...doc,
  endpoint: {
    ...(doc['endpoint'] as object),
    query: { ...((doc['endpoint'] as { query?: object }).query ?? {}), ...query },
  },
});
const withPagination = (doc: Record<string, unknown>, pagination: unknown) => ({ ...doc, pagination });
const offsetLimit = (limit: number, maxPages = 10) => ({
  strategy: 'offset-limit',
  offsetParam: 'resultOffset',
  limitParam: 'resultRecordCount',
  limit,
  maxPages,
});
const essentials = (o: Observation) => ({
  externalId: o.externalId,
  observedAt: o.observedAt,
  position: o.position,
  payload: o.payload,
  flags: o.quality.flags,
});
async function rejects(p: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ProviderError, String(err));
    assert.equal(err.code, code, err.message);
    if (message) assert.match(err.message, message);
    return;
  }
  assert.fail(`expected ${code}`);
}

// ── the shared suite on every example ────────────────────────────────────────

/** A sidecar as SuiteFixtures: fixture paths or inline bodies, counts, ids (the CLI adds field expectations). */
function sidecarFixtures(name: string): SuiteFixtures {
  const s = JSON.parse(readFileSync(path.join(examplesDir, name.replace(/\.json$/, '.test.json')), 'utf8')) as {
    normal: string;
    empty: string;
    malformed: Array<string | { inline: string }>;
    expectObservations: number;
    expectIds?: string[];
  };
  const body = (src: string | { inline: string }) => (typeof src === 'string' ? read(src) : src.inline);
  return {
    normal: body(s.normal),
    empty: body(s.empty),
    malformed: s.malformed.map(body),
    expectObservations: s.expectObservations,
    ...(s.expectIds ? { expectIds: s.expectIds } : {}),
  };
}

test('arcgis: every example passes the shared connector suite from its sidecar', async () => {
  const names = readdirSync(examplesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'));
  assert.equal(names.length, 3, 'a FeatureServer point layer, a polygon layer and a MapServer layer');
  for (const name of names) {
    const doc = example(name);
    assert.equal(doc['connector'], 'arcgis-feature');
    assert.equal(doc['review'], 'user-configured');
    assert.equal(doc['enabled'], false);
    assert.equal(doc['dataPolicy'], undefined, 'no policy opened');
    const r = await runConnectorSuite(doc, sidecarFixtures(name));
    assert.ok(r.passed, `${name}\n${formatSuite(r)}`);
  }
});

test('arcgis: the connector is registered and its manifests cover a whole poll', () => {
  assert.ok(defaultConnectorRegistry.ids().includes('arcgis-feature'));
  for (const name of readdirSync(examplesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'))) {
    const v = defaultConnectorRegistry.validate(example(name));
    assert.ok(v.ok && v.definition, v.errors.join('; '));
    const m = defaultConnectorRegistry.createProvider(v.definition).manifest;
    const parsed = manifestSchema.parse(m);
    assert.ok(parsed.ok, `${name} manifest invalid: ${JSON.stringify(parsed)}`);
    const perPoll = requestsPerPoll(v.definition);
    assert.ok(
      m.refreshPolicy.maxRequestsPerMinute >= perPoll + 1,
      `${name}: ${m.refreshPolicy.maxRequestsPerMinute}/min < ${perPoll} + 1`,
    );
    assert.match(m.description ?? '', /Connector: ArcGIS/);
    assert.equal(m.enabledByDefault, false);
    assert.equal(m.commercialReview, 'manual-review-required');
    assert.deepEqual(m.allowedHosts, [new URL(v.definition.endpoint!.url).hostname]);
  }
  // Ten pages at a fifteen-minute cadence with a bounds query: the layer description, 10 × 2
  // pages and four retries with smaller pages — plus a retry.
  const perimeters = defaultConnectorRegistry.validate(example('nifc-wildfire-perimeters.json')).definition!;
  assert.equal(requestsPerPoll(perimeters), 1 + 10 * 2 + ARCGIS_MAX_SHRINKS);
  assert.ok(defaultConnectorRegistry.createProvider(perimeters).manifest.refreshPolicy.maxRequestsPerMinute >= 26);
  const once = defaultConnectorRegistry.validate(withPagination(incidents(), { strategy: 'none' })).definition!;
  assert.equal(requestsPerPoll(once), 2, 'no paging, no smaller pages');
});

// ── esriJSON → GeoJSON ───────────────────────────────────────────────────────

/** Twice the signed area: positive clockwise (x east, y north). */
const area2 = (ring: number[][]) =>
  ring.slice(0, -1).reduce((s, [x1, y1], i) => s + (ring[i + 1]![0]! - x1!) * (ring[i + 1]![1]! + y1!), 0);

test('esriJSON: points, multipoints and polylines, with Z kept only when the geometry has Z', () => {
  assert.deepEqual(esriGeometryToGeoJson({ x: -155.5, y: 19.5 }), { type: 'Point', coordinates: [-155.5, 19.5] });
  assert.deepEqual(esriGeometryToGeoJson({ x: 1, y: 2, z: 30 }, { hasZ: true }), {
    type: 'Point',
    coordinates: [1, 2, 30],
  });
  assert.deepEqual(esriGeometryToGeoJson({ x: 1, y: 2, m: 7 }, { hasM: true }), { type: 'Point', coordinates: [1, 2] });
  assert.equal(esriGeometryToGeoJson({ x: 'NaN', y: 'NaN' }), null, 'an empty point');
  assert.equal(esriGeometryToGeoJson({ x: null, y: null }), null);
  assert.equal(esriGeometryToGeoJson({}), null);
  assert.equal(esriGeometryToGeoJson(null), null);
  assert.deepEqual(
    esriGeometryToGeoJson(
      {
        points: [
          [1, 2, 99],
          [3, 4, 98],
        ],
      },
      { hasZ: false, hasM: true },
    ),
    {
      type: 'MultiPoint',
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    },
    'with M and no Z the third value is a measure, not a height',
  );
  assert.deepEqual(
    esriGeometryToGeoJson({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    }),
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  );
  assert.deepEqual(
    esriGeometryToGeoJson({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
        [[5, 5]],
        [
          [2, 2],
          [3, 3, 10],
        ],
      ],
      hasZ: true,
    }),
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3, 10],
        ],
      ],
    },
    'a one-point path is dropped',
  );
  assert.match(String(esriGeometryToGeoJson({ curvePaths: [] })), /true curves/);
  assert.match(String(esriGeometryToGeoJson({ paths: [[[0, 'a']]] })), /not a pair of numbers/);
  assert.match(String(esriGeometryToGeoJson({ foo: 1 })), /unrecognised/);
  assert.deepEqual(esriGeometryToGeoJson({ xmin: 0, ymin: 0, xmax: 2, ymax: 1 }), {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 1],
        [0, 1],
        [0, 0],
      ],
    ],
  });
});

test('esriJSON: rings become RFC 7946 polygons — exteriors counter-clockwise, holes clockwise and in the right exterior', () => {
  // One clockwise ring, not closed: closed and turned counter-clockwise.
  const single = esriGeometryToGeoJson({
    rings: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ],
    ],
  }) as GeoJsonGeometry;
  assert.equal(single.type, 'Polygon');
  const ring = (single.coordinates as number[][][])[0]!;
  assert.deepEqual(ring[0], ring[ring.length - 1], 'closed');
  assert.ok(area2(ring) < 0, 'counter-clockwise');

  // An island in a lake in a field: exterior A, hole H inside A, exterior B inside H.
  const A = [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
    [0, 0],
  ]; // clockwise
  const H = [
    [2, 2],
    [8, 2],
    [8, 8],
    [2, 8],
    [2, 2],
  ]; // counter-clockwise
  const B = [
    [4, 4],
    [4, 6],
    [6, 6],
    [6, 4],
    [4, 4],
  ]; // clockwise
  const island = esriGeometryToGeoJson({ rings: [B, H, A] }) as GeoJsonGeometry;
  assert.equal(island.type, 'MultiPolygon');
  const polys = island.coordinates as number[][][][];
  const withHole = polys.find((p) => p.length === 2)!;
  const alone = polys.find((p) => p.length === 1)!;
  assert.ok(withHole && alone, JSON.stringify(polys));
  assert.deepEqual(withHole[0]!.slice().sort(), A.slice().sort(), 'the hole belongs to the big exterior');
  assert.ok(area2(withHole[0]!) < 0 && area2(withHole[1]!) > 0, 'exterior CCW, hole CW');
  assert.deepEqual(alone[0]!.slice().sort(), B.slice().sort());
  assert.ok(area2(alone[0]!) < 0);

  // Two exteriors, each with its own hole.
  const far = [
    [20, 0],
    [20, 10],
    [30, 10],
    [30, 0],
    [20, 0],
  ];
  const farHole = [
    [22, 2],
    [28, 2],
    [28, 8],
    [22, 8],
    [22, 2],
  ];
  const two = esriGeometryToGeoJson({ rings: [A, far, farHole, H] }) as GeoJsonGeometry;
  assert.equal(two.type, 'MultiPolygon');
  for (const p of two.coordinates as number[][][][]) assert.equal(p.length, 2, 'each exterior got its own hole');

  // A counter-clockwise ring that no exterior contains is an exterior drawn the other way.
  const reversed = esriGeometryToGeoJson({ rings: [H] }) as GeoJsonGeometry;
  assert.equal(reversed.type, 'Polygon');
  assert.ok(area2((reversed.coordinates as number[][][])[0]!) < 0);

  // Degenerate rings are dropped; nothing left is an empty geometry.
  assert.equal(
    esriGeometryToGeoJson({
      rings: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [0, 0],
        ],
      ],
    }),
    null,
  );
  assert.equal(esriGeometryToGeoJson({ rings: [] }), null);
});

test('esriJSON: a feature set — spatial reference 4326/4269 only, dates to ISO by field type, ids from the object id field', () => {
  const fields = [
    { name: 'FID', type: 'esriFieldTypeOID' },
    { name: 'when', type: 'esriFieldTypeDate' },
    { name: 'old', type: 'esriFieldTypeDate' },
    { name: 'label', type: 'esriFieldTypeString' },
  ];
  const features = [
    { attributes: { FID: 7, when: 1790188930000, old: -86400000, label: 'a' }, geometry: { x: 1, y: 2 } },
    { attributes: { FID: 8, when: null, old: '1969-12-31', label: 'b' }, geometry: { rings: 'bad' } },
  ];
  for (const sr of [{ wkid: 4326 }, { wkid: 4269, latestWkid: 4269 }, { wkid: 102100, latestWkid: 4326 }, undefined]) {
    const r = esriFeatureSetToGeoJson({ spatialReference: sr, fields, features });
    assert.ok(!('malformed' in r), JSON.stringify(sr));
  }
  const r = esriFeatureSetToGeoJson({
    spatialReference: { wkid: 4326 },
    fields,
    features,
    exceededTransferLimit: true,
  });
  assert.ok(!('malformed' in r));
  assert.equal(r.exceededTransferLimit, true);
  assert.equal(r.features[0]!.id, 7, 'the OID-typed field is the id when objectIdFieldName is absent');
  assert.equal(r.features[0]!.properties['when'], '2026-09-23T18:42:10.000Z');
  assert.equal(r.features[0]!.properties['old'], '1969-12-31T00:00:00.000Z', 'before 1970 is still a date');
  assert.equal(r.features[1]!.properties['when'], null, 'null stays null');
  assert.equal(r.features[1]!.properties['old'], '1969-12-31', 'a string is left as it is');
  assert.equal(r.features[1]!.geometry, null, 'an unreadable geometry is null, the feature kept');
  assert.match(r.problems[0] ?? '', /feature 1: rings is not an array/);
  const named = esriFeatureSetToGeoJson({ objectIdFieldName: 'label', fields, features });
  assert.ok(!('malformed' in named) && named.features[0]!.id === 'a', 'objectIdFieldName wins');
  const fromLayer = esriFeatureSetToGeoJson(
    { features: [{ attributes: { X: 3, d: 0 } }] },
    {
      objectIdField: 'X',
      dates: new Set(['d']),
    },
  );
  assert.ok(!('malformed' in fromLayer));
  assert.equal(fromLayer.features[0]!.id, 3);
  assert.equal(fromLayer.features[0]!.properties['d'], '1970-01-01T00:00:00.000Z', 'layer date fields apply too');
  assert.equal(fromLayer.exceededTransferLimit, undefined);

  assert.match(spatialReferenceProblem({ wkid: 102100, latestWkid: 3857 }) ?? '', /3857 is not 4326 or 4269/);
  assert.match(spatialReferenceProblem({ wkid: 2230 }) ?? '', /2230/);
  assert.match(spatialReferenceProblem({ wkt: 'PROJCS[…]' }) ?? '', /WKT/);
  const bad = esriFeatureSetToGeoJson({ spatialReference: { wkid: 3857 }, features: [] });
  assert.ok('malformed' in bad);
});

test('GeoJSON as ArcGIS writes it: exceededTransferLimit at the top or under properties; crs other than WGS 84 refused', () => {
  const fc = (extra: object) => ({ type: 'FeatureCollection', features: [], ...extra });
  const exceeded = (body: object) => {
    const r = readGeoJsonFeatureSet(body);
    assert.ok(!('malformed' in r));
    return r.exceededTransferLimit;
  };
  assert.equal(exceeded(fc({ properties: { exceededTransferLimit: true } })), true, 'ArcGIS Online');
  assert.equal(exceeded(fc({ exceededTransferLimit: true })), true);
  assert.equal(exceeded(fc({ exceededTransferLimit: false })), false);
  assert.equal(exceeded(fc({})), undefined);
  for (const name of ['EPSG:4326', 'urn:ogc:def:crs:OGC:1.3:CRS84', 'urn:ogc:def:crs:EPSG::4269'])
    assert.equal(geoJsonCrsProblem({ type: 'name', properties: { name } }), undefined, name);
  assert.match(geoJsonCrsProblem({ type: 'name', properties: { name: 'EPSG:3857' } }) ?? '', /3857/);
  assert.ok('malformed' in readGeoJsonFeatureSet(fc({ crs: { type: 'name', properties: { name: 'EPSG:2230' } } })));
  const dated = readGeoJsonFeatureSet(
    { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, geometry: null, properties: { t: 0, n: 5 } }] },
    new Set(['t']),
  );
  assert.ok(!('malformed' in dated));
  assert.deepEqual(dated.features[0]!.properties, { t: '1970-01-01T00:00:00.000Z', n: 5 });
});

test('the ArcGIS error envelope is recognised in a 200 body', () => {
  assert.deepEqual(arcgisError({ error: { code: 498, message: 'Invalid token.', details: [] } }), {
    code: 498,
    message: 'Invalid token.',
    details: [],
  });
  assert.equal(arcgisError({ error: { code: '400', message: 'x' } })?.code, 400);
  assert.equal(arcgisError({ type: 'FeatureCollection', features: [] }), undefined);
  assert.equal(arcgisError([]), undefined);
});

// ── the layer description ────────────────────────────────────────────────────

test('layer description: parsed for what the query needs; drawingInfo recorded; a feature set is not one', () => {
  const r = parseLayerInfo(JSON.parse(fixture('wfigs-incidents-layer.json')));
  assert.ok('info' in r);
  const info = r.info;
  assert.equal(info.type, 'Feature Layer');
  assert.equal(info.objectIdField, 'OBJECTID');
  assert.equal(info.globalIdField, 'GlobalID');
  assert.equal(info.maxRecordCount, 2000);
  assert.deepEqual(info.supportedQueryFormats, ['json', 'geojson', 'pbf']);
  assert.equal(info.supportsPagination, true);
  assert.equal(info.supportsOrderBy, true);
  assert.equal(info.extent?.wkid, 4269);
  assert.ok(info.drawingInfo, 'drawingInfo is kept');
  assert.deepEqual([...layerDateFields(info)].sort(), ['FireDiscoveryDateTime', 'ModifiedOnDateTime_dt']);
  assert.equal(preferredFormat(info), 'geojson');
  assert.equal(
    preferredFormat({ ...info, supportedQueryFormats: ['json', 'pbf'] }),
    'json',
    'the format list decides, whatever the version',
  );

  const nws = parseLayerInfo(JSON.parse(fixture('nws-wwa-layer.json')));
  assert.ok('info' in nws);
  assert.equal(nws.info.objectIdField, 'objectid', 'from the OID-typed field when objectIdField is absent');
  assert.deepEqual([...layerDateFields(nws.info)].sort(), ['idp_filedate', 'idp_ingestdate']);

  const legacy = parseLayerInfo(JSON.parse(fixture('legacy-layer.json')));
  assert.ok('info' in legacy);
  assert.equal(preferredFormat(legacy.info), 'json', 'no geoJSON in supportedQueryFormats');
  assert.equal(preferredFormat({ ...legacy.info, supportedQueryFormats: [] }), 'json', '10.31 without a format list');
  assert.equal(preferredFormat({ ...legacy.info, supportedQueryFormats: [], currentVersion: 10.41 }), 'geojson');
  assert.equal(preferredFormat(undefined), 'geojson');
  const old = parseLayerInfo({ currentVersion: 10.21, type: 'Feature Layer', fields: [], maxRecordCount: 1000 });
  assert.ok('info' in old);
  assert.equal(old.info.supportsPagination, false, 'before 10.3 a layer cannot page');

  assert.ok('notLayer' in parseLayerInfo(JSON.parse(fixture('wfigs-incidents.geojson'))));
  assert.ok('notLayer' in parseLayerInfo(JSON.parse(fixture('legacy-query.json'))), 'esriJSON has fields too');
  assert.ok('notLayer' in parseLayerInfo({ other: 1 }));
  assert.ok('notLayer' in parseLayerInfo([]));
});

test('layer check: fields the definition names but the layer lacks, date transforms, the GlobalID, copyrightText', () => {
  const parsed = parseLayerInfo(JSON.parse(fixture('wfigs-incidents-layer.json')));
  assert.ok('info' in parsed);
  const info = parsed.info;
  const d = defaultConnectorRegistry.validate(incidents()).definition!;
  assert.deepEqual(checkLayerInfo(d, info), [], 'the example fits its layer');

  const wrong = defaultConnectorRegistry.validate({
    ...incidents(),
    endpoint: { ...(incidents()['endpoint'] as object), query: { outFields: 'OBJECTID,NoSuchField' } },
    mapping: {
      externalId: 'properties.OBJECTID',
      observedAt: { path: 'properties.ModifiedOnDateTime_dt', transform: 'unixMillis' },
      labels: { name: 'properties.incidentname', other: 'properties.Missing' },
    },
    attribution: { text: 'Somebody' },
  }).definition!;
  const w = checkLayerInfo(wrong, { ...info, copyrightText: 'Esri, NIFC' }).join('\n');
  assert.match(w, /outFields names NoSuchField/);
  assert.match(w, /properties\.Missing, which is not one of the layer's fields/);
  assert.match(w, /spelled IncidentName/);
  assert.match(w, /ModifiedOnDateTime_dt is a date field.*isoTimestamp/);
  assert.match(w, /GlobalID field \(GlobalID\)/);
  assert.match(w, /copyrightText is "Esri, NIFC" — consider it for attribution\.text/);

  const { geometryType: _geometryType, ...noGeometry } = info;
  const table = checkLayerInfo(d, {
    ...noGeometry,
    type: 'Table',
    supportsPagination: false,
    capabilities: ['create'],
  }).join('\n');
  assert.match(table, /no geometry/);
  assert.match(table, /do not include Query/);
  assert.match(table, /cannot page/);
  assert.match(checkLayerInfo(d, { ...info, type: 'Group Layer' }).join('\n'), /Group Layer, which has no features/);
});

test('layer URLs: FeatureServer or MapServer, one layer, /query optional, no query string', () => {
  const ok1 = layerEndpoint('https://a.example.org/arcgis/rest/services/X/FeatureServer/0');
  assert.ok(!('error' in ok1));
  assert.equal(ok1.queryUrl, 'https://a.example.org/arcgis/rest/services/X/FeatureServer/0/query');
  const ok2 = layerEndpoint('https://a.example.org/server/rest/services/F/Y/MapServer/12/query/');
  assert.ok(!('error' in ok2));
  assert.equal(ok2.service, 'MapServer');
  assert.equal(ok2.layerId, 12);
  assert.equal(ok2.layerUrl, 'https://a.example.org/server/rest/services/F/Y/MapServer/12');
  assert.ok('error' in layerEndpoint('https://a.example.org/arcgis/rest/services/X/FeatureServer'));
  assert.ok('error' in layerEndpoint('https://a.example.org/arcgis/rest/services/X/ImageServer/0'));
  assert.ok('error' in layerEndpoint('https://a.example.org/arcgis/rest/services/X/FeatureServer/0?f=json'));
});

// ── validation ───────────────────────────────────────────────────────────────

test('validation: what the connector owns, what it does not read, and where a token goes', () => {
  const errs = (doc: Record<string, unknown>) => defaultConnectorRegistry.validate(doc).errors.join('\n');
  assert.equal(errs(incidents()), '');
  assert.match(errs(withQuery(incidents(), { resultOffset: 0 })), /set by the connector/);
  assert.match(errs(withQuery(incidents(), { ResultRecordCount: 10 })), /set by the connector/, 'case-insensitive');
  assert.match(errs(withQuery(incidents(), { token: 'abc' })), /a token is a secret/);
  assert.match(errs(withQuery(incidents(), { returnIdsOnly: true })), /reads features/);
  assert.match(errs(withQuery(incidents(), { returnCountOnly: 'true' })), /reads features/);
  assert.match(errs(withQuery(incidents(), { f: 'pbf' })), /f must be json or geojson/);
  assert.match(errs(withQuery(incidents(), { outSR: 3857 })), /outSR must be 4326/);
  assert.equal(errs(withQuery(incidents(), { outSR: 4326, f: 'json' })), '');
  assert.match(errs(withQuery(incidents(), { returnGeometry: false })), /returnGeometry is false/);
  assert.match(
    errs(withPagination(incidents(), { strategy: 'cursor', cursorParam: 'c', cursorPath: 'c' })),
    /does not apply/,
  );
  assert.match(
    errs(
      withPagination(incidents(), { strategy: 'offset-limit', offsetParam: 'offset', limitParam: 'limit', limit: 5 }),
    ),
    /resultOffset/,
  );
  assert.match(errs({ ...incidents(), response: { format: 'csv' } }), /ArcGIS answers JSON/);
  const perimeters = example('nifc-wildfire-perimeters.json');
  assert.match(errs(withQuery(perimeters, { geometry: '0,0,1,1' })), /set from the viewport/);
  assert.match(errs(withQuery(perimeters, { inSR: 3857 })), /set from the viewport/);
  assert.match(
    errs({ ...incidents(), endpoint: { url: 'https://a.example.org/arcgis/rest/services/X/FeatureServer' } }),
    /must name one layer/,
  );
  assert.match(
    errs({ ...incidents(), endpoint: { url: 'http://a.example.org/arcgis/rest/services/X/FeatureServer/0' } }),
    /https/,
  );
  assert.match(
    errs({ ...incidents(), endpoint: { url: 'https://10.0.0.5/arcgis/rest/services/X/FeatureServer/0' } }),
    /private/,
  );

  const warns = (doc: Record<string, unknown>) =>
    validateArcGisFeature(defaultConnectorRegistry.validate(doc).definition!).warnings.join('\n');
  assert.match(
    warns(withQuery(perimeters, { where: 'x > {west}' })),
    /placeholder, which this connector does not fill/,
  );
  assert.match(
    warns({
      ...incidents(),
      credentials: { key: { secretRef: 'x.key' } },
      endpoint: { ...(incidents()['endpoint'] as object), credential: { name: 'key', as: 'header', param: 'X-Key' } },
    }),
    /token query parameter/,
  );
  assert.match(
    warns({ ...incidents(), mapping: { ...(incidents()['mapping'] as object), externalId: 'id' } }),
    /object id/,
  );
});

// ── polling: paging, fallback, bounds, errors ────────────────────────────────

test('paging: exceededTransferLimit carries on even after a short page; a short page without it ends', async () => {
  const pages: Record<string, string> = { '0': 'paging-1.geojson', '2': 'paging-2.geojson', '3': 'paging-3.geojson' };
  const { poll, queries, ctx, provider, clock } = await start(
    withPagination(incidents(), offsetLimit(2)),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), (req) =>
      ok(fixture(pages[params(req).get('resultOffset')!]!)),
    ),
  );
  const obs = await poll();
  assert.equal(obs.length, 4);
  const qs = queries().map(params);
  assert.deepEqual(
    qs.map((p) => p.get('resultOffset')),
    ['0', '2', '3'],
  );
  for (const p of qs) {
    assert.equal(p.get('resultRecordCount'), '2', 'min(limit, maxRecordCount)');
    assert.equal(p.get('orderByFields'), 'OBJECTID', 'a stable order while paging');
    assert.equal(p.get('outSR'), '4326');
    assert.equal(p.get('f'), 'geojson');
    assert.equal(p.get('where'), "IncidentTypeCategory = 'WF'");
  }
  assert.equal((await provider.health()).message, undefined);
  // The layer description is read once, then again only after it is six hours old.
  assert.equal(ctx.http.requests.length, 4);
  await poll();
  assert.equal(ctx.http.requests.filter((r) => !isQuery(r)).length, 1);
  clock.advance(LAYER_INFO_TTL_MS + 1);
  await poll();
  assert.equal(ctx.http.requests.filter((r) => !isQuery(r)).length, 2);
});

test('paging: the page size is the smaller of the definition limit and maxRecordCount; a full silent page asks again', async () => {
  const layer = JSON.stringify({ ...JSON.parse(fixture('wfigs-incidents-layer.json')), maxRecordCount: 2 });
  const { poll, queries } = await start(
    withPagination(incidents(), offsetLimit(5000)),
    layerAndQuery(layer, (req) => {
      const at = params(req).get('resultOffset');
      const body = JSON.parse(fixture('paging-1.geojson')) as { properties?: unknown };
      delete body.properties; // a full page that does not say whether there is more
      return ok(at === '0' ? JSON.stringify(body) : fixture('wfigs-incidents-empty.geojson'));
    }),
  );
  assert.equal((await poll()).length, 2);
  assert.deepEqual(
    queries().map((r) => [params(r).get('resultOffset'), params(r).get('resultRecordCount')]),
    [
      ['0', '2'],
      ['2', '2'],
    ],
  );
  assert.equal(wantsNextPage(2, undefined, 2), true);
  assert.equal(wantsNextPage(1, undefined, 2), false);
  assert.equal(wantsNextPage(1, true, 2), true);
  assert.equal(wantsNextPage(2, false, 2), false);
  assert.equal(wantsNextPage(0, true, 2), false);
  assert.equal(wantsNextPage(5, undefined, undefined), false, 'never the page size alone');
});

test('paging: maxPages, a server that ignores resultOffset, pagination off, and a layer that cannot page are all reported', async () => {
  const always = layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('paging-1.geojson')));
  const capped = await start(withPagination(incidents(), offsetLimit(2, 1)), always);
  await capped.poll();
  assert.equal(capped.queries().length, 1);
  assert.match(
    (await capped.provider.health()).message ?? '',
    /stopped after 1 page\(s\) \(2 features\) with more on the server/,
  );

  // Same page whatever the offset: the second brings nothing new, so paging stops there.
  const ignored = await start(withPagination(incidents(), offsetLimit(2, 10)), always);
  assert.equal((await ignored.poll()).length, 2);
  assert.equal(ignored.queries().length, 2);
  assert.match((await ignored.provider.health()).message ?? '', /repeated a page/);
  assert.ok(ignored.ctx.logger.entries.some((e) => e.message === 'arcgis layer truncated'));

  const off = await start(withPagination(incidents(), { strategy: 'none' }), always);
  await off.poll();
  assert.equal(off.queries().length, 1);
  assert.equal(params(off.queries()[0]!).get('resultOffset'), null);
  assert.match((await off.provider.health()).message ?? '', /pagination is off: only the first 2 features/);

  const noPaging = JSON.stringify({
    ...JSON.parse(fixture('wfigs-incidents-layer.json')),
    advancedQueryCapabilities: { supportsPagination: false },
  });
  const cannot = await start(
    incidents(),
    layerAndQuery(noPaging, () => ok(fixture('paging-1.geojson'))),
  );
  await cannot.poll();
  assert.equal(cannot.queries().length, 1);
  assert.equal(params(cannot.queries()[0]!).get('resultOffset'), null, 'no resultOffset to a layer that cannot page');
  assert.match((await cannot.provider.health()).message ?? '', /cannot page/);
  assert.ok(
    cannot.ctx.logger.entries.some(
      (e) => e.message === 'arcgis layer check' && JSON.stringify(e.fields).includes('cannot page'),
    ),
  );
});

test('fallback: a 10.3 layer without geoJSON is asked for f=json, and the esriJSON maps to the same observations', async () => {
  const modern = await start(
    incidents(),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('wfigs-incidents.geojson'))),
  );
  const legacy = await start(
    incidents(),
    layerAndQuery(fixture('legacy-layer.json'), () => ok(fixture('legacy-query.json'))),
  );
  const a = await modern.poll();
  const b = await legacy.poll();
  assert.equal(params(modern.queries()[0]!).get('f'), 'geojson');
  assert.equal(params(legacy.queries()[0]!).get('f'), 'json');
  assert.equal(a.length, 3);
  assert.deepEqual(b.map(essentials), a.map(essentials), 'one definition, either format');
  const fixtureCanyon = a.find((o) => o.payload['name'] === 'Fixture Canyon')!;
  assert.equal(fixtureCanyon.payload['discoveredAt'], '2026-09-21T03:15:00.000Z', 'date field, ISO in both paths');
  assert.equal(fixtureCanyon.observedAt, '2026-09-23T18:42:10.000Z');
  assert.ok(
    legacy.ctx.logger.entries.some((e) => e.message === 'rejected records'),
    'the feature without geometry',
  );

  // The definition can fix the format.
  const forced = await start(
    withQuery(incidents(), { f: 'json' }),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('legacy-query.json'))),
  );
  assert.equal((await forced.poll()).length, 3);
  assert.equal(params(forced.queries()[0]!).get('f'), 'json');
  assert.deepEqual(
    forced.queries().map((r) => new URL(r.url).searchParams.getAll('f')),
    [['json']],
    'one f',
  );
});

test('outSR: always 4326; a server answering in another system is MALFORMED, not reprojected', async () => {
  const { poll, queries } = await start(
    withQuery(incidents(), { outsr: '4326' }),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('wfigs-incidents.geojson'))),
  );
  await poll();
  const url = new URL(queries()[0]!.url);
  assert.deepEqual(
    [...url.searchParams.keys()].filter((k) => k.toLowerCase() === 'outsr'),
    ['outSR'],
    'one outSR',
  );
  assert.equal(url.searchParams.get('outSR'), '4326');

  const mercator = JSON.stringify({
    ...JSON.parse(fixture('legacy-query.json')),
    spatialReference: { wkid: 102100, latestWkid: 3857 },
  });
  const m = await start(
    incidents(),
    layerAndQuery(fixture('legacy-layer.json'), () => ok(mercator)),
  );
  await rejects(m.poll(), 'MALFORMED', /3857 is not 4326 or 4269/);
  const nad83 = JSON.stringify({ ...JSON.parse(fixture('legacy-query.json')), spatialReference: { wkid: 4269 } });
  const n = await start(
    incidents(),
    layerAndQuery(fixture('legacy-layer.json'), () => ok(nad83)),
  );
  assert.equal((await n.poll()).length, 3, 'NAD83 is read as longitude/latitude');
});

test('bounds: the viewport as an envelope in 4326, two envelopes across the antimeridian, nothing before a viewport', async () => {
  const perimeters = example('nifc-wildfire-perimeters.json');
  const { poll, queries, provider } = await start(perimeters, (req) =>
    isQuery(req) ? ok(fixture('wfigs-perimeters.json')) : ok(fixture('wfigs-incidents-layer.json')),
  );
  assert.deepEqual(await poll(), [], 'no viewport yet');
  assert.equal(queries().length, 0);
  assert.match((await provider.health()).message ?? '', /waiting for a viewport/);

  const obs = await poll(HAWAII);
  assert.equal(obs.length, 3);
  const p = params(queries()[0]!);
  assert.equal(p.get('geometry'), '-160.00000,18.00000,-154.00000,23.00000');
  assert.equal(p.get('geometryType'), 'esriGeometryEnvelope');
  assert.equal(p.get('inSR'), '4326');
  assert.equal(p.get('spatialRel'), 'esriSpatialRelIntersects');
  assert.equal(p.get('geometryPrecision'), '5', "the definition's own parameters pass through");
  assert.equal(new URL(queries()[0]!.url).pathname.endsWith('/FeatureServer/0/query'), true, 'the URL named /query');

  // Across the antimeridian: two envelopes, and a feature both return is one observation.
  const before = queries().length;
  const across = await poll({ west: 170, south: -20, east: -170, north: -10 });
  const envelopes = queries()
    .slice(before)
    .map((r) => params(r).get('geometry'));
  assert.deepEqual(envelopes, ['170.00000,-20.00000,180.00000,-10.00000', '-180.00000,-20.00000,-170.00000,-10.00000']);
  assert.equal(across.length, 3, 'deduplicated across the two envelopes');

  assert.deepEqual(envelopesFor({ west: -10, south: 5, east: 10, north: -5 }), [[-10, -5, 10, 5]]);
  assert.deepEqual(envelopesFor({ west: -200, south: -95, east: 200, north: 95 }), [[-180, -90, 180, 90]]);
});

test('polygons through the connector: holes and multipolygons survive to the observation geometry', async () => {
  const { poll } = await start(example('nifc-wildfire-perimeters.json'), (req) =>
    isQuery(req) ? ok(fixture('wfigs-perimeters.json')) : ok(fixture('wfigs-incidents-layer.json')),
  );
  const obs = await poll(HAWAII);
  const kipuka = obs.find((o) => o.payload['name'] === 'Sample Kipuka')!;
  assert.equal(kipuka.geometry?.type, 'Polygon');
  const rings = kipuka.geometry!.coordinates as number[][][];
  assert.equal(rings.length, 2, 'exterior and hole');
  assert.ok(area2(rings[0]!) < 0 && area2(rings[1]!) > 0);
  assert.equal(obs.find((o) => o.payload['name'] === 'Example Spot')!.geometry?.type, 'MultiPolygon');
  assert.equal(kipuka.payload['perimeterAt'], '2026-09-22T06:00:00.000Z');
});

test('errors in a 200 body: 498/499 are AUTH, 5xx a server error, anything else MALFORMED with the message', async () => {
  const envelope = (code: number, message: string) => JSON.stringify({ error: { code, message, details: [] } });
  const cases: Array<[number, string, RegExp]> = [
    [498, 'AUTH', /Invalid token/],
    [499, 'AUTH', /Invalid token/],
    [403, 'AUTH', /Invalid token/],
    [500, 'HTTP_5XX', /ArcGIS error 500/],
    [400, 'MALFORMED', /ArcGIS error 400: Invalid token/],
  ];
  for (const [code, expected, message] of cases) {
    const onQuery = await start(
      incidents(),
      layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(envelope(code, 'Invalid token.'))),
    );
    await rejects(onQuery.poll(), expected, message);
    const onLayer = await start(incidents(), () => ok(envelope(code, 'Invalid token.')));
    await rejects(onLayer.poll(), expected, /layer description/);
  }
  // A refused query drops the layer description, so the next poll reads it again.
  let refuse = true;
  const again = await start(
    incidents(),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () =>
      refuse ? ok(envelope(400, "Invalid field: 'IncidentTypeCategory'")) : ok(fixture('wfigs-incidents.geojson')),
    ),
  );
  await rejects(again.poll(), 'MALFORMED', /Invalid field/);
  refuse = false;
  assert.equal((await again.poll()).length, 3);
  assert.equal(again.ctx.http.requests.filter((r) => !isQuery(r)).length, 2);
});

test('the token: a credential the host attaches to both requests as ?token=, never a value in the definition', async () => {
  const doc = {
    ...incidents(),
    credentials: { token: { secretRef: 'county-gis.token', label: 'County GIS token', kind: 'token' } },
    endpoint: { ...(incidents()['endpoint'] as object), credential: { name: 'token', as: 'query', param: 'token' } },
  };
  assert.deepEqual(validateArcGisFeature(defaultConnectorRegistry.validate(doc).definition!).warnings, []);
  const { poll, ctx } = await start(
    doc,
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('wfigs-incidents.geojson'))),
    ['county-gis.token'],
  );
  await poll();
  assert.equal(ctx.http.requests.length, 2);
  for (const r of ctx.http.requests) {
    assert.deepEqual(r.credential, { key: 'county-gis.token', as: 'query', name: 'token' });
    assert.ok(!r.url.includes('token='), 'the provider never writes the token');
  }
});

test('POST: the query goes as a form body, and the body is part of the cache key', async () => {
  const doc = { ...incidents(), endpoint: { ...(incidents()['endpoint'] as object), method: 'POST' } };
  const { poll, queries } = await start(
    doc,
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('wfigs-incidents.geojson'))),
  );
  assert.equal((await poll()).length, 3);
  const q = queries()[0]!;
  assert.equal(q.method, 'POST');
  assert.equal(new URL(q.url).search, '');
  assert.equal(q.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(String(q.body)).get('f'), 'geojson');
  assert.ok(q.cacheKey?.includes('#') && q.cacheKey.endsWith(String(q.body)));
});

test('the layer check runs when the description is read, and its warnings reach the log', async () => {
  const layer = JSON.stringify({ ...JSON.parse(fixture('wfigs-incidents-layer.json')), copyrightText: 'NIFC; Esri' });
  const { poll, ctx } = await start(
    incidents(),
    layerAndQuery(layer, () => ok(fixture('wfigs-incidents.geojson'))),
  );
  await poll();
  const check = ctx.logger.entries.find((e) => e.message === 'arcgis layer check');
  assert.ok(check, JSON.stringify(ctx.logger.entries));
  assert.match(JSON.stringify(check.fields), /copyrightText is \\"NIFC; Esri\\"/);
  const described = ctx.logger.entries.find((e) => e.message === 'arcgis layer');
  assert.deepEqual(described?.fields, {
    layer:
      'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0',
    name: 'Incidents',
    type: 'Feature Layer',
    version: 12,
    format: 'geojson',
    paged: true,
    pageSize: 2000,
  });
});

test('cancellation before and during a poll: CANCELLED, no partial batch', async () => {
  const abort = new AbortController();
  const { poll } = await start(
    withPagination(incidents(), offsetLimit(2)),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), (req) => {
      if (params(req).get('resultOffset') === '2') abort.abort();
      return ok(fixture('paging-1.geojson'));
    }),
  );
  await rejects(poll(undefined, abort.signal), 'CANCELLED');
});

test('a page whose features all lack a position does not throw away the pages before it', async () => {
  const noGeometry = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 9, geometry: null, properties: { GlobalID: 'x-9', IncidentName: 'Nowhere' } }],
  });
  const { poll, provider } = await start(
    withPagination(incidents(), offsetLimit(2)),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), (req) =>
      ok(params(req).get('resultOffset') === '0' ? fixture('paging-1.geojson') : noGeometry),
    ),
  );
  assert.equal((await poll()).length, 2);
  assert.match((await provider.health()).message ?? '', /1 record\(s\) rejected/);
  // Every record of a poll unusable is MALFORMED: the mapping does not fit the layer.
  const none = await start(
    incidents(),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(noGeometry)),
  );
  await rejects(none.poll(), 'MALFORMED', /none valid/);
});

test('a hole that touches its exterior at a vertex stays a hole, wherever its ring starts', () => {
  const exterior = [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
    [0, 0],
  ]; // clockwise
  // A counter-clockwise diamond touching the exterior at (5, 10), started at each of its vertices.
  const diamond = [
    [5, 10],
    [3, 5],
    [5, 2],
    [7, 5],
  ];
  for (let start = 0; start < diamond.length; start++) {
    const ring = [...diamond.slice(start), ...diamond.slice(0, start)];
    const g = esriGeometryToGeoJson({ rings: [exterior, [...ring, ring[0]!]] }) as GeoJsonGeometry;
    assert.equal(g.type, 'Polygon', `hole starting at ${JSON.stringify(ring[0])}`);
    assert.equal((g.coordinates as number[][][]).length, 2);
  }
  // Touching on the right-hand edge, the case ray casting gets wrong at the touching vertex.
  const right = [
    [10, 5],
    [5, 7],
    [2, 5],
    [5, 3],
    [10, 5],
  ];
  const g = esriGeometryToGeoJson({ rings: [exterior, right] }) as GeoJsonGeometry;
  assert.equal(g.type, 'Polygon');
  assert.equal((g.coordinates as number[][][]).length, 2);
});

test('the poll budget covers every request of a poll; each request keeps its own timeout', async () => {
  const perimeters = defaultConnectorRegistry.validate(example('nifc-wildfire-perimeters.json')).definition!;
  const m = defaultConnectorRegistry.createProvider(perimeters).manifest;
  // 25 requests of up to 20 s: the poll's own budget (ADR-003 pollBudgetMs); each request keeps 20 s.
  assert.equal(m.refreshPolicy.timeoutMs, 20_000);
  assert.equal(m.refreshPolicy.pollBudgetMs, 25 * 20_000 + 5000);
  const huge = defaultConnectorRegistry.validate(
    withPagination(example('nifc-wildfire-perimeters.json'), offsetLimit(200, 200)),
  ).definition!;
  assert.equal(defaultConnectorRegistry.createProvider(huge).manifest.refreshPolicy.pollBudgetMs, 600_000, 'capped');
  const { poll, ctx } = await start(
    incidents(),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('wfigs-incidents.geojson'))),
  );
  await poll();
  for (const r of ctx.http.requests) assert.equal(r.timeoutMs, 20_000);
});

test('while paging, the object id breaks ties in orderByFields the definition sets', async () => {
  const run = async (orderByFields: string) => {
    const s = await start(
      withQuery(withPagination(incidents(), offsetLimit(2)), { orderByFields }),
      layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('paging-3.geojson'))),
    );
    await s.poll();
    return params(s.queries()[0]!).get('orderByFields');
  };
  assert.equal(await run('ModifiedOnDateTime_dt DESC'), 'ModifiedOnDateTime_dt DESC,OBJECTID');
  assert.equal(await run('objectid ASC, IncidentName'), 'objectid ASC, IncidentName', 'already there');
});

test('GeoJSON dates become ISO 8601 by the field types of the layer, as in the esriJSON path', async () => {
  const doc = {
    ...incidents(),
    mapping: {
      ...(incidents()['mapping'] as object),
      properties: {
        modifiedRaw: 'properties.ModifiedOnDateTime_dt',
        discoveredRaw: 'properties.FireDiscoveryDateTime',
      },
    },
  };
  const withLayer = await start(
    doc,
    layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(fixture('wfigs-incidents.geojson'))),
  );
  const a = (await withLayer.poll()).find((o) => o.payload['name'] === 'Fixture Canyon')!;
  assert.equal(a.payload['modifiedRaw'], '2026-09-23T18:42:10.000Z');
  assert.equal(a.payload['discoveredRaw'], '2026-09-21T03:15:00.000Z');
  // Without a layer description there are no field types: the milliseconds pass as they came.
  const without = await start(doc, () => ok(fixture('wfigs-incidents.geojson')));
  const b = (await without.poll()).find((o) => o.payload['name'] === 'Fixture Canyon')!;
  assert.equal(b.payload['modifiedRaw'], 1790188930000);
});

test('a query answer that is not a feature set is MALFORMED even when the layer description is fine', async () => {
  for (const body of ['not json', '', '{"type":"FeatureCollection"}', '{"features":"x"}', '[]', '{"count":3}']) {
    const s = await start(
      incidents(),
      layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ok(body)),
    );
    await rejects(s.poll(), 'MALFORMED');
    assert.equal(s.queries().length, 1, `the query itself was asked for ${JSON.stringify(body)}`);
  }
});

test('validation: harmless false flags pass; a path credential is refused; a POST body is ignored with a warning', () => {
  const v = (doc: Record<string, unknown>) => defaultConnectorRegistry.validate(doc);
  assert.ok(v(withQuery(incidents(), { returnM: false, returnTrueCurves: 'false', returnIdsOnly: false })).ok);
  const pathCredential = v({
    ...incidents(),
    credentials: { token: { secretRef: 'x.token' } },
    endpoint: {
      url: 'https://a.example.org/arcgis/rest/services/{TOKEN}/FeatureServer/0',
      credential: { name: 'token', as: 'path' },
    },
  });
  assert.match(pathCredential.errors.join('\n'), /"path" does not apply/);
  const posted = v({
    ...incidents(),
    endpoint: { ...(incidents()['endpoint'] as object), method: 'POST', body: { a: 1 } },
  });
  assert.ok(posted.ok);
  assert.match(posted.warnings.join('\n'), /endpoint\.body is ignored/);
});

test('a page larger than maxBytes is asked for again at half the size, and the smaller size is kept', async () => {
  // The server's pages are too large above 100 features (heavy polygons, a wide viewport).
  const tooLarge = (req: ProviderHttpRequest): testing.FixtureResponse =>
    Number(params(req).get('resultRecordCount')) > 100
      ? { error: 'too-large' }
      : ok(params(req).get('resultOffset') === '0' ? fixture('paging-1.geojson') : fixture('paging-3.geojson'));
  const s = await start(
    withPagination(incidents(), offsetLimit(400)),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), tooLarge),
  );
  assert.equal((await s.poll()).length, 3);
  assert.deepEqual(
    s.queries().map((r) => [params(r).get('resultOffset'), params(r).get('resultRecordCount')]),
    [
      ['0', '400'],
      ['0', '200'],
      ['0', '100'],
      ['2', '100'],
    ],
    'same offset at half the size, then paging goes on at that size',
  );
  assert.ok(s.ctx.logger.entries.some((e) => e.message === 'arcgis page too large; asking for smaller pages'));
  // Retrying with a smaller page does not use up one of maxPages.
  const two = await start(
    withPagination(incidents(), offsetLimit(400, 2)),
    layerAndQuery(fixture('wfigs-incidents-layer.json'), tooLarge),
  );
  assert.equal((await two.poll()).length, 3);
  assert.equal((await two.provider.health()).message, undefined, 'nothing truncated');
  // The next poll starts at the size that worked.
  const before = s.queries().length;
  await s.poll();
  assert.deepEqual(
    s
      .queries()
      .slice(before)
      .map((r) => params(r).get('resultRecordCount')),
    ['100', '100'],
  );
});

test('a page too large even at the smallest size fails with what to change; a layer that cannot page fails at once', async () => {
  const always = layerAndQuery(fixture('wfigs-incidents-layer.json'), () => ({ error: 'too-large' }));
  const shrinking = await start(withPagination(incidents(), offsetLimit(400)), always);
  await rejects(
    shrinking.poll(),
    'TOO_LARGE',
    /offset 0 \(25 features\).*even after smaller pages.*maxAllowableOffset/,
  );
  assert.deepEqual(
    shrinking.queries().map((r) => params(r).get('resultRecordCount')),
    ['400', '200', '100', '50', '25'],
    `at most ${ARCGIS_MAX_SHRINKS} halvings, never below ${ARCGIS_MIN_PAGE_SIZE}`,
  );
  const once = await start(withPagination(incidents(), { strategy: 'none' }), always);
  await rejects(once.poll(), 'TOO_LARGE', /raise endpoint\.maxBytes/);
  assert.equal(once.queries().length, 1);
  const layer = await start(incidents(), () => ({ error: 'too-large' }));
  await rejects(layer.poll(), 'TOO_LARGE', /the layer description is larger than 8388608 bytes/);
});
