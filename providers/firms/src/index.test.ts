import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, testing } from '@worldview/provider-sdk';
import {
  FirmsProvider,
  parseSettings,
  boundsToArea,
  firmsAreaUrl,
  firmsRequest,
  parseFirmsAreaUrl,
  formatArea,
} from './index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'firms');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
const START = Date.parse('2026-09-21T08:05:00Z');
const signal = () => new AbortController().signal;

function setup(
  opts: {
    credentials?: string[];
    settings?: Record<string, string | number | string[]>;
    responder?: testing.FixtureResponder;
  } = {},
) {
  const ctx = testing.createFixtureContext({
    providerId: 'nasa-firms',
    clock: new testing.VirtualClock(START),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    ...(opts.settings ? { settings: opts.settings } : {}),
    responder: opts.responder ?? (() => ({ status: 200, body: body('viirs-snpp.csv') })),
  });
  const provider = new FirmsProvider();
  return { ctx, provider };
}

test('without a MAP_KEY the provider is AUTH_REQUIRED and issues no request', async () => {
  const { ctx, provider } = setup();
  await provider.initialize(ctx);
  await provider.start();
  assert.equal((await provider.health()).status, 'AUTH_REQUIRED');
  await assert.rejects(
    provider.query({ signal: signal(), background: true }),
    (err: unknown) => err instanceof ProviderError && err.code === 'AUTH',
  );
  assert.equal(ctx.http.requests.length, 0);
  const h = await provider.health();
  assert.equal(h.status, 'AUTH_REQUIRED');
  assert.equal(h.credentialState, 'missing');
  ctx.credentials.grant('firms.mapKey');
  const obs = await provider.query({ signal: signal(), background: true });
  assert.equal(obs.length, 24, '8 rows × 3 default sources (same fixture for each)');
  assert.equal((await provider.health()).status, 'LIVE');
});

test('requests carry the key placeholder in the path and the credential declaration; sources are sequential', async () => {
  const { ctx, provider } = setup({ credentials: ['firms.mapKey'] });
  await provider.initialize(ctx);
  await provider.start();
  await provider.query({ signal: signal(), background: true });
  assert.deepEqual(
    ctx.http.requests.map((r) => r.url),
    [
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/world/1',
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_NOAA20_NRT/world/1',
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_NOAA21_NRT/world/1',
    ],
  );
  assert.deepEqual(ctx.http.requests[0]?.credential, { key: 'firms.mapKey', as: 'path', name: 'MAP_KEY' });
});

test('viewport bounds become a padded, whole-degree FIRMS area', async () => {
  assert.deepEqual(boundsToArea({ west: -121.9, south: 37.2, east: -120.1, north: 38.9 }), {
    west: -123,
    south: 36,
    east: -119,
    north: 40,
  });
  assert.equal(boundsToArea(undefined), 'world');
  assert.equal(
    boundsToArea({ west: 170, south: -20, east: -170, north: -10 }),
    'world',
    'antimeridian crossing → world',
  );
  assert.equal(boundsToArea({ west: -179.5, south: -89.5, east: 179.5, north: 89.5 }), 'world');
  assert.deepEqual(boundsToArea({ west: -180, south: 80, east: 180, north: 90 }), {
    west: -180,
    south: 79,
    east: 180,
    north: 90,
  });
  assert.equal(formatArea({ west: -123, south: 36, east: -119, north: 40 }), '-123,36,-119,40');
  const { ctx, provider } = setup({
    credentials: ['firms.mapKey'],
    settings: { sources: ['VIIRS_SNPP_NRT'], dayRange: 3 },
  });
  await provider.initialize(ctx);
  await provider.start();
  await provider.query({
    signal: signal(),
    background: false,
    bounds: { west: -121.9, south: 37.2, east: -120.1, north: 38.9 },
  });
  assert.equal(
    ctx.http.requests[0]?.url,
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/-123,36,-119,40/3',
  );
});

test('url helpers: the one-line switch to a path credential and parsing of both key forms', () => {
  assert.equal(
    firmsAreaUrl('MODIS_NRT', 'world', 99),
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/MODIS_NRT/world/10',
  );
  assert.equal(
    firmsAreaUrl('MODIS_NRT', 'world', 1, 'abcdef0123456789abcdef0123456789'),
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/abcdef0123456789abcdef0123456789/MODIS_NRT/world/1',
  );
  assert.deepEqual(
    parseFirmsAreaUrl(
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/world/1?MAP_KEY=secret',
    ),
    { source: 'VIIRS_SNPP_NRT', area: 'world', dayRange: 1 },
  );
  assert.deepEqual(
    parseFirmsAreaUrl(
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/abcdef0123456789abcdef0123456789/MODIS_NRT/-123,36,-119,40/2',
    ),
    { source: 'MODIS_NRT', area: '-123,36,-119,40', dayRange: 2 },
  );
  assert.equal(parseFirmsAreaUrl('https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/'), undefined);
  const req = firmsRequest('VIIRS_NOAA21_NRT', 'world', 1);
  assert.equal(req.cacheKey, `GET ${req.url}`);
});

test('a plain-text key rejection is AUTH (not MALFORMED) and the cached body is invalidated', async () => {
  let invalidated = 0;
  const { ctx, provider } = setup({
    credentials: ['firms.mapKey'],
    settings: { sources: ['VIIRS_SNPP_NRT'] },
    responder: () => ({ status: 200, body: body('malformed-invalid-key.txt') }),
  });
  const inner = ctx.http;
  const http = {
    request: async (req: Parameters<typeof inner.request>[0]) => {
      const res = await inner.request(req);
      return {
        ...res,
        invalidate: () => {
          invalidated++;
        },
      };
    },
  };
  await provider.initialize({ ...ctx, http });
  await provider.start();
  await assert.rejects(
    provider.query({ signal: signal(), background: true }),
    (err: unknown) => err instanceof ProviderError && err.code === 'AUTH' && /rejected the MAP_KEY/.test(err.message),
  );
  assert.equal(invalidated, 1);
  assert.equal((await provider.health()).status, 'AUTH_REQUIRED');
});

test('settings: unknown sources are dropped, day range is clamped to 1-10', () => {
  assert.deepEqual(parseSettings({ sources: ['MODIS_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT', 'LANDSAT'], dayRange: 42 }), {
    sources: ['MODIS_NRT', 'VIIRS_SNPP_NRT'],
    dayRange: 10,
  });
  assert.deepEqual(parseSettings({ sources: [], dayRange: 0 }), { dayRange: 1 });
  assert.deepEqual(parseSettings({ dayRange: 'two' }), {});
});
