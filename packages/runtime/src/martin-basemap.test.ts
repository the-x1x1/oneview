import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MartinBasemap } from '@worldview/offline';
import { MARTIN_BASEMAP_IDS, MARTIN_CACHE_MS, MartinBasemaps, martinProviderEntries } from './martin-basemap.js';

// An invented source in the shape readMartinBasemap returns, not a real server's answer.
const basemap = (over: Partial<MartinBasemap> = {}): MartinBasemap => ({
  id: 'martin-basemap',
  name: 'Hawaii basemap',
  tileJsonUrl: 'http://127.0.0.1:3000/basemap',
  access: 'loopback',
  tiles: ['http://127.0.0.1:3000/basemap/{z}/{x}/{y}'],
  minZoom: 0,
  maxZoom: 14,
  bounds: { west: -161, south: 18, east: -154, north: 23 },
  attribution: '© OpenStreetMap contributors',
  attributionFrom: 'tilejson',
  vectorLayers: ['earth', 'water', 'roads', 'places', 'boundaries'],
  ...over,
});

test('a Martin source on this computer is offered in the dark and light styles, 2D only, with its credit', () => {
  const entries = martinProviderEntries({ ok: true, value: basemap() });
  assert.deepEqual(
    entries.map((e) => e.id),
    [MARTIN_BASEMAP_IDS.dark, MARTIN_BASEMAP_IDS.light],
  );
  const dark = entries[0]!;
  assert.equal(dark.available, true);
  assert.deepEqual(dark.modes, ['2D']);
  assert.equal(dark.offlineCapable, true, 'it runs here');
  assert.equal(dark.attribution, '© OpenStreetMap contributors');
  assert.deepEqual(dark.descriptor, {
    kind: 'vector-tiles',
    id: 'martin-dark',
    tiles: ['http://127.0.0.1:3000/basemap/{z}/{x}/{y}'],
    minZoom: 0,
    maxZoom: 14,
    bounds: { west: -161, south: 18, east: -154, north: 23 },
    styleId: 'worldview-dark',
    attribution: '© OpenStreetMap contributors',
  });
  assert.equal(entries[1]!.descriptor.kind === 'vector-tiles' && entries[1]!.descriptor.styleId, 'worldview-light');
});

test('a source that cannot be read, or a LAN host over plain http, is listed unavailable with why', () => {
  const failed = martinProviderEntries({ ok: false, reason: 'http://127.0.0.1:3000/basemap answered HTTP 404' });
  assert.equal(failed.length, 2);
  assert.ok(failed.every((e) => !e.available));
  assert.equal(failed[0]!.unavailableReason, 'Martin: http://127.0.0.1:3000/basemap answered HTTP 404');

  const lanHttp = martinProviderEntries({
    ok: true,
    value: basemap({
      access: 'trusted',
      tileJsonUrl: 'http://tiles.home.example:3000/basemap',
      tiles: ['http://tiles.home.example:3000/basemap/{z}/{x}/{y}'],
    }),
  });
  assert.ok(lanHttp.every((e) => !e.available));
  assert.match(lanHttp[0]!.unavailableReason ?? '', /plain http.*https or run Martin on this computer/);

  const lanHttps = martinProviderEntries({
    ok: true,
    value: basemap({
      access: 'trusted',
      tileJsonUrl: 'https://tiles.home.example/basemap',
      tiles: ['https://tiles.home.example/basemap/{z}/{x}/{y}'],
    }),
  });
  assert.ok(
    lanHttps.every((e) => e.available),
    'over https it is drawn',
  );
  const pub = martinProviderEntries({ ok: true, value: basemap({ access: 'public' }) });
  assert.equal(pub[0]!.offlineCapable, false, 'a public server needs the network');
});

test('the TileJSON is read once a minute for the same settings, again when they change, never without a URL', async () => {
  let now = 0;
  const asked: unknown[] = [];
  const martin = new MartinBasemaps(
    async (config) => {
      asked.push(config);
      return { ok: true, value: basemap() };
    },
    () => now,
  );
  assert.deepEqual(await martin.entries(undefined), []);
  assert.deepEqual(await martin.entries({ url: '  ', trustedHost: '', attribution: '' }), []);
  assert.equal(asked.length, 0);

  const config = { url: ' http://127.0.0.1:3000/basemap ', trustedHost: '', attribution: '' };
  assert.equal((await martin.entries(config)).length, 2);
  assert.deepEqual(asked[0], { url: 'http://127.0.0.1:3000/basemap' }, 'trimmed; empty options left out');
  now += MARTIN_CACHE_MS - 1;
  await martin.entries(config);
  assert.equal(asked.length, 1, 'within the minute: cached');
  now += 2;
  await martin.entries(config);
  assert.equal(asked.length, 2, 'after it: read again');
  await martin.entries({ ...config, trustedHost: 'Tiles.Home.Example', attribution: ' © me ' });
  assert.deepEqual(asked[2], {
    url: 'http://127.0.0.1:3000/basemap',
    trustedHost: 'tiles.home.example',
    attribution: '© me',
  });
});
