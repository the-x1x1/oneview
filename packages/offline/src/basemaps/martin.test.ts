import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  attributionText,
  checkMartinUrl,
  listMartinSources,
  parseMartinCatalog,
  parseMartinTileJson,
  publicHostProblem,
  readMartinBasemap,
} from './martin.js';

/*
 * The TileJSON and catalog documents below are invented in the shape Martin publishes
 * (maplibre.org/martin: TileJSON 3.0.0 per source, `/catalog` with a `tiles` map); the
 * layer names and attribution are those a Protomaps basemap PMTiles file carries. None was
 * recorded from a running Martin.
 */
const PROTOMAPS_LAYERS = [
  'boundaries',
  'buildings',
  'earth',
  'landcover',
  'landuse',
  'places',
  'pois',
  'roads',
  'transit',
  'water',
];

function tileJson(origin: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tilejson: '3.0.0',
    tiles: [`${origin}/basemap/{z}/{x}/{y}`],
    vector_layers: PROTOMAPS_LAYERS.map((id) => ({ id, fields: {} })),
    bounds: [-161, 18.5, -154.5, 22.5],
    minzoom: 0,
    maxzoom: 15,
    name: 'Protomaps Basemap',
    description: 'Basemap layers derived from OpenStreetMap and Natural Earth',
    attribution:
      '<a href="https://github.com/protomaps/basemaps">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
    ...extra,
  };
}

test('checkMartinUrl: loopback and the trusted host over http, everything else https to a public name', () => {
  assert.equal(checkMartinUrl('http://127.0.0.1:3000/basemap').ok, true);
  assert.equal(checkMartinUrl('http://localhost:3000/basemap').ok, true);
  assert.equal(checkMartinUrl('http://[::1]:3000/basemap').ok, true);
  const trusted = checkMartinUrl('http://tiles.home.arpa:3000/basemap', 'tiles.home.arpa');
  assert.ok(trusted.ok && trusted.value.access === 'trusted');
  const nas = checkMartinUrl('http://192.168.1.20:3000/basemap', '192.168.1.20');
  assert.ok(nas.ok && nas.value.access === 'trusted');

  for (const [url, why] of [
    ['http://192.168.1.20:3000/basemap', /must be https/],
    ['https://192.168.1.20/basemap', /private, loopback or link-local/],
    ['https://169.254.169.254/latest', /link-local/],
    ['https://tiles.local/basemap', /private-use/],
    ['https://tiles/basemap', /single label/],
    ['https://[fd00::1]/basemap', /IPv6/],
    ['http://tiles.example.org/basemap', /must be https/],
    ['ftp://127.0.0.1/basemap', /http or https/],
    ['http://user:pw@127.0.0.1:3000/basemap', /credentials/],
    ['http://127.0.0.1:3000/basemap?key=1', /query/],
    ['not a url', /not a URL/],
  ] as const) {
    const r = checkMartinUrl(url);
    assert.ok(!r.ok, url);
    assert.match(!r.ok ? r.reason : '', why, url);
  }
  const pub = checkMartinUrl('https://tiles.example.org/basemap');
  assert.ok(pub.ok && pub.value.access === 'public');
  // A trusted host must be exact; a different LAN host is still refused.
  assert.equal(checkMartinUrl('http://192.168.1.21:3000/basemap', '192.168.1.20').ok, false);
  assert.equal(checkMartinUrl('http://evil.example/basemap', '*').ok, false);
});

test('publicHostProblem refuses private, reserved and local-only names', () => {
  assert.equal(publicHostProblem('tiles.example.org'), undefined);
  assert.equal(publicHostProblem('8.8.8.8'), undefined);
  assert.ok(publicHostProblem('localhost.'));
  assert.ok(publicHostProblem('10.0.0.1'));
  assert.ok(publicHostProblem('172.20.0.1'));
  assert.ok(publicHostProblem('100.100.0.1'));
  assert.ok(publicHostProblem('0.0.0.0'));
  assert.ok(publicHostProblem('nas.lan'));
  assert.ok(publicHostProblem('box.internal'));
  for (const reserved of [
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.0.8',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
  ])
    assert.match(publicHostProblem(reserved) ?? '', /reserved, multicast or documentation/, reserved);
  assert.equal(publicHostProblem('198.20.0.1'), undefined);
});

test('parseMartinTileJson reads templates, zooms, bounds and attribution from a Protomaps source', () => {
  const url = new URL('http://127.0.0.1:3000/basemap');
  const r = parseMartinTileJson(tileJson('http://127.0.0.1:3000'), { url, access: 'loopback' });
  assert.ok(r.ok, !r.ok ? r.reason : '');
  const b = r.value;
  assert.equal(b.id, 'martin-basemap');
  assert.equal(b.name, 'Protomaps Basemap');
  assert.deepEqual(b.tiles, ['http://127.0.0.1:3000/basemap/{z}/{x}/{y}']);
  assert.equal(b.minZoom, 0);
  assert.equal(b.maxZoom, 15);
  assert.deepEqual(b.bounds, { west: -161, south: 18.5, east: -154.5, north: 22.5 });
  assert.equal(b.attribution, 'Protomaps © OpenStreetMap');
  assert.equal(b.attributionFrom, 'tilejson');

  // Relative templates resolve against the TileJSON URL; defaults follow TileJSON 3.0.0.
  const rel = parseMartinTileJson(
    tileJson('', { tiles: ['/basemap/{z}/{x}/{y}'], bounds: undefined, minzoom: undefined }),
    {
      url,
      access: 'loopback',
    },
  );
  assert.ok(rel.ok);
  assert.deepEqual(rel.value.tiles, ['http://127.0.0.1:3000/basemap/{z}/{x}/{y}']);
  assert.equal(rel.value.minZoom, 0);
  assert.equal(rel.value.bounds.west, -180);
});

test('parseMartinTileJson refuses templates off the server, other schemas, and a source nobody credits', () => {
  const url = new URL('http://127.0.0.1:3000/basemap');
  const src = { url, access: 'loopback' as const };
  for (const [doc, why] of [
    [tileJson('http://169.254.169.254'), /not on the Martin server/],
    [tileJson('http://127.0.0.1:3001'), /not on the Martin server/],
    [
      tileJson('http://127.0.0.1:3000', { tiles: ['blob:http://127.0.0.1:3000/{z}/{x}/{y}'] }),
      /not on the Martin server/,
    ],
    [
      tileJson('http://127.0.0.1:3000', { tiles: ['https://127.0.0.1:3000/basemap/{z}/{x}/{y}'] }),
      /not on the Martin server/,
    ],
    [tileJson('http://127.0.0.1:3000', { tiles: ['http://127.0.0.1:3000/basemap/tile.pbf'] }), /lacks \{z\}/],
    [tileJson('http://127.0.0.1:3000', { tiles: [] }), /no "tiles"/],
    [tileJson('http://127.0.0.1:3000', { maxzoom: 31 }), /minzoom\/maxzoom/],
    [tileJson('http://127.0.0.1:3000', { minzoom: 9, maxzoom: 3 }), /minzoom\/maxzoom/],
    [tileJson('http://127.0.0.1:3000', { bounds: [0, 0, 0] }), /bounds/],
    [tileJson('http://127.0.0.1:3000', { vector_layers: undefined }), /no vector_layers/],
    [
      tileJson('http://127.0.0.1:3000', {
        vector_layers: ['water', 'landcover', 'transportation', 'place', 'boundary'].map((id) => ({ id })),
      }),
      /lacks the Protomaps basemap layers earth, roads, places, boundaries/,
    ],
    [tileJson('http://127.0.0.1:3000', { attribution: undefined }), /uncredited/],
    [tileJson('http://127.0.0.1:3000', { attribution: '<a href="x"></a>' }), /uncredited/],
    [[], /not a JSON object/],
  ] as const) {
    const r = parseMartinTileJson(doc, src);
    assert.ok(!r.ok, why.source);
    assert.match(!r.ok ? r.reason : '', why);
  }
  const credited = parseMartinTileJson(tileJson('http://127.0.0.1:3000', { attribution: undefined }), {
    ...src,
    attribution: '© OpenStreetMap contributors, ODbL',
  });
  assert.ok(credited.ok && credited.value.attributionFrom === 'operator');
  assert.equal(credited.ok && credited.value.attribution, '© OpenStreetMap contributors, ODbL');
});

test('attributionText keeps the words and drops the markup', () => {
  assert.equal(attributionText('<b>A</b>&nbsp;&amp;&#32;<i>B</i> &#xA9; C'), 'A & B © C');
  assert.equal(attributionText('<script>alert(1)</script>x'), 'alert(1) x');
  assert.equal(attributionText('a\u0007b'), 'a b');
  // Markup written as entities is decoded and then dropped, never handed on as markup.
  const decoded = attributionText('&lt;img src=x onerror=alert(1)&gt; &#60;b&#62;OSM');
  assert.ok(!/[<>]/.test(decoded), decoded);
  assert.equal(decoded, 'img src=x onerror=alert(1) b OSM');
});

test('parseMartinCatalog lists vector sources first', () => {
  const r = parseMartinCatalog({
    tiles: {
      satellite: { content_type: 'image/webp' },
      basemap: { content_type: 'application/x-protobuf', name: 'Protomaps Basemap' },
      'bad id!': { content_type: 'application/x-protobuf' },
    },
    sprites: {},
    fonts: {},
  });
  assert.ok(r.ok);
  assert.deepEqual(
    r.value.map((e) => e.id),
    ['basemap', 'satellite'],
  );
  assert.equal(parseMartinCatalog({ nothing: true }).ok, false);
});

async function withServer(handler: http.RequestListener, body: (origin: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('readMartinBasemap and listMartinSources over real HTTP on loopback', async () => {
  const requests: string[] = [];
  await withServer(
    (req, res) => {
      requests.push(req.url ?? '');
      const origin = `http://${req.headers.host}`;
      if (req.url === '/basemap') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(tileJson(origin)));
      } else if (req.url === '/catalog') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tiles: { basemap: { content_type: 'application/x-protobuf' } } }));
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: `${origin}/basemap` });
        res.end();
      } else if (req.url === '/huge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"pad":"${'x'.repeat(2048)}"}`);
      } else if (req.url === '/stall-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"tiles":');
      } else if (req.url === '/reset-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"tiles":');
        setTimeout(() => req.socket.destroy(), 20);
      } else if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200);
          res.end('{}');
        }, 500);
      } else {
        res.writeHead(404);
        res.end();
      }
    },
    async (origin) => {
      const ok = await readMartinBasemap({ url: `${origin}/basemap` });
      assert.ok(ok.ok, !ok.ok ? ok.reason : '');
      assert.deepEqual(ok.value.tiles, [`${origin}/basemap/{z}/{x}/{y}`]);
      assert.equal(ok.value.access, 'loopback');

      const list = await listMartinSources(origin);
      assert.ok(list.ok && list.value[0]!.id === 'basemap');

      const moved = await readMartinBasemap({ url: `${origin}/moved` });
      assert.ok(!moved.ok);
      assert.match(!moved.ok ? moved.reason : '', /redirects are not followed/);
      assert.equal(requests.filter((u) => u === '/basemap').length, 1, 'the redirect target was not requested');

      const huge = await readMartinBasemap({ url: `${origin}/huge` }, { maxBytes: 1024 });
      assert.match(!huge.ok ? huge.reason : '', /larger than 1024 bytes/);

      const slow = await readMartinBasemap({ url: `${origin}/slow` }, { timeoutMs: 50 });
      assert.match(!slow.ok ? slow.reason : '', /did not answer within 50 ms/);

      const stalled = await readMartinBasemap({ url: `${origin}/stall-body` }, { timeoutMs: 100 });
      assert.match(!stalled.ok ? stalled.reason : '', /did not finish answering within 100 ms/);
      const reset = await readMartinBasemap({ url: `${origin}/reset-body` });
      assert.match(!reset.ok ? reset.reason : '', /broke off its answer/);

      const missing = await readMartinBasemap({ url: `${origin}/nope` });
      assert.match(!missing.ok ? missing.reason : '', /HTTP 404/);
    },
  );
});

test('readMartinBasemap never makes a request for a URL the policy refuses', async () => {
  let calls = 0;
  const r = await readMartinBasemap(
    { url: 'http://192.168.1.20:3000/basemap' },
    {
      fetch: async () => {
        calls++;
        throw new Error('unreachable');
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
});
