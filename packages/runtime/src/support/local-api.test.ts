import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderDataPolicy } from '@worldview/provider-sdk';
import type { SourceHealthEntry } from '@worldview/source-health';
import type { WorldObject } from '@worldview/world-model';
import { LOCAL_API_LIMITS, handleLocalApi, type LocalApiDeps } from './local-api.js';

// Every object, place and node here is invented.
const NOW = Date.parse('2026-10-08T20:00:00Z');
const iso = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

const policy = (exportAllowed: boolean, normalizedRetentionAllowed = true): ProviderDataPolicy =>
  ({
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed,
    redistributionAllowed: exportAllowed,
    offlinePackAllowed: false,
    exportAllowed,
    commercialUseAllowed: false,
    attributionRequired: false,
  }) as ProviderDataPolicy;

const POLICIES: Record<string, ProviderDataPolicy> = {
  'readsb-local': policy(true),
  'usgs-earthquakes': policy(true),
  'meshtastic-local': policy(false, false),
  'no-history': policy(true, false),
  'ais-closed': policy(false, true),
};

function obj(id: string, providerId: string, lat: number, lon: number, extra: Partial<WorldObject> = {}): WorldObject {
  return {
    id,
    type: id.split(':')[0]!,
    sourceRefs: [{ observationId: `${id}#1`, providerId, observedAt: iso(5000) as never }],
    position: { latitude: lat, longitude: lon },
    observedAt: iso(5000) as never,
    updatedAt: iso(5000) as never,
    freshness: 'LIVE',
    confidence: 0.9,
    labels: { name: id },
    properties: {},
    provenance: { providerId, sourceName: providerId, origin: 'local', receivedAt: iso(4000) as never },
    ...extra,
  } as WorldObject;
}

const OBJECTS: WorldObject[] = [
  obj('aircraft:icao24:a00001', 'readsb-local', 21.3, -157.9),
  obj('aircraft:icao24:a00002', 'readsb-local', 21.35, -157.85),
  obj('aircraft:icao24:a00003', 'readsb-local', 40, -100),
  obj('earthquake:usgs:hv1', 'usgs-earthquakes', 19.4, -155.3),
  // Mesh nodes: other people's precise positions. Never out.
  obj('sensor:meshtastic:!11111111', 'meshtastic-local', 21.31, -157.86, { properties: { thisNode: true } }),
  obj('sensor:meshtastic:!22222222', 'meshtastic-local', 21.32, -157.87),
  // Merged from an exportable and a non-exportable source: the stricter wins.
  obj('aircraft:icao24:a00004', 'readsb-local', 21.3, -157.9, {
    sourceRefs: [
      { observationId: 'x', providerId: 'readsb-local', observedAt: iso() as never },
      { observationId: 'y', providerId: 'meshtastic-local', observedAt: iso() as never },
    ],
  }),
  // A source with no known policy: fails closed.
  obj('place:unknown:1', 'mystery', 21.3, -157.9),
  obj('earthquake:nohist:1', 'no-history', 21.3, -157.9),
  // Its refs say only readsb-local; its labels came partly from ais-closed.
  obj('vessel:mmsi:1', 'readsb-local', 21.3, -157.9, { labels: { name: 'from the closed source' } }),
];

/**
 * Providers that fed an object beyond its capped refs: this vessel was also reported by a source
 * that forbids export, whose ref has since been pushed out by newer reports from an open one.
 */
const CONTRIBUTORS: Record<string, string[]> = {
  'vessel:mmsi:1': ['ais-closed', 'readsb-local'],
};
/** Providers with points in an object's stored history. */
const HISTORY_PROVIDERS: Record<string, string[]> = {
  'aircraft:icao24:a00002': ['readsb-local', 'ais-closed'],
};

function source(providerId: string, extra: Partial<SourceHealthEntry['health']> = {}): SourceHealthEntry {
  return {
    providerId,
    name: providerId,
    categories: [],
    locality: 'local',
    enabled: true,
    health: {
      providerId,
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
      ...extra,
    },
    transitions: [],
    meta: {},
  } as unknown as SourceHealthEntry;
}

function deps(over: Partial<LocalApiDeps> = {}): LocalApiDeps {
  return {
    now: () => NOW,
    app: { version: '0.2.2', channel: 'dev', commit: 'abc1234' },
    recorded: () => false,
    ownPositionAllowed: () => false,
    workOffline: () => true,
    connection: () =>
      ({ state: 'OFFLINE', networkOnline: false, remoteLive: 0, remoteTotal: 3, localLive: 2, at: iso() }) as never,
    sources: () => [
      source('readsb-local', { objectCount: 3 }),
      source('meshtastic-local', {
        ownPosition: { state: 'fix', fixAt: iso(10_000) as never, satellites: 8, fixType: '3D', node: 'Deck' },
      }),
    ],
    policy: (id) => POLICIES[id],
    objects: () => OBJECTS,
    objectsNear: () => OBJECTS,
    object: (id) => OBJECTS.find((o) => o.id === id),
    contributors: (id) => CONTRIBUTORS[id] ?? [],
    trackProviders: async (id) => HISTORY_PROVIDERS[id] ?? [],
    track: async () => [
      { observedAt: iso(60_000), latitude: 21.3, longitude: -157.9 },
      { observedAt: iso(0), latitude: 21.31, longitude: -157.91, altitudeM: 900 },
    ],
    offline: () =>
      ({
        connection: { state: 'OFFLINE' },
        packs: [{ id: 'oahu', name: "O'ahu", status: 'active', extra: 'x' }],
        capabilities: { localMap: true, localSearch: true, history: true, collections: true, localAircraft: true },
        vaults: [
          {
            id: 'v',
            label: 'Field SSD',
            path: '/media/op/FIELD',
            state: 'ready',
            message: 'ok',
            freeBytes: 5,
            checkedAt: iso(),
          },
        ],
      }) as never,
    ...over,
  };
}

const get = (url: string, d = deps()) => handleLocalApi({ method: 'GET', url }, d);
const body = <T>(r: { body: unknown }) => r.body as T;

test('local API: read only — anything but GET, or any body, is refused', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
    assert.equal((await handleLocalApi({ method, url: '/v1' }, deps())).status, 405, method);
  assert.equal((await handleLocalApi({ method: 'GET', url: '/v1', contentLength: 10 }, deps())).status, 413);
  assert.equal((await handleLocalApi({ method: 'GET', url: '/v1', chunked: true }, deps())).status, 413);
  assert.equal((await get(`/v1/objects?type=${'a'.repeat(3000)}`)).status, 413);
  assert.equal((await get('/v1/settings')).status, 404, 'nothing outside the list');
  assert.equal((await get('/v1/../etc/passwd')).status, 404);
  assert.equal((await get('/')).status, 404);
});

test('local API: index and health say what is there', async () => {
  const idx = await get('/v1');
  assert.equal(idx.status, 200);
  assert.deepEqual(body<{ endpoints: string[] }>(idx).endpoints, [
    '/v1',
    '/v1/health',
    '/v1/sources',
    '/v1/objects',
    '/v1/track',
    '/v1/offline',
    '/v1/own-position',
  ]);
  assert.equal(body<{ ownPosition: boolean }>(idx).ownPosition, false);
  assert.deepEqual(body(await get('/v1/health')), {
    at: iso(),
    recorded: false,
    connection: { state: 'OFFLINE', workOffline: true, networkOnline: false },
    sources: { live: 2, total: 2 },
  });
  const sources = body<{ sources: Array<{ providerId: string; readable: boolean; objectCount?: number }> }>(
    await get('/v1/sources'),
  );
  assert.equal(sources.sources.find((s) => s.providerId === 'readsb-local')?.objectCount, 3);
  const mesh = sources.sources.find((s) => s.providerId === 'meshtastic-local') as Record<string, unknown>;
  assert.equal(mesh['objectCount'], undefined, "a closed source's size is its members' data");
  assert.equal(mesh['lastObservation'], undefined);
  assert.deepEqual(
    sources.sources.map((s) => [s.providerId, s.readable]),
    [
      ['readsb-local', true],
      ['meshtastic-local', false],
    ],
  );
  assert.equal((await get('/v1/health?x=1')).status, 400, 'no unknown parameters');
});

test('local API: objects near a point — bounded, paged, and only what the data policies let out', async () => {
  type Page = {
    objects: Array<{ id: string; sources: string[]; provenance: { providerId: string } }>;
    next?: string;
  };
  const near = body<Page>(await get('/v1/objects?lat=21.3&lon=-157.9&radiusKm=20'));
  assert.deepEqual(
    near.objects.map((o) => o.id),
    ['aircraft:icao24:a00001', 'aircraft:icao24:a00002', 'earthquake:nohist:1'],
  );
  // Both mesh nodes, the aircraft merged with a mesh source, the source with no known policy, and
  // the vessel a closed source once fed: left out without a trace — not even a count.
  assert.ok(!JSON.stringify(near).includes('meshtastic'), 'no word of the mesh in the answer');
  assert.ok(!JSON.stringify(near).includes('closed source'));
  assert.equal((near as unknown as Record<string, unknown>)['withheld'], undefined);

  const all = body<Page>(await get('/v1/objects'));
  assert.deepEqual(all.objects.map((o) => o.provenance.providerId).sort(), [
    'no-history',
    'readsb-local',
    'readsb-local',
    'readsb-local',
    'usgs-earthquakes',
  ]);
  assert.equal(body<Page>(await get('/v1/objects?type=earthquake')).objects.length, 2);

  // Pages of two, by id, until the end.
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = body<Page>(await get(`/v1/objects?limit=2${cursor ? `&cursor=${cursor}` : ''}`));
    seen.push(...page.objects.map((o) => o.id));
    cursor = page.next;
    if (!cursor) break;
  }
  assert.deepEqual(seen, [...all.objects.map((o) => o.id)].sort());

  for (const bad of [
    '/v1/objects?lat=21.3',
    '/v1/objects?radiusKm=5',
    '/v1/objects?lat=91&lon=0',
    `/v1/objects?lat=0&lon=0&radiusKm=${LOCAL_API_LIMITS.maxRadiusKm + 1}`,
    `/v1/objects?limit=${LOCAL_API_LIMITS.maxObjects + 1}`,
    '/v1/objects?limit=2.5',
    '/v1/objects?type=Aircraft;DROP',
    '/v1/objects?since=yesterday',
    '/v1/objects?cursor=../../x',
    '/v1/objects?lat=1&lat=2&lon=3',
    '/v1/objects?providerId=meshtastic-local',
  ])
    assert.equal((await get(bad)).status, 400, bad);
});

test('local API: a track only where the sources allow keeping and letting it out', async () => {
  const ok = await get('/v1/track?id=aircraft:icao24:a00001');
  assert.equal(ok.status, 200);
  assert.deepEqual(body<{ points: unknown[] }>(ok).points, [
    { at: iso(60_000), latitude: 21.3, longitude: -157.9 },
    { at: iso(0), latitude: 21.31, longitude: -157.91, altitudeM: 900 },
  ]);
  assert.equal((await get('/v1/track?id=sensor:meshtastic:!22222222')).status, 403, 'a mesh node');
  assert.equal((await get('/v1/track?id=aircraft:icao24:a00004')).status, 403, 'merged with a mesh source');
  assert.equal((await get('/v1/track?id=earthquake:nohist:1')).status, 403, 'a source that keeps no history');
  assert.equal(
    (await get('/v1/track?id=aircraft:icao24:a00002')).status,
    403,
    'a closed source in the stored history, though not behind the object now',
  );
  assert.equal((await get('/v1/track?id=vessel:mmsi:1')).status, 403, 'a closed source that fed it, past its refs');
  assert.equal((await get('/v1/track?id=aircraft:icao24:ffffff')).status, 404);
  assert.equal((await get('/v1/track')).status, 400);
  assert.equal(
    (await get('/v1/track?id=aircraft:icao24:a00001&from=2026-10-06T00:00:00Z&to=2026-10-08T00:00:00Z')).status,
    400,
    'more than 24 hours',
  );
});

test("local API: this computer's position only with its own permission, and no coordinates without a fix", async () => {
  const refused = await get('/v1/own-position');
  assert.equal(refused.status, 403);
  const allowed = deps({ ownPositionAllowed: () => true });
  assert.deepEqual(body(await get('/v1/own-position', allowed)), {
    at: iso(),
    state: 'fix',
    position: { latitude: 21.31, longitude: -157.86 },
    fixAt: iso(10_000),
    satellites: 8,
    fixType: '3D',
    source: { providerId: 'meshtastic-local', node: 'Deck' },
  });
  // An old fix is said to be stale, however the health put it.
  const old = deps({
    ownPositionAllowed: () => true,
    sources: () => [source('meshtastic-local', { ownPosition: { state: 'fix', fixAt: iso(20 * 60_000) as never } })],
  });
  assert.equal(body<{ state: string }>(await get('/v1/own-position', old)).state, 'stale');
  const noFix = deps({
    ownPositionAllowed: () => true,
    sources: () => [source('meshtastic-local', { ownPosition: { state: 'no-fix', node: 'Deck' } })],
  });
  const nf = body<{ state: string; position?: unknown }>(await get('/v1/own-position', noFix));
  assert.equal(nf.state, 'no-fix');
  assert.equal(nf.position, undefined, 'NO FIX: no coordinates, even though the old node object is there');
  const none = deps({ ownPositionAllowed: () => true, sources: () => [source('readsb-local')] });
  assert.equal(body<{ state: string }>(await get('/v1/own-position', none)).state, 'no-source');
});

test('local API: offline status gives vault labels and states, not where drives are mounted', async () => {
  const off = body<Record<string, unknown>>(await get('/v1/offline'));
  assert.deepEqual(off['vaults'], [{ label: 'Field SSD', state: 'ready', freeBytes: 5 }]);
  assert.deepEqual(off['packs'], [{ id: 'oahu', name: "O'ahu", status: 'active' }]);
  assert.ok(!JSON.stringify(off).includes('/media/'));
});

/**
 * Contract fixtures for a consumer (fixtures/local-api/v1): each endpoint's answer to the
 * invented world above. They must match what the router answers today; regenerate with
 * WORLDVIEW_UPDATE_FIXTURES=1 when the API changes on purpose (and say so in ADR-014).
 */
test('local API: the contract fixtures are what the router answers', async () => {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/local-api/v1');
  const allowed = deps({ ownPositionAllowed: () => true });
  const cases: Array<[string, string, LocalApiDeps]> = [
    ['index.json', '/v1', allowed],
    ['health.json', '/v1/health', allowed],
    ['sources.json', '/v1/sources', allowed],
    ['objects-near.json', '/v1/objects?lat=21.3&lon=-157.9&radiusKm=20&limit=2', allowed],
    ['track.json', '/v1/track?id=aircraft:icao24:a00001', allowed],
    ['offline.json', '/v1/offline', allowed],
    ['own-position.json', '/v1/own-position', allowed],
    ['own-position-refused.json', '/v1/own-position', deps()],
    ['error-restricted-track.json', '/v1/track?id=sensor:meshtastic:!22222222', allowed],
    ['error-bad-request.json', '/v1/objects?lat=91&lon=0', allowed],
  ];
  if (process.env['WORLDVIEW_UPDATE_FIXTURES'] === '1') await fs.mkdir(dir, { recursive: true });
  for (const [file, url, d] of cases) {
    const r = await get(url, d);
    const actual = { request: `GET ${url}`, status: r.status, body: r.body };
    if (process.env['WORLDVIEW_UPDATE_FIXTURES'] === '1')
      await fs.writeFile(path.join(dir, file), `${JSON.stringify(actual, null, 2)}\n`);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')),
      JSON.parse(JSON.stringify(actual)),
      file,
    );
  }
});
