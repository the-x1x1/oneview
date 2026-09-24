import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import type { JsonValue, Observation } from '@worldview/world-model';
import { defaultConnectorRegistry } from '../../registry.js';
import { loadDefinitionsFrom } from '../../load.js';
import { runConnectorSuite, formatSuite, type SuiteFixtures } from '../../testing/suite.js';
import {
  CRS84_URN,
  EPSG4326_URN,
  OgcFeaturesProvider,
  WfsProvider,
  WmsProvider,
  WmtsProvider,
  classifyCrs,
  decideAxisOrder,
  isOverlayProvider,
  nextLink,
  parseWfsCapabilities,
  parseWmsCapabilities,
  parseWmtsCapabilities,
  sampleCoordinates,
  scanXml,
  webMercatorLevels,
  wfsBbox,
  zoomRange,
  type RasterOverlay,
  type WfsCapabilities,
  type WmsCapabilities,
  type WmtsCapabilities,
} from './index.js';

/**
 * Phase `ogc`. Every fixture under fixtures/connectors/ogc is a recording from the named
 * server (see fixtures/connectors/README.md); where a test needs a variant — coordinates
 * written latitude first, a CRS list with one more entry — it derives it from a recording
 * in memory and says so.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const fx = (name: string) => readFileSync(path.join(root, 'fixtures', 'connectors', 'ogc', name), 'utf8');
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(root, 'connectors', 'examples', 'ogc', name), 'utf8')) as Record<string, unknown>;
const NOW = Date.parse('2026-09-24T03:00:00.000Z');
const VIENNA_VIEW = { west: 16.365, south: 48.205, east: 16.375, north: 48.212 };
const VANCOUVER_VIEW = { west: -123.3, south: 49.1, east: -122.9, north: 49.4 };

const expectPass = (r: Awaited<ReturnType<typeof runConnectorSuite>>) => assert.ok(r.passed, '\n' + formatSuite(r));

async function start(
  doc: Record<string, unknown>,
  responder: testing.FixtureResponder,
  settings: Record<string, JsonValue> = {},
) {
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  const provider = defaultConnectorRegistry.createProvider(v.definition!);
  const ctx = testing.createFixtureContext({
    providerId: v.definition!.id,
    clock: new testing.VirtualClock(NOW),
    responder,
    settings,
  });
  await provider.initialize(ctx);
  await provider.start();
  return { provider, ctx, definition: v.definition! };
}

const query = (
  provider: { query?: (q: never) => Promise<Observation[]> },
  bounds?: { west: number; south: number; east: number; north: number },
) =>
  (provider as { query: (q: unknown) => Promise<Observation[]> }).query({
    signal: new AbortController().signal,
    background: true,
    ...(bounds ? { bounds } : {}),
  });

const ok = (body: string) => ({ status: 200, body });
const isCaps = (req: ProviderHttpRequest) => /REQUEST=GetCapabilities/i.test(req.url);

async function rejects(p: Promise<unknown>, code: string, pattern?: RegExp): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return err;
  }
  assert.fail(`expected ${code}`);
}

/** Every coordinate pair of a recorded FeatureCollection written the other way round (a latitude-first server). */
function latFirstVariant(text: string): string {
  const fc = JSON.parse(text) as { features: Array<{ geometry: { coordinates: number[] } }> };
  for (const f of fc.features) {
    const [a, b] = f.geometry.coordinates;
    f.geometry.coordinates = [b!, a!];
  }
  return JSON.stringify(fc);
}

// ── the shared suite on every example ────────────────────────────────────────

test('ogc examples: every definition loads, validates as user-configured, and names an OGC connector', () => {
  const loaded = loadDefinitionsFrom(path.join(root, 'connectors', 'examples', 'ogc'), { review: 'user-configured' });
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.definitions.map((d) => d.id).sort(), [
    'bkg-topplus-light-wmts',
    'eccc-hydrometric-stations',
    'eccc-radar-rain-wms',
    'usgs-topo-wms',
    'vienna-wlan-wfs',
  ]);
  for (const d of loaded.definitions) {
    assert.equal(d.enabled, false, `${d.id} is off`);
    assert.equal(d.dataPolicy, undefined, `${d.id} opens no policy`);
  }
  for (const id of ['wfs', 'ogc-features', 'wms', 'wmts']) assert.ok(defaultConnectorRegistry.get(id), id);
});

test('wfs suite — Vienna WLAN sites (GeoServer, recorded): lon/lat kept despite the lat-first CRS name', async () => {
  const r = await runConnectorSuite(example('vienna-wlan-wfs.json'), {
    normal: fx('geoserver-wien-wlan-page1.json'),
    empty: fx('geoserver-wien-wlan-empty.json'),
    malformed: [
      fx('mapserver-geomet-wms130-exception.xml'),
      fx('geoserver-wien-wfs200-capabilities.xml'),
      'not json',
      '{"type":"Feature","geometry":null,"properties":{}}',
      '',
    ],
    expectObservations: 4,
    expectIds: ['WLANWIENATOGD.5726011', 'WLANWIENATOGD.5726071', 'WLANWIENATOGD.5726072', 'WLANWIENATOGD.5726074'],
    verify: (obs) => {
      const s = obs.find((o) => o.externalId === 'WLANWIENATOGD.5726011')!;
      if (Math.abs(s.position!.latitude - 48.20801287) > 1e-9) return `latitude ${s.position!.latitude}`;
      if (s.payload['crsNote'] !== undefined) return 'swapped a longitude-first page';
      if (s.payload['address'] !== '1., Seilergasse 1') return 'address not trimmed';
      return undefined;
    },
  });
  expectPass(r);
});

test('ogc-features suite — Canada hydrometric stations (pygeoapi, recorded)', async () => {
  const r = await runConnectorSuite(example('eccc-hydrometric-stations-ogcapi.json'), {
    normal: fx('pygeoapi-geomet-hydrometric-page1.json'),
    empty: fx('pygeoapi-geomet-hydrometric-empty.json'),
    malformed: [
      fx('vienna-wms130-exception.xml'),
      fx('pygeoapi-geomet-collection.json'),
      '{"type":"FeatureCollection"}',
    ],
    expectObservations: 8,
    verify: (obs) => {
      const s = obs.find((o) => o.externalId === '08GA030')!;
      if (s.payload['realTime'] !== true) return 'realTime';
      if (s.payload['drainageAreaKm2'] !== 174.9) return `drainage ${s.payload['drainageAreaKm2']}`;
      return undefined;
    },
  });
  expectPass(r);
});

for (const [file, fixtures] of [
  [
    'eccc-radar-wms.json',
    {
      normal: fx('mapserver-geomet-wms130-radar.xml'),
      empty: fx('mapserver-geomet-wms111-radar.xml'),
      malformed: [
        fx('mapserver-geomet-wms130-exception.xml'),
        fx('vienna-wms130-exception.xml'),
        fx('geoserver-wien-wfs200-capabilities.xml'),
        fx('qgis-so-wms130-capabilities.xml'),
        'not xml',
        '',
      ],
      expectObservations: 0,
    },
  ],
  [
    'usgs-topo-wms.json',
    {
      normal: fx('arcgis-usgs-wms130-capabilities.xml'),
      empty: fx('arcgis-usgs-wms111-capabilities.xml'),
      malformed: [fx('bkg-topplus-wms130-capabilities.xml'), fx('arcgis-usgs-wmts-capabilities.xml')],
      expectObservations: 0,
    },
  ],
  [
    'bkg-topplus-wmts.json',
    {
      normal: fx('bkg-topplus-wmts-capabilities.xml'),
      empty: fx('bkg-topplus-wmts-capabilities.xml'),
      malformed: [fx('arcgis-usgs-wmts-capabilities.xml'), fx('bkg-topplus-wms130-capabilities.xml'), 'not xml'],
      expectObservations: 0,
    },
  ],
] as Array<[string, SuiteFixtures]>)
  test(`overlay suite — ${file}: zero observations, every failure path`, async () => {
    expectPass(await runConnectorSuite(example(file), fixtures));
  });

// ── the scanner ──────────────────────────────────────────────────────────────

test('scanner: DOCTYPE with an internal subset, comments, CDATA, entities, stray and missing close tags', () => {
  const r = scanXml(
    '﻿<?xml version="1.0"?>\n<!DOCTYPE X SYSTEM "x.dtd" [ <!ELEMENT a (#PCDATA)> ]>\n' +
      '<!-- c --><root xmlns:o="u" a="1 &amp; 2" o:b=\'q>\'><o:T><![CDATA[x <y>]]> &lt;&#65;&#x42;&bogus;</o:T></nope><open><leaf/></root>',
  );
  assert.ok('root' in r);
  const rootEl = r.root;
  assert.equal(rootEl.name, 'root');
  assert.deepEqual(rootEl.attrs, { a: '1 & 2', b: 'q>' });
  assert.equal(rootEl.children[0]!.name, 'T');
  assert.equal(rootEl.children[0]!.prefix, 'o');
  assert.equal(rootEl.children[0]!.text, 'x <y> <AB&bogus;');
  assert.equal(rootEl.children[1]!.name, 'open');
  assert.equal(rootEl.children[1]!.children[0]!.name, 'leaf');
  assert.ok('malformed' in scanXml('{"not":"xml"}'));
  assert.ok('malformed' in scanXml('   '));
  assert.ok('malformed' in scanXml('<a>'.repeat(80)));
});

test('scanner: every recording parses the same with CRLF line endings (Vienna served CRLF)', () => {
  for (const f of [
    'geoserver-wien-wfs200-capabilities.xml',
    'vienna-wms111-capabilities.xml',
    'bkg-topplus-wmts-capabilities.xml',
  ]) {
    const lf = fx(f);
    const crlf = lf.replace(/\n/g, '\r\n');
    const parse = f.includes('wfs')
      ? parseWfsCapabilities
      : f.includes('wmts')
        ? parseWmtsCapabilities
        : parseWmsCapabilities;
    const a = JSON.stringify(parse(lf));
    const b = JSON.stringify(parse(crlf));
    assert.equal(b.replace(/\\r/g, ''), a, f);
  }
});

// ── capabilities, per server ─────────────────────────────────────────────────

test('WFS capabilities — GeoServer 2.0.0 and 1.1.0, QGIS Server 1.1.0', () => {
  const g2 = parseWfsCapabilities(fx('geoserver-wien-wfs200-capabilities.xml')) as WfsCapabilities;
  assert.equal(g2.version, '2.0.0');
  assert.equal(g2.countDefault, 400000);
  assert.equal(g2.implementsResultPaging, true);
  assert.ok(g2.outputFormats.includes('application/json'));
  const wlan = g2.featureTypes.find((f) => f.name === 'ogdwien:WLANWIENATOGD')!;
  assert.equal(wlan.defaultCrs, 'urn:ogc:def:crs:EPSG::31256');
  assert.deepEqual(wlan.otherCrs, []);
  assert.deepEqual(wlan.bounds, {
    west: 16.20155335408832,
    south: 48.129368435004444,
    east: 16.526360063066374,
    north: 48.28124379605605,
  });
  const g1 = parseWfsCapabilities(fx('geoserver-wien-wfs110-capabilities.xml')) as WfsCapabilities;
  assert.equal(g1.version, '1.1.0');
  assert.equal(
    g1.featureTypes.find((f) => f.name === 'ogdwien:WLANWIENATOGD')!.defaultCrs,
    'urn:x-ogc:def:crs:EPSG:31256',
  );
  const q = parseWfsCapabilities(fx('qgis-so-wfs110-capabilities.xml')) as WfsCapabilities;
  const punkte = q.featureTypes.find((f) => f.name === 'ch.so.agi.av.einzelobjekte_punkte')!;
  assert.equal(punkte.defaultCrs, 'EPSG:2056');
  assert.deepEqual(punkte.otherCrs, ['EPSG:4326', 'EPSG:3857']);
  assert.ok(q.outputFormats.includes('application/vnd.geo+json'), 'QGIS lists its GeoJSON as application/vnd.geo+json');
  assert.match(
    String((parseWfsCapabilities(fx('arcgis-usgs-wms130-capabilities.xml')) as { malformed: string }).malformed),
    /not WFS/,
  );
});

test('WMS capabilities — MapServer (GeoMet): nested layers inherit CRS, bounds and attribution; time dimension; 1.1.1 too', () => {
  for (const f of ['mapserver-geomet-wms130-radar.xml', 'mapserver-geomet-wms111-radar.xml']) {
    const c = parseWmsCapabilities(fx(f)) as WmsCapabilities;
    const radar = c.layers.find((l) => l.name === 'RADAR_1KM_RRAI')!;
    assert.equal(radar.depth, 3, f);
    assert.deepEqual(radar.path, [
      'MSC GeoMet — GeoMet-Weather 2.40.3',
      'Weather Radar',
      'North American radar composite [1 km]',
    ]);
    assert.ok(radar.crs.includes('EPSG:3857'), `${f}: CRS inherited from the root layer`);
    assert.deepEqual(radar.bounds, { west: -170.32, south: 16.93, east: -50, north: 67.19 });
    assert.match(radar.attribution!.title!, /Environment and Climate Change Canada/);
    const time = radar.dimensions.find((d) => d.name === 'time')!;
    assert.equal(time.default, '2026-09-24T02:30:00Z', f);
    assert.equal(time.extent, '2026-09-23T23:30:00Z/2026-09-24T02:30:00Z/PT6M', f);
    assert.equal(radar.styles[0]!.name, 'Radar-Rain_14colors');
    assert.match(radar.styles[0]!.legendUrl!, /^https:\/\/geo\.weather\.gc\.ca\/geomet\?.*&layer=RADAR_1KM_RRAI&/);
  }
  const ex = parseWmsCapabilities(fx('mapserver-geomet-wms130-exception.xml'));
  assert.deepEqual(ex, { exception: 'InvalidLayersParameter: Couche non disponible / Layer not available' });
});

test('WMS capabilities — ArcGIS Server (CDATA titles, comments between CRS), QGIS Server groups, BKG, Vienna 1.1.1', () => {
  const a = parseWmsCapabilities(fx('arcgis-usgs-wms130-capabilities.xml')) as WmsCapabilities;
  const zero = a.layers.find((l) => l.name === '0')!;
  assert.equal(zero.title, 'USGSTopo');
  assert.deepEqual(zero.crs, ['CRS:84', 'EPSG:4326', 'EPSG:3857', 'EPSG:102100']);
  assert.equal(a.getMapUrl, 'https://basemap.nationalmap.gov:443/arcgis/services/USGSTopo/MapServer/WMSServer?');
  const q = parseWmsCapabilities(fx('qgis-so-wms130-capabilities.xml')) as WmsCapabilities;
  const nest = q.layers.find((l) => l.name === 'ch.so.afu.asiatische_hornisse.nester')!;
  assert.equal(nest.depth, 2);
  assert.deepEqual(nest.path, ['somap', 'Neozoen – Asiatische Hornisse – Sichtungen und Nester']);
  assert.equal(q.layers.filter((l) => l.depth === 1).length, 3);
  const b = parseWmsCapabilities(fx('bkg-topplus-wms130-capabilities.xml')) as WmsCapabilities;
  assert.deepEqual(
    b.layers.filter((l) => l.name).map((l) => l.name),
    ['web', 'web_grau', 'web_scale', 'web_scale_grau', 'web_light', 'web_light_grau'],
  );
  assert.match(b.fees!, /Datenlizenz Deutschland Namensnennung 2\.0/);
  const v = parseWmsCapabilities(fx('vienna-wms111-capabilities.xml')) as WmsCapabilities;
  assert.equal(v.version, '1.1.1');
  const wlan = v.layers.find((l) => l.name === 'WLANWIENATOGD')!;
  assert.deepEqual(wlan.scaleHint, { min: 0, max: 158.39192 });
  assert.ok(wlan.crs.includes('EPSG:3857'), 'SRS inherited');
  assert.deepEqual(zoomRange(wlan), { minZoom: 10 }, 'ScaleHint 158 m diagonal ≈ 1:400,000 ≈ zoom 10.4');
  assert.deepEqual(parseWmsCapabilities(fx('vienna-wms130-exception.xml')), {
    exception: '-2146697210: The system cannot locate the object specified.',
  });
});

test('WMTS capabilities — BKG (RESTful, zero-padded matrices) and ArcGIS (two Web Mercator sets, KVP too)', () => {
  const b = parseWmtsCapabilities(fx('bkg-topplus-wmts-capabilities.xml')) as WmtsCapabilities;
  assert.deepEqual(b.kvpGetTileUrls, []);
  const light = b.layers.find((l) => l.identifier === 'web_light')!;
  assert.deepEqual(light.tileMatrixSets, ['WEBMERCATOR', 'EU_EPSG_25832_TOPPLUS']);
  assert.equal(light.resourceUrls[0]!.template.includes('{TileMatrix}/{TileRow}/{TileCol}'), true);
  const web = b.tileMatrixSets.find((s) => s.identifier === 'WEBMERCATOR')!;
  const levels = webMercatorLevels(web);
  assert.ok('levels' in levels);
  assert.equal(levels.levels.get(0), '00');
  assert.equal(levels.levels.get(18), '18');
  const utm = webMercatorLevels(b.tileMatrixSets.find((s) => s.identifier === 'EU_EPSG_25832_TOPPLUS')!);
  assert.ok('problem' in utm && /not Web Mercator/.test(utm.problem));
  const a = parseWmtsCapabilities(fx('arcgis-usgs-wmts-capabilities.xml')) as WmtsCapabilities;
  assert.deepEqual(a.kvpGetTileUrls, ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/WMTS?']);
  for (const id of ['default028mm', 'GoogleMapsCompatible']) {
    const r = webMercatorLevels(a.tileMatrixSets.find((s) => s.identifier === id)!);
    assert.ok('levels' in r, id);
    assert.equal(r.levels.get(0), '0', id);
  }
});

// ── CRS names and axis order ─────────────────────────────────────────────────

test('CRS names: every spelling the recordings use', () => {
  assert.equal(classifyCrs('urn:ogc:def:crs:CRS::84').kind, 'crs84', "GeoServer's GeoJSON");
  assert.equal(classifyCrs('urn:ogc:def:crs:OGC:1.3:CRS84').kind, 'crs84');
  assert.equal(classifyCrs('urn:ogc:def:crs:OGC:2:84').kind, 'crs84', 'ArcGIS WMTS');
  assert.equal(classifyCrs('http://www.opengis.net/def/crs/OGC/1.3/CRS84').kind, 'crs84', 'pygeoapi');
  assert.equal(classifyCrs('CRS:84').kind, 'crs84');
  assert.deepEqual(classifyCrs('urn:ogc:def:crs:EPSG::4326'), { kind: 'epsg4326', epsg: 'EPSG:4326', latFirst: true });
  assert.deepEqual(classifyCrs('EPSG:4326'), { kind: 'epsg4326', epsg: 'EPSG:4326', latFirst: false });
  assert.equal(classifyCrs('urn:x-ogc:def:crs:EPSG:4326').latFirst, true);
  assert.equal(classifyCrs('http://www.opengis.net/gml/srs/epsg.xml#4326').latFirst, false);
  assert.equal(classifyCrs('urn:ogc:def:crs:EPSG:6.18.3:3857').kind, 'webmercator');
  assert.equal(classifyCrs('EPSG:102100').kind, 'webmercator');
  assert.deepEqual(classifyCrs('urn:ogc:def:crs:EPSG::31256'), { kind: 'other', epsg: 'EPSG:31256', latFirst: false });
});

test('axis order: decided from the data, never from the CRS name alone', () => {
  const lonLat = sampleCoordinates(
    (JSON.parse(fx('geoserver-wien-wlan-page1.json')) as { features: unknown[] }).features,
  );
  const latLon = lonLat.map(([a, b]) => [b, a] as [number, number]);
  const vienna = {
    west: 16.20155335408832,
    south: 48.129368435004444,
    east: 16.526360063066374,
    north: 48.28124379605605,
  };
  // GeoServer's recorded page: crs says the lat-first URN, the coordinates are lon/lat.
  assert.equal(decideAxisOrder(lonLat, { requestedCrs: EPSG4326_URN, bounds: vienna }).swap, false);
  // The same coordinates written latitude first (derived): the bounds catch it.
  const swapped = decideAxisOrder(latLon, { requestedCrs: EPSG4326_URN, bounds: vienna });
  assert.equal(swapped.swap, true);
  assert.equal(swapped.basis, 'bounds');
  // CRS84 asked for: longitude first, whatever the numbers look like.
  assert.equal(decideAxisOrder(latLon, { requestedCrs: CRS84_URN, bounds: vienna }).swap, false);
  // No bounds: a second value beyond ±90 can only be a longitude.
  assert.deepEqual(decideAxisOrder([[49.3, -123.1]], { requestedCrs: EPSG4326_URN }).basis, 'range');
  assert.equal(decideAxisOrder([[49.3, -123.1]], { requestedCrs: EPSG4326_URN }).swap, true);
  // Nothing decides: GeoJSON order.
  assert.deepEqual(decideAxisOrder([[16.3, 48.2]], { requestedCrs: EPSG4326_URN }), {
    swap: false,
    basis: 'default',
    reason: 'GeoJSON order (longitude first)',
  });
  // The operator's word wins.
  assert.equal(decideAxisOrder(lonLat, { setting: 'lat-lon', bounds: vienna }).swap, true);
  assert.equal(decideAxisOrder(latLon, { setting: 'lon-lat', bounds: vienna }).swap, false);
});

test('wfs: a latitude-first page (derived from the Vienna recording) is swapped and every observation says so', async () => {
  const caps = fx('geoserver-wien-wfs200-capabilities.xml');
  const page = latFirstVariant(fx('geoserver-wien-wlan-page1.json')).replace('"numberMatched":10', '"numberMatched":4');
  const { provider } = await start(example('vienna-wlan-wfs.json'), (req) => ok(isCaps(req) ? caps : page));
  const obs = await query(provider);
  assert.equal(obs.length, 4);
  const s = obs.find((o) => o.externalId === 'WLANWIENATOGD.5726011')!;
  assert.equal(s.position!.latitude, 48.20801287);
  assert.equal(s.position!.longitude, 16.37137964);
  assert.match(String(s.payload['crsNote']), /^axis order swapped to longitude, latitude: 4 of 4 sampled coordinates/);
  assert.equal((provider as WfsProvider).axisDecision()!.basis, 'bounds');
});

test('wfs: a service that ignores srsName and answers in its national grid is refused with the CRS named', async () => {
  // Derived: the recorded page relabelled as EPSG:31256 with its coordinates in metres.
  const fc = JSON.parse(fx('geoserver-wien-wlan-page1.json')) as Record<string, unknown>;
  fc['crs'] = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::31256' } };
  const { provider } = await start(example('vienna-wlan-wfs.json'), (req) =>
    ok(isCaps(req) ? fx('geoserver-wien-wfs200-capabilities.xml') : JSON.stringify(fc)),
  );
  await rejects(query(provider), 'MALFORMED', /answered in urn:ogc:def:crs:EPSG::31256, not WGS 84/);
  const metres = JSON.parse(fx('geoserver-wien-wlan-page1.json')) as {
    crs?: unknown;
    features: Array<{ geometry: { coordinates: number[] } }>;
  };
  delete metres.crs;
  metres.features.forEach((f, i) => (f.geometry.coordinates = [1067.97 + i, 341555.06 + i]));
  const second = await start(example('vienna-wlan-wfs.json'), () => ok(JSON.stringify(metres)));
  await rejects(query(second.provider), 'MALFORMED', /not longitude\/latitude degrees/);
});

test('QGIS Server GeoJSON (recorded: no crs member, no counts) maps longitude first in one request', async () => {
  const doc = {
    ...example('vienna-wlan-wfs.json'),
    id: 'so-einzelobjekte',
    endpoint: {
      url: 'https://geo.so.ch/api/wfs',
      query: { version: '1.1.0', typeName: 'ch.so.agi.av.einzelobjekte_punkte' },
    },
    mapping: { externalId: 'id', position: { geometry: 'geometry' }, labels: { kind: 'properties.art_txt' } },
    attribution: { text: 'Kanton Solothurn (recorded fixture)' },
  };
  const { provider, ctx } = await start(doc, (req) =>
    ok(isCaps(req) ? fx('qgis-so-wfs110-capabilities.xml') : fx('qgis-so-wfs110-points.json')),
  );
  const obs = await query(provider);
  assert.equal(obs.length, 3);
  assert.equal(obs[0]!.position!.latitude, 47.407746);
  assert.equal(obs[0]!.payload['crsNote'], undefined);
  const getFeature = ctx.http.requests.filter((r) => !isCaps(r));
  assert.equal(getFeature.length, 1, 'no counts in the answer, no page size asked: one request');
  assert.match(getFeature[0]!.url, /typeName=ch\.so\.agi\.av\.einzelobjekte_punkte/);
  assert.match(getFeature[0]!.url, /VERSION=1\.1\.0/);
  assert.match(
    getFeature[0]!.url,
    /outputFormat=application\/vnd\.geo%2Bjson/,
    'the GeoJSON format QGIS lists, + encoded',
  );
});

// ── requests: srsName, bbox, paging, origins ─────────────────────────────────

test('wfs: EPSG:4326 (URN) asked for when CRS84 is not listed, CRS84 when it is (derived), a pinned srsName above both', async () => {
  const caps = fx('geoserver-wien-wfs200-capabilities.xml');
  const page = fx('geoserver-wien-wlan-crs84.json');
  const run = async (capsText: string, extra: Record<string, string> = {}) => {
    const doc = example('vienna-wlan-wfs.json');
    doc['endpoint'] = {
      ...(doc['endpoint'] as object),
      query: { version: '2.0.0', typeNames: 'ogdwien:WLANWIENATOGD', ...extra },
    };
    const { provider, ctx } = await start(doc, (req) => ok(isCaps(req) ? capsText : page));
    await query(provider);
    return ctx.http.requests.find((r) => /GetFeature/.test(r.url))!.url;
  };
  assert.match(await run(caps), /srsName=urn:ogc:def:crs:EPSG::4326/);
  const withCrs84 = caps.replaceAll(
    '<DefaultCRS>urn:ogc:def:crs:EPSG::31256</DefaultCRS>',
    '<DefaultCRS>urn:ogc:def:crs:EPSG::31256</DefaultCRS><OtherCRS>urn:ogc:def:crs:OGC:1.3:CRS84</OtherCRS>',
  );
  assert.match(await run(withCrs84), /srsName=urn:ogc:def:crs:OGC:1\.3:CRS84/);
  assert.match(await run(caps, { srsName: 'EPSG:4326' }), /srsName=EPSG:4326/);
});

test('wfs bbox: axis order follows the CRS asked for; cql_filter carries the viewport instead when it has one', async () => {
  assert.equal(wfsBbox(VIENNA_VIEW, EPSG4326_URN), '48.20500,16.36500,48.21200,16.37500,urn:ogc:def:crs:EPSG::4326');
  assert.equal(wfsBbox(VIENNA_VIEW, CRS84_URN), '16.36500,48.20500,16.37500,48.21200,urn:ogc:def:crs:OGC:1.3:CRS84');
  assert.equal(wfsBbox(VIENNA_VIEW, 'EPSG:4326'), '16.36500,48.20500,16.37500,48.21200,EPSG:4326');
  const doc = { ...example('vienna-wlan-wfs.json'), boundsQuery: true };
  const { provider, ctx } = await start(doc, (req) =>
    ok(isCaps(req) ? fx('geoserver-wien-wfs200-capabilities.xml') : fx('geoserver-wien-wlan-page3.json')),
  );
  await query(provider);
  assert.equal(ctx.http.requests.length, 0, 'no viewport yet: no request at all');
  assert.match((await provider.health()).message ?? '', /waiting for a viewport/);
  await query(provider, VIENNA_VIEW);
  const gf = ctx.http.requests.find((r) => /GetFeature/.test(r.url))!.url;
  assert.match(gf, /bbox=48\.20500,16\.36500,48\.21200,16\.37500,urn:ogc:def:crs:EPSG::4326/);
  const cql = {
    ...doc,
    endpoint: {
      url: 'https://data.wien.gv.at/daten/geo',
      query: {
        typeNames: 'ogdwien:WLANWIENATOGD',
        cql_filter: "BBOX(SHAPE,{west},{south},{east},{north},'CRS:84') AND NAME LIKE 'S%'",
      },
    },
  };
  const c = await start(cql, (req) =>
    ok(isCaps(req) ? fx('geoserver-wien-wfs200-capabilities.xml') : fx('geoserver-wien-wlan-page3.json')),
  );
  await query(c.provider, VIENNA_VIEW);
  const url = c.ctx.http.requests.find((r) => /GetFeature/.test(r.url))!.url;
  assert.ok(!/[?&]bbox=/i.test(url), 'no BBOX beside a CQL_FILTER');
  assert.match(
    decodeURIComponent(url),
    /cql_filter=BBOX\(SHAPE,16\.36500,48\.20500,16\.37500,48\.21200,'CRS:84'\) AND NAME LIKE 'S%'/,
  );
});

test("wfs paging: startIndex over three recorded pages (count 4 of 10), never following GeoServer's next link to its backend host", async () => {
  const doc = example('vienna-wlan-wfs.json');
  doc['pagination'] = {
    strategy: 'offset-limit',
    offsetParam: 'startIndex',
    limitParam: 'count',
    limit: 4,
    maxPages: 10,
  };
  doc['boundsQuery'] = true;
  const { provider, ctx } = await start(doc, (req) => {
    if (isCaps(req)) return ok(fx('geoserver-wien-wfs200-capabilities.xml'));
    if (/startIndex=8/.test(req.url)) return ok(fx('geoserver-wien-wlan-page3.json'));
    if (/startIndex=4/.test(req.url)) return ok(fx('geoserver-wien-wlan-page2.json'));
    return ok(fx('geoserver-wien-wlan-page1.json'));
  });
  const obs = await query(provider, VIENNA_VIEW);
  assert.equal(obs.length, 10);
  const urls = ctx.http.requests.map((r) => r.url);
  assert.equal(urls.filter((u) => /GetFeature/.test(u)).length, 3, 'stops at numberMatched');
  assert.ok(
    urls.every((u) => new URL(u).hostname === 'data.wien.gv.at'),
    'stp.wien.gv.at (the next link) is never asked',
  );
  assert.ok(urls.filter((u) => /GetFeature/.test(u)).every((u) => /[?&]count=4(&|$)/.test(u)));
  assert.equal(ctx.http.requests.filter(isCaps).length, 1);
  await query(provider, VIENNA_VIEW);
  assert.equal(ctx.http.requests.filter(isCaps).length, 1, 'capabilities are kept for six hours');
  assert.ok(provider.manifest.refreshPolicy.maxRequestsPerMinute >= 2 * (1 + 10), 'the budget covers one poll');
});

test('wfs: a service that ignores startIndex (derived: the first recorded page for every request) is noticed and not re-read', async () => {
  const doc = example('vienna-wlan-wfs.json');
  doc['pagination'] = {
    strategy: 'offset-limit',
    offsetParam: 'startIndex',
    limitParam: 'count',
    limit: 4,
    maxPages: 10,
  };
  const { provider, ctx } = await start(doc, (req) =>
    ok(isCaps(req) ? fx('geoserver-wien-wfs200-capabilities.xml') : fx('geoserver-wien-wlan-page1.json')),
  );
  assert.equal((await query(provider)).length, 4);
  assert.equal(ctx.http.requests.filter((r) => /GetFeature/.test(r.url)).length, 2, 'one repeat, then stop');
  assert.match((await provider.health()).message ?? '', /answered startIndex=4 with features already read/);
});

test('wfs: capabilities that are missing do not stop the features; a feature type the service does not offer does', async () => {
  const { provider, ctx } = await start(example('vienna-wlan-wfs.json'), (req) =>
    isCaps(req) ? { status: 404 } : ok(fx('geoserver-wien-wlan-page3.json')),
  );
  assert.equal((await query(provider)).length, 2);
  assert.match(ctx.http.requests.find((r) => /GetFeature/.test(r.url))!.url, /srsName=urn:ogc:def:crs:EPSG::4326/);
  const h = await provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(h.message ?? '', /capabilities could not be read \(HTTP_4XX/);
  const doc = example('vienna-wlan-wfs.json');
  doc['endpoint'] = { url: 'https://data.wien.gv.at/daten/geo', query: { typeNames: 'ogdwien:NO_SUCH_LAYER' } };
  const missing = await start(doc, () => ok(fx('geoserver-wien-wfs200-capabilities.xml')));
  await rejects(
    query(missing.provider),
    'MALFORMED',
    /does not offer ogdwien:NO_SUCH_LAYER \(it lists ogdwien:CITYBIKEOGD/,
  );
  await rejects(query(missing.provider), 'MALFORMED', /does not offer/);
});

test('ogc-features paging: next links across three recorded pages, f=json added back, bbox in CRS84 order', async () => {
  const { provider, ctx } = await start(example('eccc-hydrometric-stations-ogcapi.json'), (req) => {
    if (/offset=16/.test(req.url)) return ok(fx('pygeoapi-geomet-hydrometric-page3.json'));
    if (/offset=8/.test(req.url)) return ok(fx('pygeoapi-geomet-hydrometric-page2.json'));
    return ok(fx('pygeoapi-geomet-hydrometric-page1.json'));
  });
  const obs = await query(provider, VANCOUVER_VIEW);
  assert.equal(obs.length, 20);
  const urls = ctx.http.requests.map((r) => r.url);
  assert.equal(urls.length, 3);
  assert.match(urls[0]!, /\?f=json&limit=500&bbox=-123\.30000,49\.10000,-122\.90000,49\.40000$/);
  assert.match(urls[1]!, /offset=8/);
  assert.match(urls[1]!, /[?&]f=json/, 'pygeoapi drops f=json from next links; the connector adds it back');
  assert.match(urls[1]!, /limit=8/, 'but never replaces what the link carries');
  assert.equal(ctx.http.requests[0]!.headers!['Accept'], 'application/geo+json, application/json;q=0.9, */*;q=0.1');
});

test('ogc-features: a next link off the origin (derived) is not followed, and health says why', async () => {
  const evil = fx('pygeoapi-geomet-hydrometric-page1.json').replace(
    'https://api.weather.gc.ca/collections/hydrometric-stations/items?offset=8',
    'https://evil.example/collections/hydrometric-stations/items?offset=8',
  );
  const { provider, ctx } = await start(example('eccc-hydrometric-stations-ogcapi.json'), () => ok(evil));
  assert.equal((await query(provider, VANCOUVER_VIEW)).length, 8);
  assert.equal(ctx.http.requests.length, 1);
  assert.match((await provider.health()).message ?? '', /next link pointed off the endpoint's origin/);
  assert.equal(
    nextLink(
      [{ rel: 'next', href: 'https://u:p@api.weather.gc.ca/x' }],
      'https://api.weather.gc.ca',
      'https://api.weather.gc.ca/',
    ),
    undefined,
  );
  assert.equal(
    nextLink(
      [
        { rel: 'next', type: 'text/html', href: '/a?f=html' },
        { rel: 'next', type: 'application/geo+json', href: '/a?f=json' },
      ],
      'https://api.weather.gc.ca',
      'https://api.weather.gc.ca/collections/x/items',
    ),
    'https://api.weather.gc.ca/a?f=json',
  );
});

test('ogc-features: maxPages stops the walk and says so', async () => {
  const doc = example('eccc-hydrometric-stations-ogcapi.json');
  doc['pagination'] = { strategy: 'next-link', nextLinkPath: 'links', maxPages: 2 };
  const { provider, ctx } = await start(doc, (req) =>
    ok(
      /offset=8/.test(req.url)
        ? fx('pygeoapi-geomet-hydrometric-page2.json')
        : fx('pygeoapi-geomet-hydrometric-page1.json'),
    ),
  );
  assert.equal((await query(provider, VANCOUVER_VIEW)).length, 16);
  assert.equal(ctx.http.requests.length, 2);
  assert.match((await provider.health()).message ?? '', /stopped at maxPages \(2\)/);
});

// ── overlays ─────────────────────────────────────────────────────────────────

async function overlayOf(
  file: string,
  caps: string,
  settings: Record<string, JsonValue> = {},
  patch: Record<string, unknown> = {},
) {
  const { provider, ctx } = await start({ ...example(file), ...patch }, () => ok(caps), settings);
  assert.ok(isOverlayProvider(provider));
  assert.deepEqual(await query(provider), [], 'an overlay produces no observations until the contract lands');
  return { overlay: provider.overlay()!, provider, ctx };
}

test('wms overlay — GeoMet radar (MapServer 1.3.0): Web Mercator, time default and extent, legend, attribution', async () => {
  const { overlay, provider, ctx } = await overlayOf('eccc-radar-wms.json', fx('mapserver-geomet-wms130-radar.xml'));
  const expected: Partial<RasterOverlay> = {
    id: 'eccc-radar-rain-wms',
    kind: 'wms',
    crs: 'EPSG:3857',
    bboxAxisOrder: 'xy',
    tileSize: 256,
    layer: 'RADAR_1KM_RRAI',
    style: 'Radar-Rain_14colors',
    format: 'image/png',
    hosts: ['geo.weather.gc.ca'],
    attribution: 'Data Source: Environment and Climate Change Canada',
    bounds: { west: -170.32, south: 16.93, east: -50, north: 67.19 },
    time: { default: '2026-09-24T02:30:00Z', extent: '2026-09-23T23:30:00Z/2026-09-24T02:30:00Z/PT6M' },
    title: 'Radar precipitation rate for rain [mm/h]',
  };
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(overlay[k as keyof RasterOverlay], v, k);
  assert.equal(
    overlay.urlTemplate,
    'https://geo.weather.gc.ca/geomet?layer=RADAR_1KM_RRAI&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=RADAR_1KM_RRAI&STYLES=Radar-Rain_14colors&FORMAT=image/png&TRANSPARENT=TRUE&CRS={crs}&BBOX={bbox}&WIDTH={width}&HEIGHT={height}',
  );
  assert.match(overlay.legendUrl!, /^https:\/\/geo\.weather\.gc\.ca\/geomet\?.*GetLegendGraphic/);
  assert.match(
    ctx.http.requests[0]!.url,
    /^https:\/\/geo\.weather\.gc\.ca\/geomet\?layer=RADAR_1KM_RRAI&SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1\.3\.0$/,
  );
  const h = await provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(
    h.message ?? '',
    /overlay RADAR_1KM_RRAI ready in EPSG:3857; nothing draws it until the raster overlay contract lands/,
  );
});

test("wms overlay: the operator's time goes into the template; a bad one is refused; opacity is taken", async () => {
  const { overlay } = await overlayOf('eccc-radar-wms.json', fx('mapserver-geomet-wms130-radar.xml'), {
    time: '2026-09-24T01:30:00Z',
    opacity: 0.6,
  });
  assert.match(overlay.urlTemplate, /&TIME=2026-09-24T01:30:00Z$/);
  assert.equal(overlay.time!.value, '2026-09-24T01:30:00Z');
  assert.equal(overlay.opacity, 0.6);
  const { provider } = await start(example('eccc-radar-wms.json'), () => ok(fx('mapserver-geomet-wms130-radar.xml')), {
    time: 'yesterday',
  });
  await rejects(query(provider), 'MALFORMED', /time setting "yesterday"/);
});

test('wms overlay: a server that answers 1.1.1 gets an SRS template; EPSG:4326 in 1.3.0 is latitude first (derived)', async () => {
  const { overlay } = await overlayOf('eccc-radar-wms.json', fx('mapserver-geomet-wms111-radar.xml'));
  assert.match(overlay.urlTemplate, /VERSION=1\.1\.1&.*&SRS=\{crs\}&BBOX=\{bbox\}/);
  const only4326 = fx('mapserver-geomet-wms130-radar.xml').replace(/<CRS>(?!EPSG:4326<)[^<]*<\/CRS>/g, '');
  const r = await overlayOf('eccc-radar-wms.json', only4326);
  assert.equal(r.overlay.crs, 'EPSG:4326');
  assert.equal(r.overlay.bboxAxisOrder, 'yx');
  const none = fx('mapserver-geomet-wms130-radar.xml').replace(/<CRS>[^<]*<\/CRS>/g, '<CRS>EPSG:2294</CRS>');
  const { provider } = await start(example('eccc-radar-wms.json'), () => ok(none));
  await rejects(query(provider), 'MALFORMED', /offers none of EPSG:3857, CRS:84, EPSG:4326/);
});

test('wms overlay — ArcGIS (USGS) and Vienna 1.1.1: the advertised GetMap URL (:443, plain http) is never used', async () => {
  const a = await overlayOf('usgs-topo-wms.json', fx('arcgis-usgs-wms130-capabilities.xml'));
  assert.equal(a.overlay.crs, 'EPSG:3857');
  assert.ok(
    a.overlay.urlTemplate.startsWith(
      'https://basemap.nationalmap.gov/arcgis/services/USGSTopo/MapServer/WMSServer?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=0&STYLES=&',
    ),
  );
  assert.ok(!a.overlay.urlTemplate.includes(':443'));
  const v = await overlayOf(
    'usgs-topo-wms.json',
    fx('vienna-wms111-capabilities.xml'),
    {},
    {
      endpoint: { url: 'https://data.wien.gv.at/daten/wms', query: { version: '1.1.1', layers: 'WLANWIENATOGD' } },
    },
  );
  assert.ok(
    v.overlay.urlTemplate.startsWith(
      'https://data.wien.gv.at/daten/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=WLANWIENATOGD&',
    ),
  );
  assert.equal(v.overlay.minZoom, 10);
  assert.equal(v.overlay.crs, 'EPSG:3857');
});

test('wmts overlay — BKG TopPlusOpen: zero-padded matrices become a zoom table, the template stays on the host', async () => {
  const { overlay, provider } = await overlayOf('bkg-topplus-wmts.json', fx('bkg-topplus-wmts-capabilities.xml'));
  assert.equal(
    overlay.urlTemplate,
    'https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web_light/default/WEBMERCATOR/{tileMatrix}/{y}/{x}.png',
  );
  assert.deepEqual(overlay.zToTileMatrix, [
    '00',
    '01',
    '02',
    '03',
    '04',
    '05',
    '06',
    '07',
    '08',
    '09',
    '10',
    '11',
    '12',
    '13',
    '14',
    '15',
    '16',
    '17',
    '18',
  ]);
  assert.equal(overlay.minZoom, 0);
  assert.equal(overlay.maxZoom, 18);
  assert.equal(overlay.kind, 'wmts');
  assert.deepEqual(overlay.hosts, ['sgx.geodatenzentrum.de']);
  assert.match(overlay.attribution, /^Kartendarstellung: © BKG \(2026\) dl-de\/by-2-0/);
  assert.match((await provider.health()).message ?? '', /zoom 0–18.*tile matrix set WEBMERCATOR/);
  const utm = await start(
    {
      ...example('bkg-topplus-wmts.json'),
      endpoint: {
        url: 'https://sgx.geodatenzentrum.de/wmts_topplus_open/1.0.0/WMTSCapabilities.xml',
        query: { layer: 'web_light', tileMatrixSet: 'EU_EPSG_25832_TOPPLUS' },
      },
    },
    () => ok(fx('bkg-topplus-wmts-capabilities.xml')),
  );
  await rejects(query(utm.provider), 'MALFORMED', /EU_EPSG_25832_TOPPLUS is in EPSG:25832, not Web Mercator/);
});

test('wmts overlay — ArcGIS (USGS): plain zoom ids give {z}; without a ResourceURL (derived) the KVP GetTile is used; another host is refused', async () => {
  const patch = {
    endpoint: {
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/WMTS/1.0.0/WMTSCapabilities.xml',
      query: { layer: 'USGSTopo' },
    },
  };
  const caps = fx('arcgis-usgs-wmts-capabilities.xml');
  const a = await overlayOf('bkg-topplus-wmts.json', caps, {}, patch);
  assert.equal(
    a.overlay.urlTemplate,
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/WMTS/tile/1.0.0/USGSTopo/default/default028mm/{z}/{y}/{x}',
  );
  assert.equal(a.overlay.zToTileMatrix, undefined);
  assert.equal(a.overlay.format, 'image/jpgpng');
  assert.equal(a.overlay.maxZoom, 23);
  const noRest = caps.replace(/<ResourceURL[^>]*\/>/g, '');
  const k = await overlayOf('bkg-topplus-wmts.json', noRest, {}, patch);
  assert.equal(
    k.overlay.urlTemplate,
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/WMTS?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=USGSTopo&STYLE=default&FORMAT=image/jpgpng&TILEMATRIXSET=default028mm&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  );
  const elsewhere = caps.replace(
    /template="https:\/\/basemap\.nationalmap\.gov/g,
    'template="https://tiles.example.org',
  );
  const { provider } = await start({ ...example('bkg-topplus-wmts.json'), ...patch }, () => ok(elsewhere));
  await rejects(
    query(provider),
    'MALFORMED',
    /tiles are served from tiles\.example\.org, which the definition does not name/,
  );
});

test('overlays keep the last good descriptor through a failed poll', async () => {
  let body = fx('bkg-topplus-wmts-capabilities.xml');
  const { provider } = await start(example('bkg-topplus-wmts.json'), () => ok(body));
  await query(provider);
  const first = (provider as WmtsProvider).overlay();
  body = 'not xml';
  await rejects(query(provider), 'MALFORMED');
  assert.equal((provider as WmtsProvider).overlay(), first);
  assert.equal((await provider.health()).status, 'DEGRADED');
});

// ── validation ───────────────────────────────────────────────────────────────

test('validation: what each connector refuses, with the reason', () => {
  const errors = (doc: Record<string, unknown>) => defaultConnectorRegistry.validate(doc).errors.join(' | ');
  const wfs = example('vienna-wlan-wfs.json');
  const withQuery = (
    base: Record<string, unknown>,
    query: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    ...base,
    ...extra,
    endpoint: { ...(base['endpoint'] as object), query },
  });
  assert.match(errors(withQuery(wfs, { version: '2.0.0' })), /must name the feature type/);
  assert.match(errors(withQuery(wfs, { typeNames: 'a,b' })), /one feature type per definition/);
  assert.match(errors(withQuery(wfs, { typeNames: 'a', version: '1.0.0' })), /version "1\.0\.0" is not supported/);
  assert.match(errors(withQuery(wfs, { typeNames: 'a', srsName: 'EPSG:31256' })), /srsName "EPSG:31256" is not WGS 84/);
  assert.match(errors(withQuery(wfs, { typeNames: 'a', startIndex: 5 })), /sets "startIndex"/);
  assert.match(
    errors(withQuery(wfs, { typeNames: 'a', cql_filter: "NAME='x'" }, { boundsQuery: true })),
    /GeoServer refuses BBOX and CQL_FILTER together/,
  );
  assert.match(
    errors(withQuery(wfs, { typeNames: 'a', FILTER: '<Filter/>' }, { boundsQuery: true })),
    /BBOX or FILTER, not both/,
  );
  assert.match(
    errors({ ...wfs, pagination: { strategy: 'cursor', cursorParam: 'c', cursorPath: 'next' } }),
    /does not apply to WFS/,
  );
  assert.match(
    errors(
      withQuery(
        wfs,
        { typeNames: 'a', count: 10 },
        { pagination: { strategy: 'offset-limit', offsetParam: 'startIndex', limitParam: 'count', limit: 5 } },
      ),
    ),
    /page size is set twice/,
  );
  const api = example('eccc-hydrometric-stations-ogcapi.json');
  assert.match(
    errors({ ...api, endpoint: { url: 'https://api.weather.gc.ca/collections/hydrometric-stations' } }),
    /items resource/,
  );
  assert.match(errors(withQuery(api, { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' })), /is not CRS84/);
  assert.match(errors(withQuery(api, { datetime: 'last week' })), /datetime "last week"/);
  assert.match(
    errors({ ...api, pagination: { strategy: 'next-link', nextLinkPath: 'next' } }),
    /nextLinkPath to "links"/,
  );
  const wms = example('eccc-radar-wms.json');
  assert.match(errors(withQuery(wms, { styles: 'a' })), /must name the layer/);
  assert.match(errors(withQuery(wms, { layers: 'a,b', styles: 'x' })), /styles lists 1 value\(s\) for 2 layer\(s\)/);
  assert.match(
    errors(withQuery(wms, { layers: 'a', bbox: '0,0,1,1' })),
    /sets "bbox", which the renderer fills per tile/,
  );
  assert.match(errors(withQuery(wms, { layers: 'a', crs: 'EPSG:2056' })), /cannot be drawn/);
  const wmts = example('bkg-topplus-wmts.json');
  assert.match(errors(withQuery(wmts, { style: 'default' })), /must name the "layer"/);
  assert.match(errors(withQuery(wmts, { layer: 'x', TileMatrix: '3' })), /sets "TileMatrix"/);
  const warnings = defaultConnectorRegistry.validate({
    ...wms,
    boundsQuery: true,
    mapping: { externalId: 'id', labels: { a: 'b' } },
  }).warnings;
  assert.ok(warnings.some((w) => /boundsQuery is ignored/.test(w)));
  assert.ok(warnings.some((w) => /mapping is not applied/.test(w)));
});

test('providers are what the registry makes of each connector', () => {
  const make = (file: string) =>
    defaultConnectorRegistry.createProvider(defaultConnectorRegistry.validate(example(file)).definition!);
  assert.ok(make('vienna-wlan-wfs.json') instanceof WfsProvider);
  assert.ok(make('eccc-hydrometric-stations-ogcapi.json') instanceof OgcFeaturesProvider);
  assert.ok(make('eccc-radar-wms.json') instanceof WmsProvider);
  assert.ok(make('bkg-topplus-wmts.json') instanceof WmtsProvider);
  assert.ok(!isOverlayProvider(make('vienna-wlan-wfs.json')));
  assert.deepEqual(make('vienna-wlan-wfs.json').manifest.allowedHosts, ['data.wien.gv.at']);
});
