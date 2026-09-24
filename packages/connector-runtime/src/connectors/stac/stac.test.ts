import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import { definitionToManifest } from '@worldview/connector-sdk';
import type { JsonValue, Observation } from '@worldview/world-model';
import { formatSuite, runConnectorSuite } from '../../testing/suite.js';
import { defaultConnectorRegistry } from '../../registry.js';
import { loadDefinitionsFrom } from '../../load.js';
import {
  MAX_FOOTPRINT_VERTICES,
  StacProvider,
  bbox2d,
  bboxCentroid,
  capFootprint,
  countVertices,
  footprintBbox,
  isStacDatetime,
  itemRecord,
  nextRequest,
  parseWindow,
  readFootprint,
  stacMode,
  toQuery,
  viewBoxes,
  windowInterval,
} from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'connectors', 'stac', name), 'utf8');
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(root, 'connectors', 'examples', 'stac', name), 'utf8')) as Record<string, unknown>;
const EARTH_SEARCH = 'earth-search-sentinel-2-l2a.json';
const STATIC = 'capella-open-data-static.json';
const SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';
/** The suite's clock, and the view it polls with (Hawaii). */
const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const HAWAII = { west: -160, south: 18, east: -154, north: 23 };
const expectPass = (r: Awaited<ReturnType<typeof runConnectorSuite>>) => assert.ok(r.passed, '\n' + formatSuite(r));

type Responder = (req: ProviderHttpRequest) => testing.FixtureResponse;
const ok = (body: string): testing.FixtureResponse => ({ status: 200, body });

async function start(doc: unknown, responder: Responder, settings: Record<string, JsonValue> = {}) {
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  const provider = defaultConnectorRegistry.createProvider(v.definition!) as StacProvider;
  const ctx = testing.createFixtureContext({
    providerId: v.definition!.id,
    clock: new testing.VirtualClock(NOW),
    responder,
    settings,
  });
  await provider.initialize(ctx);
  await provider.start();
  return { provider, ctx };
}

/** `null`: no view yet. */
const poll = (p: StacProvider, bounds: typeof HAWAII | null = HAWAII, signal = new AbortController().signal) =>
  p.query({ signal, background: true, ...(bounds ? { bounds } : {}) });
const bodyOf = (r: ProviderHttpRequest): Record<string, JsonValue> =>
  JSON.parse(String(r.body)) as Record<string, JsonValue>;
const ids = (obs: Observation[]) => obs.map((o) => o.externalId).sort();
const withEndpoint = (doc: Record<string, unknown>, endpoint: Record<string, unknown>) => ({
  ...doc,
  endpoint: { ...(doc['endpoint'] as object), ...endpoint },
});
const searchBodyOf = (doc: Record<string, unknown>) =>
  (doc['endpoint'] as { body: Record<string, JsonValue> }).body as Record<string, JsonValue>;

// ── the shared suite ─────────────────────────────────────────────────────────

test('Earth Search example: the shared suite, with scenes at their bbox centres and the payload the brief names', async () => {
  const r = await runConnectorSuite(example(EARTH_SEARCH), {
    normal: fixture('search-page1.json'),
    empty: fixture('search-empty.json'),
    malformed: [
      'not json',
      '{"other":1}',
      '{"type":"FeatureCollection","features":"x"}',
      '{"type":"Catalog","links":[]}',
    ],
    expectObservations: 3,
    expectIds: ['S2A_5QKB_20260922_0_L2A', 'S2B_4QFJ_20260921_0_L2A', 'S2C_5QKA_20260919_0_L2A'],
    verify: (obs) => {
      for (const o of obs) {
        if (o.objectType !== 'imagery-scene') return `${o.externalId}: not a scene`;
        if (o.payload['capturedAt'] !== o.observedAt) return `${o.externalId}: capturedAt is not observedAt`;
        if (o.geometry?.type !== 'Polygon') return `${o.externalId}: footprint missing`;
        if (!Array.isArray(o.payload['assetKeys']) || !o.payload['assetKeys'].includes('visual'))
          return `${o.externalId}: asset keys missing`;
        if (o.quality.flags?.includes('fetch-time')) return `${o.externalId}: the capture time was not read`;
      }
      const b = obs.find((o) => o.externalId === 'S2B_4QFJ_20260921_0_L2A')!;
      if (Math.abs(b.position!.longitude - -157.765) > 1e-9 || Math.abs(b.position!.latitude - 21.29) > 1e-9)
        return `centroid ${JSON.stringify(b.position)}`;
      if (b.payload['cloudCoverPct'] !== 41.02) return 'eo:cloud_cover';
      const c = obs.find((o) => o.externalId === 'S2C_5QKA_20260919_0_L2A')!;
      if (c.observedAt !== '2026-09-19T21:08:44.117Z') return 'a null datetime did not fall back to start_datetime';
      if (typeof c.payload['thumbnailUrl'] !== 'string' || !c.payload['thumbnailUrl'].endsWith('/preview.jpg'))
        return 'the thumbnail-role asset was not used';
      return undefined;
    },
  });
  expectPass(r);
});

test('static example: the shared suite on the root catalogue (the walk itself is proved below)', async () => {
  const r = await runConnectorSuite(example(STATIC), {
    normal: fixture('static/catalog.json'),
    empty: '{"type":"Catalog","id":"empty","stac_version":"1.0.0","description":"No links.","links":[]}',
    malformed: ['not json', '{"other":1}', '[]'],
    expectObservations: 0,
  });
  expectPass(r);
});

test('both examples load from connectors/examples/stac: user-configured, disabled, nothing opened', () => {
  const loaded = loadDefinitionsFrom(path.join(root, 'connectors', 'examples', 'stac'), { review: 'user-configured' });
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.definitions.map((d) => d.id).sort(), [
    'capella-open-data-scenes',
    'earth-search-sentinel-2-l2a',
  ]);
  for (const d of loaded.definitions) {
    assert.equal(d.enabled, false);
    assert.equal(d.objectType, 'imagery-scene');
    assert.equal(d.dataPolicy, undefined);
    const m = defaultConnectorRegistry.createProvider(d).manifest;
    assert.equal(m.enabledByDefault, false);
    assert.equal(m.commercialReview, 'manual-review-required');
    assert.equal(m.dataPolicy.redistributionAllowed, false);
  }
});

// ── item search: paging ──────────────────────────────────────────────────────

test('POST paging: the next link body is merged into the search, page 2 carries it all, the last page ends it', async () => {
  const { provider, ctx } = await start(example(EARTH_SEARCH), (req) =>
    ok(req.method === 'POST' && bodyOf(req)['next'] ? fixture('search-page2.json') : fixture('search-page1.json')),
  );
  const obs = await poll(provider);
  assert.deepEqual(ids(obs), [
    'S2A_4QGJ_20260920_0_L2A',
    'S2A_5QKB_20260922_0_L2A',
    'S2B_4QFJ_20260921_0_L2A',
    'S2B_4QGH_20260918_0_L2A',
    'S2C_5QKA_20260919_0_L2A',
  ]);
  const [first, second, ...rest] = ctx.http.requests;
  assert.equal(rest.length, 0, 'page 2 has no next link');
  assert.equal(first!.method, 'POST');
  assert.equal(first!.url, SEARCH_URL);
  assert.equal(first!.headers?.['Content-Type'], 'application/json');
  assert.deepEqual(bodyOf(first!), {
    collections: ['sentinel-2-l2a'],
    limit: 100,
    datetime: '2026-09-16T20:00:00Z/2026-09-23T20:00:00Z',
    bbox: [-160, 18, -154, 23],
  });
  assert.equal(second!.method, 'POST');
  assert.equal(second!.url, SEARCH_URL);
  assert.deepEqual(bodyOf(second!), {
    ...bodyOf(first!),
    next: '2026-09-19T21:08:44.117000Z,S2C_5QKA_20260919_0_L2A,sentinel-2-l2a',
  });
  assert.notEqual(first!.cacheKey, second!.cacheKey, 'pages never share a cache or coalescing key');
});

test('next links: merge false sends the link body alone; credentials and framing headers are never taken from a link', () => {
  const current = { method: 'POST' as const, url: SEARCH_URL, body: { collections: ['a'], limit: 10 } };
  const origin = 'https://earth-search.aws.element84.com';
  const page = (link: Record<string, JsonValue>) => ({ type: 'FeatureCollection', features: [], links: [link] });
  const replaced = nextRequest(
    page({ rel: 'next', href: SEARCH_URL, method: 'POST', body: { token: 't2' } }),
    current,
    origin,
  );
  assert.deepEqual(replaced.request?.body, { token: 't2' });
  const merged = nextRequest(
    page({
      rel: 'next',
      href: '/v1/search',
      method: 'post',
      body: { token: 't2' },
      merge: true,
      headers: { Authorization: 'Bearer stolen', Cookie: 'x', 'X-Page': '2', Host: 'evil.example' },
    }),
    current,
    origin,
  );
  assert.deepEqual(merged.request, {
    method: 'POST',
    url: SEARCH_URL,
    body: { collections: ['a'], limit: 10, token: 't2' },
    headers: { 'X-Page': '2' },
  });
  const get = nextRequest(page({ rel: 'next', href: `${SEARCH_URL}?next=abc#frag` }), current, origin);
  assert.deepEqual(get.request, { method: 'GET', url: `${SEARCH_URL}?next=abc` });
  assert.equal(
    nextRequest(page({ rel: 'next', href: 'https://evil.example/search' }), current, origin).request,
    undefined,
  );
  assert.match(
    nextRequest(page({ rel: 'next', href: 'https://evil.example/search' }), current, origin).refused!,
    /another origin/,
  );
  assert.equal(
    nextRequest(page({ rel: 'next', href: 'https://u:p@earth-search.aws.element84.com/v1/search' }), current, origin)
      .request,
    undefined,
  );
  assert.equal(nextRequest(page({ rel: 'prev', href: SEARCH_URL }), current, origin).request, undefined);
  const huge = { token: 'x'.repeat(70_000) };
  assert.match(
    nextRequest(page({ rel: 'next', href: SEARCH_URL, method: 'POST', body: huge }), current, origin).refused!,
    /oversized/,
  );
});

test('GET search: parameters in the query, next hrefs followed on the origin, a link off it refused and reported', async () => {
  const page1 = JSON.parse(fixture('search-page1.json')) as { links: unknown[] };
  page1.links = [{ rel: 'next', method: 'GET', href: `${SEARCH_URL}?collections=sentinel-2-l2a&limit=100&next=abc` }];
  const page2 = JSON.parse(fixture('search-page2.json')) as { links: unknown[] };
  page2.links = [{ rel: 'next', href: 'https://mirror.example.org/v1/search?next=def' }];
  const doc = withEndpoint(example(EARTH_SEARCH), { method: 'GET' });
  const { provider, ctx } = await start(doc, (req) =>
    ok(JSON.stringify(new URL(req.url).searchParams.get('next') ? page2 : page1)),
  );
  const obs = await poll(provider);
  assert.equal(obs.length, 5);
  assert.equal(ctx.http.requests.length, 2);
  const q = new URL(ctx.http.requests[0]!.url).searchParams;
  assert.equal(ctx.http.requests[0]!.method, 'GET');
  assert.equal(ctx.http.requests[0]!.body, undefined);
  assert.equal(q.get('collections'), 'sentinel-2-l2a');
  assert.equal(q.get('limit'), '100');
  assert.equal(q.get('bbox'), '-160,18,-154,23');
  assert.equal(q.get('datetime'), '2026-09-16T20:00:00Z/2026-09-23T20:00:00Z');
  assert.equal(ctx.http.requests[1]!.url, `${SEARCH_URL}?collections=sentinel-2-l2a&limit=100&next=abc`);
  assert.ok(ctx.http.requests.every((r) => new URL(r.url).host === 'earth-search.aws.element84.com'));
  assert.match((await provider.health()).message ?? '', /a next link to another origin was not followed/);
});

test('maxPages caps a search that keeps paging, and Source Health says more scenes match', async () => {
  let n = 0;
  const { provider, ctx } = await start(example(EARTH_SEARCH), () => {
    const page = JSON.parse(fixture('search-page1.json')) as { links: Array<Record<string, unknown>> };
    page.links[0]!['body'] = { next: `token-${++n}` };
    return ok(JSON.stringify(page));
  });
  const obs = await poll(provider);
  assert.equal(ctx.http.requests.length, 5, 'maxPages 5');
  assert.equal(obs.length, 3, 'the same scenes on every page are one observation each');
  assert.match((await provider.health()).message ?? '', /stopped at 5 page\(s\); more scenes match/);
});

test('a server that answers 405 to POST /search is searched with GET, then and on every later poll', async () => {
  const { provider, ctx } = await start(example(EARTH_SEARCH), (req) =>
    req.method === 'POST' ? { status: 405 } : ok(fixture('search-page2.json')),
  );
  assert.equal((await poll(provider)).length, 2);
  assert.deepEqual(
    ctx.http.requests.map((r) => r.method),
    ['POST', 'GET'],
  );
  assert.equal(new URL(ctx.http.requests[1]!.url).searchParams.get('collections'), 'sentinel-2-l2a');
  await poll(provider);
  assert.deepEqual(
    ctx.http.requests.map((r) => r.method),
    ['POST', 'GET', 'GET'],
  );
  const other = await start(example(EARTH_SEARCH), () => ({ status: 404 }));
  await assert.rejects(poll(other.provider), (e: unknown) => e instanceof ProviderError && e.code === 'HTTP_4XX');
  assert.equal(other.ctx.http.requests.length, 1, 'only 405/501 mean "no POST here"');
});

test('boundsQuery: no request until there is a view; the view across the antimeridian is searched as two halves', async () => {
  const { provider, ctx } = await start(example(EARTH_SEARCH), () => ok(fixture('search-antimeridian.json')));
  assert.deepEqual(await poll(provider, null), []);
  assert.equal(ctx.http.requests.length, 0);
  assert.match((await provider.health()).message ?? '', /waiting for a viewport/);
  const obs = await poll(provider, { west: 170, south: -20, east: -170, north: -10 });
  assert.deepEqual(
    ctx.http.requests.map((r) => bodyOf(r)['bbox']),
    [
      [170, -20, 180, -10],
      [-180, -20, -170, -10],
    ],
  );
  assert.equal(obs.length, 2, 'the same scenes from both halves are one observation each');
  const fiji = obs.find((o) => o.externalId === 'S2A_60KYF_20260920_0_L2A')!;
  assert.ok(Math.abs(fiji.position!.longitude - 179.925) < 1e-9, `bbox across 180°: ${fiji.position!.longitude}`);
  assert.ok(Math.abs(fiji.position!.latitude - -16.7) < 1e-9);
  assert.equal(fiji.geometry?.type, 'MultiPolygon');
  const noBbox = obs.find((o) => o.externalId === 'S2B_01KAB_20260917_0_L2A')!;
  assert.ok(
    Math.abs(noBbox.position!.longitude - -179.9) < 1e-9,
    `footprint split at 180°: ${noBbox.position!.longitude}`,
  );
  assert.ok(Math.abs(noBbox.position!.latitude - -15.6) < 1e-9);
});

// ── geometry ─────────────────────────────────────────────────────────────────

test('centroids: a 4-corner bbox, one across the antimeridian, a 6-number bbox, and bboxes that are not', () => {
  assert.deepEqual(bboxCentroid(bbox2d([-10, -5, 10, 5])!), [0, 0]);
  assert.deepEqual(bboxCentroid(bbox2d([175, -5, -175, 5])!), [180, 0], 'across 180° the middle is on it, not at 0°');
  assert.deepEqual(bboxCentroid(bbox2d([170, 10, -150, 20])!), [-170, 15]);
  assert.deepEqual(bboxCentroid(bbox2d([-157.1, 18.9, 0, -156.0, 19.9, 100])!), [-156.55, 19.4], 'heights ignored');
  assert.deepEqual(bbox2d([-180.0000001, -90, 180.0000001, 90]), [-180, -90, 180, 90], 'rounding clamped');
  assert.equal(bbox2d([-10, 5, 10, -5]), undefined, 'south above north');
  assert.equal(bbox2d([200, 0, 210, 1]), undefined);
  assert.equal(bbox2d([1, 2, 3]), undefined);
  assert.equal(bbox2d('0,0,1,1'), undefined);
  const split = readFootprint({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [178, 1],
          [180, 1],
          [180, 0],
          [178, 1],
        ],
      ],
      [
        [
          [-180, 1],
          [-178, 1],
          [-180, 0],
          [-180, 1],
        ],
      ],
    ],
  })!;
  assert.deepEqual(footprintBbox(split), [178, 0, -178, 1]);
  assert.deepEqual(bboxCentroid(footprintBbox(split)), [180, 0.5]);
  const plain = readFootprint({
    type: 'LineString',
    coordinates: [
      [-170, 0],
      [170, 0],
    ],
  })!;
  assert.deepEqual(footprintBbox(plain), [170, 0, -170, 0], 'a line over the antimeridian is the short way round');
});

function circle(vertices: number, cx = -155.5, cy = 19.5, r = 0.5): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i < vertices - 1; i++) {
    const a = (2 * Math.PI * i) / (vertices - 1);
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  ring.push(ring[0]!);
  return ring;
}

test('footprints over 5,000 vertices are thinned (rings stay closed); ones that cannot be are left out with a reason', () => {
  const dense = capFootprint({ type: 'Polygon', coordinates: [circle(12_000)] });
  assert.equal(dense.vertices, 12_000);
  assert.equal(dense.simplified, true);
  assert.ok(countVertices(dense.geometry!) <= MAX_FOOTPRINT_VERTICES);
  assert.ok(countVertices(dense.geometry!) > MAX_FOOTPRINT_VERTICES / 2, 'thinned no further than needed');
  const ring = (dense.geometry as { coordinates: number[][][] }).coordinates[0]!;
  assert.deepEqual(ring[0], ring[ring.length - 1], 'the ring is still closed');

  const small = capFootprint({ type: 'Polygon', coordinates: [circle(5)] });
  assert.equal(small.simplified, false);
  assert.equal(small.vertices, 5);

  const shards = capFootprint({
    type: 'MultiPolygon',
    coordinates: Array.from({ length: 1500 }, (_, i) => [circle(5, -150 + i / 100, 10, 0.001)]),
  });
  assert.equal(shards.geometry, undefined);
  assert.match(shards.dropped!, /7500 vertices in too many parts/);

  const outside = capFootprint({
    type: 'Polygon',
    coordinates: [
      [
        [200, 0],
        [201, 0],
        [201, 1],
        [200, 0],
      ],
    ],
  });
  assert.match(outside.dropped!, /not a GeoJSON geometry/);
  assert.match(
    capFootprint({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    }).dropped!,
    /not a GeoJSON geometry/,
  );
  assert.deepEqual(capFootprint({ type: 'Point', coordinates: [1, 2, 30] }).geometry, {
    type: 'Point',
    coordinates: [1, 2],
  });
});

test('through the provider: a dense footprint arrives thinned, an impossible one leaves the scene at its centre', async () => {
  const page = JSON.parse(fixture('search-page2.json')) as { features: Array<Record<string, unknown>> };
  page.features[0]!['geometry'] = { type: 'Polygon', coordinates: [circle(12_000, -156.8, 21.3, 0.4)] };
  page.features[1]!['geometry'] = {
    type: 'MultiPolygon',
    coordinates: Array.from({ length: 1500 }, (_, i) => [circle(5, -157 + i / 1000, 20.3, 0.0005)]),
  };
  const { provider } = await start(example(EARTH_SEARCH), () => ok(JSON.stringify(page)));
  const obs = await poll(provider);
  const thinned = obs.find((o) => o.externalId === 'S2A_4QGJ_20260920_0_L2A')!;
  assert.ok(countVertices(readFootprint(thinned.geometry)!) <= MAX_FOOTPRINT_VERTICES);
  assert.equal(thinned.payload['footprintSimplified'], true);
  const dropped = obs.find((o) => o.externalId === 'S2B_4QGH_20260918_0_L2A')!;
  assert.equal(dropped.geometry, undefined);
  assert.ok(Math.abs(dropped.position!.longitude - -156.57) < 1e-9, 'still at the centre of its bbox');
  const message = (await provider.health()).message ?? '';
  assert.match(message, /1 footprint\(s\) thinned to 5,000 vertices/);
  assert.match(message, /1 footprint\(s\) left out/);
});

test('item records: thumbnail absolute and https only, asset keys, the collection-qualified key, the source page, anything not an object untouched', () => {
  const item = {
    type: 'Feature',
    id: 'a',
    collection: 'c',
    bbox: [0, 0, 1, 1],
    geometry: null,
    properties: {},
    assets: { thumbnail: { href: '../thumbs/a.png' }, data: { href: 's3://bucket/a.tif' }, junk: 'x' },
    links: [{ rel: 'self', href: 'https://cat.example.org/items/a.json' }],
  };
  const r = itemRecord(item, 'https://cat.example.org/stac/items/a.json').record as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(r['_stac']!['thumbnail'], 'https://cat.example.org/stac/thumbs/a.png');
  assert.deepEqual(r['_stac']!['assets'], ['thumbnail', 'data']);
  assert.equal(r['_stac']!['key'], 'c/a');
  assert.equal(r['_stac']!['href'], 'https://cat.example.org/items/a.json');
  assert.deepEqual(r['_stac']!['centroid'], [0.5, 0.5]);
  assert.equal(r['geometry'], null);
  const insecure = { ...item, assets: { thumbnail: { href: 'http://cat.example.org/a.png' } } };
  const i = itemRecord(insecure, 'https://cat.example.org/a.json').record as Record<string, Record<string, unknown>>;
  assert.equal(i['_stac']!['thumbnail'], undefined);
  const noSelf = { ...item, links: [] };
  const inSearch = itemRecord(noSelf, 'https://api.example.org/search').record as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(inSearch['_stac']!['href'], undefined, "a search page is not the item's page");
  const ownFile = itemRecord(noSelf, 'https://cat.example.org/items/a.json', true).record as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(ownFile['_stac']!['href'], 'https://cat.example.org/items/a.json', "a static item's own file is");
  assert.equal(itemRecord('nope', 'https://x.example').record, 'nope');
  assert.equal(itemRecord(null, 'https://x.example').footprint, 'none');
});

// ── time ─────────────────────────────────────────────────────────────────────

test("datetime: seven days by default, the definition's window, the operator's setting, and a fixed interval as written", async () => {
  const sent = async (doc: unknown, settings: Record<string, JsonValue> = {}) => {
    const { provider, ctx } = await start(doc, () => ok(fixture('search-empty.json')), settings);
    await poll(provider);
    return { datetime: bodyOf(ctx.http.requests[0]!)['datetime'], manifest: provider.manifest };
  };
  const es = example(EARTH_SEARCH);
  const { datetime: _drop, ...noDatetime } = searchBodyOf(es);
  const byDefault = await sent(withEndpoint(es, { body: noDatetime }));
  assert.equal(byDefault.datetime, '2026-09-16T20:00:00Z/2026-09-23T20:00:00Z');
  assert.equal(byDefault.manifest.settings?.find((s) => s.key === 'windowDays')?.defaultLabel, '7 days');
  const month = await sent(withEndpoint(es, { body: { ...noDatetime, datetime: 'P30D' } }));
  assert.equal(month.datetime, '2026-08-24T20:00:00Z/2026-09-23T20:00:00Z');
  assert.equal(month.manifest.settings?.find((s) => s.key === 'windowDays')?.defaultLabel, '30 days');
  assert.equal((await sent(es, { windowDays: 2 })).datetime, '2026-09-21T20:00:00Z/2026-09-23T20:00:00Z');
  assert.equal((await sent(es, { windowDays: '3' })).datetime, '2026-09-20T20:00:00Z/2026-09-23T20:00:00Z');
  assert.equal(
    (await sent(es, { windowDays: 9999 })).datetime,
    '2026-08-24T20:00:00Z/2026-09-23T20:00:00Z',
    'cut to the 30 days imagery-scene keeps a scene',
  );
  assert.equal(byDefault.manifest.settings?.find((s) => s.key === 'windowDays')?.max, 30);
  const long = withEndpoint(es, { body: { ...noDatetime, datetime: 'P90D' } });
  assert.equal((await sent(long)).datetime, '2026-08-24T20:00:00Z/2026-09-23T20:00:00Z');
  assert.ok(
    defaultConnectorRegistry.validate(long).warnings.some((w) => /longer than scenes are kept \(30 days/.test(w)),
  );
  const keptForever = { ...long, freshness: { liveSeconds: 86_400, recentSeconds: 604_800 } };
  assert.equal((await sent(keptForever)).datetime, '2026-06-25T20:00:00Z/2026-09-23T20:00:00Z', 'no expiry: 90 days');
  assert.equal(
    (await sent(keptForever, { windowDays: 9999 })).datetime,
    '2025-09-22T20:00:00Z/2026-09-23T20:00:00Z',
    'and at most 366 days',
  );
  assert.equal((await sent(es, { windowDays: 'soon' })).datetime, '2026-09-16T20:00:00Z/2026-09-23T20:00:00Z');
  const fixedDoc = withEndpoint(es, { body: { ...noDatetime, datetime: '2026-01-01T00:00:00Z/2026-02-01T00:00:00Z' } });
  const fixed = await sent(fixedDoc, { windowDays: 2 });
  assert.equal(fixed.datetime, '2026-01-01T00:00:00Z/2026-02-01T00:00:00Z');
  assert.equal(fixed.manifest.settings?.some((s) => s.key === 'windowDays') ?? false, false);
  assert.ok(defaultConnectorRegistry.validate(fixedDoc).warnings.some((w) => /datetime is fixed/.test(w)));

  assert.equal(parseWindow('P7D'), 7 * 86_400_000);
  assert.equal(parseWindow('PT12H'), 12 * 3_600_000);
  assert.equal(parseWindow('P1DT6H'), 30 * 3_600_000);
  assert.equal(parseWindow('P'), undefined);
  assert.equal(parseWindow('P1W'), undefined);
  assert.equal(
    windowInterval(Date.parse('2026-09-23T20:00:00.999Z'), 86_400_000),
    '2026-09-22T20:00:00Z/2026-09-23T20:00:00Z',
  );
  assert.equal(isStacDatetime('2026-01-01T00:00:00Z'), true);
  assert.equal(isStacDatetime('../2026-01-01T00:00:00+02:00'), true);
  assert.equal(isStacDatetime('2026-01-01T00:00:00.5Z/'), true);
  assert.equal(isStacDatetime('../..'), false);
  assert.equal(isStacDatetime('2026-01-01'), false);
  assert.equal(isStacDatetime('a/b/c'), false);
});

// ── static catalogues ────────────────────────────────────────────────────────

const STATIC_ROOT = 'https://static.example.org/stac/';
/** The invented fixture tree, served at STATIC_ROOT by path; anything else is 404. */
const serveTree: Responder = (req) => {
  if (!req.url.startsWith(STATIC_ROOT)) return { status: 404 };
  const file = path.join(
    root,
    'fixtures',
    'connectors',
    'stac',
    'static',
    new URL(req.url).pathname.slice('/stac/'.length),
  );
  return existsSync(file) ? ok(readFileSync(file, 'utf8')) : { status: 404 };
};
const staticDoc = (extra: Record<string, unknown> = {}) => ({
  ...withEndpoint(example(STATIC), { url: `${STATIC_ROOT}catalog.json` }),
  ...extra,
});
const fetched = (reqs: ProviderHttpRequest[]) => reqs.map((r) => r.url.slice(STATIC_ROOT.length));

test('static catalogue: children and items to the leaves, one item reached twice read once, other hosts and a missing branch', async () => {
  const { provider, ctx } = await start(staticDoc(), serveTree);
  const obs = await poll(provider, null);
  assert.deepEqual(ids(obs), [
    'EXAMPLE_SAR_SM_20260314T081200',
    'EXAMPLE_SAR_SP_20260105T103000',
    'EXAMPLE_SAR_SP_20260214T061522',
  ]);
  assert.deepEqual(fetched(ctx.http.requests), [
    'catalog.json',
    'by-mode/catalog.json',
    'by-mode/spotlight/collection.json',
    'by-mode/spotlight/items/EXAMPLE_SAR_SP_20260105T103000.json',
    'by-mode/spotlight/items/EXAMPLE_SAR_SP_20260214T061522.json',
    'by-date/catalog.json',
    'by-date/2026/collection.json',
    'by-date/2026/items/EXAMPLE_SAR_SM_20260314T081200.json',
    'retired/catalog.json',
  ]);
  assert.ok(ctx.http.requests.every((r) => r.method === 'GET'));
  const a = obs.find((o) => o.externalId === 'EXAMPLE_SAR_SP_20260105T103000')!;
  assert.equal(a.observedAt, '2026-01-05T10:30:00.000Z');
  assert.equal(
    a.payload['thumbnailUrl'],
    `${STATIC_ROOT}by-mode/spotlight/items/EXAMPLE_SAR_SP_20260105T103000_thumb.png`,
    'relative to the item file',
  );
  assert.equal(a.payload['sourceUrl'], `${STATIC_ROOT}by-mode/spotlight/items/EXAMPLE_SAR_SP_20260105T103000.json`);
  assert.equal(a.payload['instrumentMode'], 'spotlight');
  assert.equal(a.objectType, 'imagery-scene');
  assert.equal(a.payload['processingLevel'], 'GEO');
  assert.equal(a.payload['instrument'], 'sar');
  assert.ok(Math.abs(a.position!.longitude - -157.9) < 1e-9 && Math.abs(a.position!.latitude - 21.3) < 1e-9);
  const b = obs.find((o) => o.externalId === 'EXAMPLE_SAR_SP_20260214T061522')!;
  assert.equal(b.payload['thumbnailUrl'], undefined, 'an http thumbnail is not kept');
  const message = (await provider.health()).message ?? '';
  assert.match(message, /1 link\(s\) to other hosts not followed/);
  assert.match(message, /1 document\(s\) unreadable/);
});

test("static catalogue: the depth cap (the operator's setting) and the document budget (maxPages) stop the walk", async () => {
  const shallow = await start(staticDoc(), serveTree, { maxDepth: 2 });
  assert.deepEqual(await poll(shallow.provider, null), []);
  assert.deepEqual(fetched(shallow.ctx.http.requests), [
    'catalog.json',
    'by-mode/catalog.json',
    'by-mode/spotlight/collection.json',
    'by-date/catalog.json',
    'by-date/2026/collection.json',
    'retired/catalog.json',
  ]);
  assert.match((await shallow.provider.health()).message ?? '', /4 link\(s\) past the depth cap/);
  assert.equal(shallow.provider.manifest.settings?.find((s) => s.key === 'maxDepth')?.max, 8);

  const budget = await start(
    staticDoc({ pagination: { strategy: 'next-link', nextLinkPath: 'links', maxPages: 4 } }),
    serveTree,
  );
  const obs = await poll(budget.provider, null);
  assert.equal(budget.ctx.http.requests.length, 4);
  assert.deepEqual(
    ids(obs),
    ['EXAMPLE_SAR_SP_20260105T103000'],
    'items before sub-catalogues: the budget still finds scenes',
  );
  assert.match((await budget.provider.health()).message ?? '', /walk stopped at 4 documents/);
});

test('static catalogue: the root failing is the source failing; a refusal below it ends the walk; cancellation mid-walk', async () => {
  const down = await start(staticDoc(), () => ({ status: 503 }));
  await assert.rejects(poll(down.provider, null), (e: unknown) => e instanceof ProviderError && e.code === 'HTTP_5XX');
  const refused = await start(staticDoc(), (req) => (req.url.includes('by-mode') ? { status: 401 } : serveTree(req)));
  await assert.rejects(poll(refused.provider, null), (e: unknown) => e instanceof ProviderError && e.code === 'AUTH');
  const abort = new AbortController();
  const cancelled = await start(staticDoc(), (req) => {
    if (req.url.includes('by-mode')) abort.abort();
    return serveTree(req);
  });
  await assert.rejects(
    poll(cancelled.provider, null, abort.signal),
    (e: unknown) => e instanceof ProviderError && e.code === 'CANCELLED',
  );
  const item = await start(
    withEndpoint(example(STATIC), { url: `${STATIC_ROOT}by-mode/spotlight/items/EXAMPLE_SAR_SP_20260105T103000.json` }),
    serveTree,
  );
  assert.deepEqual(ids(await poll(item.provider, null)), ['EXAMPLE_SAR_SP_20260105T103000'], 'an item as the root');
});

test('static catalogue: items served from the cache are marked cached; a mapping that fits no item is MALFORMED', async () => {
  const { provider } = await start(staticDoc(), (req) => {
    const r = serveTree(req);
    return req.url.endsWith('EXAMPLE_SAR_SM_20260314T081200.json') ? { ...r, served: 'cache' } : r;
  });
  const obs = await poll(provider, null);
  assert.deepEqual(obs.map((o) => `${o.externalId} ${o.provenance.origin}`).sort(), [
    'EXAMPLE_SAR_SM_20260314T081200 cached',
    'EXAMPLE_SAR_SP_20260105T103000 live',
    'EXAMPLE_SAR_SP_20260214T061522 live',
  ]);
  const broken = await start(staticDoc({ mapping: { externalId: 'no.such.id' } }), serveTree);
  await assert.rejects(
    poll(broken.provider, null),
    (e: unknown) => e instanceof ProviderError && e.code === 'MALFORMED',
  );
});

test("static catalogue: an API collection's items link (an ItemCollection paged by rel=next) is read too", async () => {
  const collection = {
    type: 'Collection',
    id: 'c',
    stac_version: '1.0.0',
    links: [{ rel: 'items', href: 'https://api.example.org/collections/c/items' }],
  };
  const page1 = JSON.parse(fixture('search-page1.json')) as { links: unknown[] };
  page1.links = [{ rel: 'next', href: 'https://api.example.org/collections/c/items?next=2' }];
  const page2 = JSON.parse(fixture('search-page2.json'));
  const { provider, ctx } = await start(
    withEndpoint(example(STATIC), { url: 'https://api.example.org/collections/c' }),
    (req) =>
      ok(JSON.stringify(req.url.endsWith('/collections/c') ? collection : req.url.includes('next=2') ? page2 : page1)),
  );
  assert.equal((await poll(provider, null)).length, 5);
  assert.deepEqual(
    ctx.http.requests.map((r) => r.url),
    [
      'https://api.example.org/collections/c',
      'https://api.example.org/collections/c/items',
      'https://api.example.org/collections/c/items?next=2',
    ],
  );
});

// ── validation and the manifest ─────────────────────────────────────────────

test('validation: what a STAC definition may not say, each refused with the reason', () => {
  const es = example(EARTH_SEARCH);
  const body = searchBodyOf(es);
  const refuse = (doc: unknown, why: RegExp) => {
    const v = defaultConnectorRegistry.validate(doc);
    assert.equal(v.ok, false, `accepted: ${JSON.stringify(doc).slice(0, 120)}`);
    assert.ok(
      v.errors.some((e) => why.test(e)),
      `${why} not among ${JSON.stringify(v.errors)}`,
    );
  };
  refuse({ ...es, objectType: 'sensor' }, /objectType must be "imagery-scene"/);
  refuse({ ...es, objectType: 'place' }, /objectType must be "imagery-scene"/);
  refuse({ ...staticDoc(), boundsQuery: true }, /boundsQuery needs an item search/);
  refuse({ ...es, pagination: { strategy: 'cursor', cursorParam: 'c', cursorPath: 'next' } }, /does not apply/);
  refuse({ ...es, pagination: { strategy: 'next-link', nextLinkPath: 'next' } }, /must be "links"/);
  refuse(
    {
      ...withEndpoint(es, { url: 'https://stac.example.org/{TOKEN}/search', credential: { name: 'key', as: 'path' } }),
      credentials: { key: { secretRef: 'stac.key' } },
    },
    /"path" is not supported/,
  );
  refuse(withEndpoint(es, { body: { ...body, bbox: [0, 0, 1, 1] } }), /remove bbox\/intersects/);
  refuse(withEndpoint(es, { body: { ...body, datetime: 'yesterday' } }), /neither a STAC datetime/);
  refuse(withEndpoint(es, { body: { ...body, datetime: 'P400D' } }), /outside one hour to 366 days/);
  refuse(withEndpoint(es, { query: { collections: 'sentinel-2-l2a' } }), /describe the search in endpoint.body/);
  refuse(withEndpoint(es, { body: { ...body, limit: 0 } }), /limit must be an integer/);
  refuse(withEndpoint(es, { body: { ...body, collections: 'sentinel-2-l2a' } }), /list of collection ids/);
  refuse(withEndpoint(es, { body: { ...body, token: 'next:abc' } }), /paging token/);
  refuse(withEndpoint(es, { body: ['collections'] }), /must be a JSON object/);
  refuse(withEndpoint(staticDoc(), { method: 'POST' }), /read with GET/);
  refuse({ ...es, response: { format: 'csv' } }, /a STAC source is JSON/);
  const worldwide = defaultConnectorRegistry.validate({
    ...withEndpoint(es, { body: { limit: 10 } }),
    boundsQuery: false,
  });
  assert.ok(worldwide.ok, worldwide.errors.join('; '));
  assert.ok(worldwide.warnings.some((w) => /collections is unset/.test(w)));
  assert.ok(worldwide.warnings.some((w) => /the search is worldwide/.test(w)));
  const { freshness: _f, ...staticNoFreshness } = staticDoc() as Record<string, unknown>;
  assert.ok(
    defaultConnectorRegistry
      .validate(staticNoFreshness)
      .warnings.some((w) => /catalogue scenes older than 30 days are refused/.test(w)),
    'a static catalogue on the type default is warned that old scenes will be refused',
  );
  assert.equal(stacMode('https://x.example/v1/search/'), 'search');
  assert.equal(stacMode('https://x.example/catalog.json'), 'static');
});

test('manifest: a request budget that covers a whole poll, the 15-minute default cadence, the settings', () => {
  const es = defaultConnectorRegistry.validate(example(EARTH_SEARCH)).definition!;
  const sdk = definitionToManifest(es, 'x').refreshPolicy.maxRequestsPerMinute;
  const m = defaultConnectorRegistry.createProvider(es).manifest;
  assert.equal(sdk, 13, "the SDK's own floor since the ADR-013 amendment: twice one poll's 6 requests, plus one");
  assert.ok(
    m.refreshPolicy.maxRequestsPerMinute >= 2 * (2 * 5 + 1),
    'two polls of two halves of 5 pages, plus retries',
  );
  assert.equal(m.refreshPolicy.pollBudgetMs, m.refreshPolicy.timeoutMs * 11 + 5000, 'the whole poll, not one request');
  assert.equal(m.refreshPolicy.intervalMs, 900_000);
  assert.deepEqual(m.allowedHosts, ['earth-search.aws.element84.com']);
  assert.ok(m.settings?.some((s) => s.key === 'windowDays'));
  const { endpoint, pagination: _p, ...rest } = example(EARTH_SEARCH);
  const { intervalSeconds: _i, ...e } = endpoint as Record<string, unknown>;
  const bare = defaultConnectorRegistry.validate({ ...rest, endpoint: e }).definition!;
  const bm = defaultConnectorRegistry.createProvider(bare).manifest;
  assert.equal(bm.refreshPolicy.intervalMs, 900_000, 'STAC default cadence');
  const st = defaultConnectorRegistry.createProvider(
    defaultConnectorRegistry.validate(example(STATIC)).definition!,
  ).manifest;
  assert.ok(st.refreshPolicy.maxRequestsPerMinute >= 150, 'a walk of 150 documents fits');
  assert.equal(st.refreshPolicy.pollBudgetMs, 600_000, 'a walk of 150 documents gets the ten-minute ceiling');
  assert.ok(st.settings?.some((s) => s.key === 'maxDepth'));
  assert.equal(st.settings?.some((s) => s.key === 'windowDays') ?? false, false);
});

test("defaults: a definition that names only the id gets the time, centre, footprint and the amendment's payload", async () => {
  const es = example(EARTH_SEARCH);
  const { provider } = await start({ ...es, mapping: { externalId: 'id' } }, () => ok(fixture('search-page1.json')));
  const obs = await poll(provider);
  assert.equal(obs.length, 3);
  const c = obs.find((o) => o.externalId === 'S2C_5QKA_20260919_0_L2A')!;
  assert.equal(c.observedAt, '2026-09-19T21:08:44.117Z');
  assert.ok(Math.abs(c.position!.longitude - -155.54) < 1e-9);
  assert.equal(c.geometry?.type, 'Polygon');
  assert.deepEqual(
    Object.keys(c.payload).sort(),
    [
      'assetKeys',
      'capturedAt',
      'cloudCoverPct',
      'collection',
      'instrument',
      'platform',
      'sceneId',
      'sourceUrl',
      'thumbnailUrl',
    ],
    'every key the amendment names that the item has (no gsd or processing level in it)',
  );
  assert.equal(c.payload['capturedAt'], '2026-09-19T21:08:44.117Z');
  assert.equal(c.payload['instrument'], 'msi');
});

test('GET form of a search: arrays joined, sortby and fields in their GET syntax, objects as JSON', () => {
  assert.deepEqual(
    toQuery({
      collections: ['a', 'b'],
      bbox: [1, 2, 3, 4],
      limit: 10,
      sortby: [
        { field: 'properties.datetime', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      fields: { include: ['id'], exclude: ['assets'] },
      intersects: { type: 'Point', coordinates: [1, 2] },
      skip: null,
    }),
    [
      ['collections', 'a,b'],
      ['bbox', '1,2,3,4'],
      ['limit', '10'],
      ['sortby', '-properties.datetime,+id'],
      ['fields', 'id,-assets'],
      ['intersects', '{"type":"Point","coordinates":[1,2]}'],
    ],
  );
  assert.deepEqual(viewBoxes({ west: -180, south: -95, east: 180, north: 95 }), [[-180, -90, 180, 90]]);
  assert.deepEqual(viewBoxes({ west: 10.123456, south: 1, east: 11, north: 2 }), [[10.12346, 1, 11, 2]]);
});
