import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REQUEST_CHANNELS, type RequestChannel, type RequestOf } from '@worldview/ipc-contract';
import { settle, startRuntime } from '../helpers/harness.js';

/**
 * (v) The runtime *is* the implementation of the request catalogue: every channel the
 * shell can call has a handler here, and each one answers a benign request without
 * throwing. No placeholder may claim a channel it does not implement.
 */

/** A benign, valid request per channel — what the shell sends on a cold start. */
const BENIGN: { [C in RequestChannel]: RequestOf<C> } = {
  'app.info': undefined,
  'app.openExternal': { url: 'https://earthquake.usgs.gov/' },
  'settings.get': undefined,
  'settings.set': { reducedMotion: true },
  'map.providers.list': undefined,
  'events.types.list': undefined,
  'world.query': { objectTypes: ['earthquake'], limit: 10 },
  'world.get': { objectId: 'earthquake:usgs:nope' },
  'world.track': { objectId: 'earthquake:usgs:nope' },
  'world.details': { objectId: 'earthquake:usgs:nope' },
  'world.flight': { objectId: 'earthquake:usgs:nope' },
  'world.events': { eventTypes: ['earthquake'] },
  'world.event': { eventId: 'event:worldview:nope' },
  'world.subscribe': { objectTypes: ['earthquake', 'aircraft'] },
  'world.subscribe.more': { token: 'no-such-snapshot' },
  'world.related': { objectId: 'earthquake:usgs:nope' },
  'world.whatChanged': {
    region: { kind: 'bounds', bounds: { west: -180, south: -90, east: 180, north: 90 } },
    time: { start: '2026-09-21T00:00:00.000Z', end: '2026-09-21T12:00:00.000Z' },
  },
  'world.viewport': { bounds: { west: -160, south: 18, east: -154, north: 23 }, zoom: 7 },
  'sources.list': undefined,
  'overlays.list': undefined,
  'sources.manifest': { providerId: 'usgs-earthquakes' },
  'sources.setEnabled': { providerId: 'usgs-earthquakes', enabled: true },
  'sources.refresh': { providerId: 'usgs-earthquakes' },
  'sources.connection': undefined,
  'sources.settings.get': { providerId: 'usgs-earthquakes' },
  'sources.settings.set': { providerId: 'usgs-earthquakes', settings: { feed: 'day' } },
  'sources.definitions.list': undefined,
  'sources.definitions.reload': undefined,
  'sources.definitions.setEnabled': { file: 'nope.json', enabled: true },
  'sources.definitions.openFolder': undefined,
  'sources.definitions.draft': { url: 'https://example.org/data.json' },
  'sources.definitions.save': { id: 'nope', definition: {} },
  'credentials.has': { key: 'firms.mapKey' },
  'credentials.set': { key: 'demo.test.key', value: 'value' },
  'credentials.delete': { key: 'demo.test.key' },
  'history.query': { objectTypes: ['earthquake'], limit: 10 },
  'history.availability': { objectTypes: ['earthquake'] },
  'history.usage': undefined,
  'history.readings': {
    objectId: 'earthquake:usgs:none',
    keys: ['magnitude'],
    time: { start: '2026-09-21T00:00:00.000Z', end: '2026-09-21T01:00:00.000Z' },
  },
  'diagnostics.renderer': { active: '3D', webgl2: true, gpu: 'Test GPU', fps: 60 },
  'timeline.get': undefined,
  'timeline.set': { speed: 1 },
  'search.query': { text: 'Honolulu' },
  'search.places': { text: 'Honolulu' },
  'lenses.list': undefined,
  'lenses.save': {
    id: 'user-test',
    name: 'Test lens',
    objectTypes: ['earthquake'],
    eventTypes: [],
    renderingRules: [],
    visiblePanels: ['selection'],
  },
  'lenses.delete': { id: 'user-test' },
  'collections.list': undefined,
  'collections.save': {
    id: 'c1',
    name: 'Test',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    items: [],
  },
  'collections.delete': { id: 'already-gone' },
  'collections.export': { id: 'c1' },
  'collections.import': undefined,
  'watchzones.list': undefined,
  'watchzones.save': {
    id: 'z1',
    name: 'Oahu',
    geometry: { kind: 'circle', center: { latitude: 21.3, longitude: -157.8 }, radiusM: 50_000 },
    eventTypes: ['earthquake'],
    notifications: { inApp: true, desktop: false },
    enabled: true,
    createdAt: '2026-09-21T00:00:00.000Z',
  },
  'watchzones.delete': { id: 'z1' },
  'feed.recent': { limit: 20 },
  'offline.status': undefined,
  'offline.installPack': undefined,
  'offline.removePack': { id: 'not-installed' },
  'offline.setPackEnabled': { id: 'not-installed', enabled: true },
  'offline.trustPublisher': { packId: 'not-installed', name: 'Nobody' },
  'offline.importPublisher': undefined,
  'offline.removePublisher': { keyId: '0123456789abcdef' },
  'offline.setRequireTrusted': { required: false },
  'export.objects': { query: { objectTypes: ['earthquake'] }, format: 'geojson' },
  'camera.register': { name: 'Test', url: 'https://cam.example/still.jpg' },
  'camera.snapshot': { cameraId: 'public:fintraffic:NOPE' },
  'camera.stream': { cameraId: 'public:fintraffic:NOPE' },
  'camera.unregister': { cameraId: '0123456789ab' },
  'camera.list': undefined,
  'diagnostics.get': undefined,
  'diagnostics.export': undefined,
  'updater.state': undefined,
  'updater.check': undefined,
  'updater.install': undefined,
  'tiles.status': undefined,
  'tiles.clear': undefined,
  'tiles.prefetch': { sourceId: 'esri-world-imagery', bounds: { west: -1, south: -1, east: 1, north: 1 }, zoom: 3 },
};

/** Channels whose benign request legitimately reports a missing thing rather than succeeding. */
const MAY_REPORT_MISSING = new Set<RequestChannel>([
  'world.subscribe.more',
  'camera.snapshot',
  'camera.stream',
  'camera.unregister',
  'camera.register',
  'offline.removePack',
  'offline.setPackEnabled',
  'offline.trustPublisher',
  // Demo mode has no definition folder: these report that, and fetch or write nothing.
  'sources.definitions.setEnabled',
  'sources.definitions.draft',
  'sources.definitions.save',
]);

test('the handler table covers REQUEST_CHANNELS exactly', async () => {
  const h = await startRuntime({ demo: true });
  try {
    const implemented = Object.keys(h.runtime.handlers).sort();
    assert.deepEqual(
      implemented,
      [...REQUEST_CHANNELS].sort(),
      'handlers must cover the catalogue exactly — no gaps, no extras',
    );
    for (const channel of REQUEST_CHANNELS) {
      assert.equal(typeof h.runtime.handlers[channel], 'function', `${channel} has no handler`);
    }
    assert.deepEqual(Object.keys(BENIGN).sort(), [...REQUEST_CHANNELS].sort(), 'this test must exercise every channel');
  } finally {
    await h.dispose();
  }
});

test('every channel answers a benign request in demo mode without throwing', async () => {
  const h = await startRuntime({ demo: true });
  try {
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();

    const failures: Array<{ channel: string; error: string }> = [];
    for (const channel of REQUEST_CHANNELS) {
      try {
        await h.client.request(channel, BENIGN[channel] as never);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A "not registered" answer for a camera that does not exist is a correct answer,
        // not an unimplemented channel; everything else is a real failure.
        if (MAY_REPORT_MISSING.has(channel)) continue;
        failures.push({ channel, error: message });
      }
    }
    assert.deepEqual(failures, [], 'channels that threw on a benign request');

    // The dialog-backed channels degrade honestly through the in-process HostBridge.
    const exported = await h.client.request('export.objects', {
      query: { objectTypes: ['earthquake'] },
      format: 'geojson',
    });
    assert.deepEqual(exported, { cancelled: true }, 'no file dialog available → cancelled, never a silent write');
    assert.deepEqual(await h.client.request('collections.import', undefined), {
      imported: null,
      issues: ['cancelled'],
    });
    assert.deepEqual(await h.client.request('offline.installPack', undefined), {
      installed: null,
      issues: ['cancelled'],
    });
    assert.deepEqual(await h.client.request('diagnostics.export', undefined), { cancelled: true });

    // app.openExternal is an allowlist derived from the registered manifests, not a pass-through.
    await assert.rejects(
      h.client.request('app.openExternal', { url: 'https://evil.example/phish' }),
      /not an allowed external host/,
    );
    await assert.rejects(h.client.request('app.openExternal', { url: 'file:///etc/passwd' }), /only https links/);
    await assert.rejects(
      h.client.request('app.openExternal', { url: 'https://user:pw@earthquake.usgs.gov/' }),
      /must not carry credentials/,
    );

    // history.readings: an object with nothing stored has no readings; keys are bounded.
    const time = { start: '2026-09-21T00:00:00.000Z', end: '2026-09-21T01:00:00.000Z' };
    assert.deepEqual(await h.client.request('history.readings', { objectId: 'sensor:none:x', keys: ['aqiUs'], time }), {
      readings: [],
      truncated: false,
    });
    await assert.rejects(h.client.request('history.readings', { objectId: 'sensor:none:x', keys: [], time }), /keys/);
    await assert.rejects(
      h.client.request('history.readings', {
        objectId: 'sensor:none:x',
        keys: Array.from({ length: 33 }, (_, i) => `k${i}`),
        time,
      }),
      /keys/,
    );
    await assert.rejects(
      h.client.request('history.readings', {
        objectId: 'sensor:none:x',
        keys: ['a'],
        time: { start: time.end, end: time.start },
      }),
      /time range/,
    );

    // Demo mode says so, everywhere.
    assert.equal((await h.client.request('app.info', undefined)).demoMode, true);
    assert.equal((await h.client.request('diagnostics.get', undefined)).app.demoMode, true);
  } finally {
    await h.dispose();
  }
});

test('demo mode serves recorded data only', async () => {
  const networkCalls = { count: 0 };
  const h = await startRuntime({
    demo: true,
    fetchImpl: (async () => {
      networkCalls.count++;
      throw new Error('demo mode must not touch the network');
    }) as typeof fetch,
  });
  try {
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await h.client.request('sources.refresh', { providerId: 'readsb-local' });
    await settle();

    const objects = await h.client.request('world.query', {});
    assert.ok(objects.items.length >= 8, 'the demo world has the fixture earthquakes and the synthetic aircraft');
    assert.ok(
      objects.items.every((o) => o.provenance.origin === 'recorded'),
      'every demo object is labelled RECORDED',
    );
    assert.equal(objects.items.filter((o) => o.type === 'aircraft').length, 4);
    assert.equal(objects.items.filter((o) => o.type === 'earthquake').length, 8);
    assert.equal(networkCalls.count, 0, 'demo mode made no network calls');

    // The synthetic mover is a pure function of the clock: the same time gives the same position.
    const first = objects.items.find((o) => o.type === 'aircraft')!;
    await h.client.request('sources.refresh', { providerId: 'readsb-local' });
    await settle();
    const again = (await h.client.request('world.get', { objectId: first.id }))!;
    assert.deepEqual(again.position, first.position, 'deterministic at a fixed clock');
  } finally {
    await h.dispose();
  }
});

test('a failed history read is reported in Diagnostics, not shown as "no track"', async () => {
  const h = await startRuntime({});
  try {
    // A live object with a track, and a history store whose read fails.
    const failing = new Error('parquet partition unreadable');
    h.runtime.core.history.track = async () => {
      throw failing;
    };

    const clean = await h.client.request('diagnostics.get', undefined);
    assert.ok(!/last read failed/.test(clean.database.message ?? ''), 'nothing is reported before a failure');

    const points = await h.client.request('world.track', { objectId: 'aircraft:icao24:abc123' });
    assert.ok(Array.isArray(points), 'the live tail is still returned rather than the request failing');

    const after = await h.client.request('diagnostics.get', undefined);
    assert.match(after.database.message ?? '', /last read failed/, 'the failure is visible');
    assert.match(after.database.message ?? '', /parquet partition unreadable/, 'with the reason');
    assert.notEqual(after.database.status, 'ok', 'and the database is no longer reported as healthy');

    // A subsequent success clears it: the report is about the current state, not history.
    h.runtime.core.history.track = async () => [];
    await h.client.request('world.track', { objectId: 'aircraft:icao24:abc123' });
    const recovered = await h.client.request('diagnostics.get', undefined);
    assert.ok(!/last read failed/.test(recovered.database.message ?? ''));
  } finally {
    await h.dispose();
  }
});

test('offline, the basemap list keeps a source whose tiles are cached on disk, and asks only when offline', async () => {
  let asked = 0;
  const cachedTileSources = async () => {
    asked++;
    return ['esri-world-imagery'];
  };
  const offline = await startRuntime({ network: { isOnline: () => false }, cachedTileSources });
  try {
    offline.runtime.setNetworkOnline(false);
    await settle();
    const list = await offline.client.request('map.providers.list', undefined);
    const esri = list.basemaps.find((b) => b.id === 'esri-world-imagery');
    assert.equal(esri?.available, true, 'cached tiles keep it selectable offline');
    assert.match(esri?.availableNote ?? '', /cached/);
    assert.equal(list.basemaps.find((b) => b.id === 'osm-raster')?.available, false, 'OSM is never cached');
    assert.equal(asked, 1);
  } finally {
    await offline.dispose();
  }

  const nothingCached = await startRuntime({ network: { isOnline: () => false } });
  try {
    nothingCached.runtime.setNetworkOnline(false);
    await settle();
    const list = await nothingCached.client.request('map.providers.list', undefined);
    assert.equal(list.basemaps.find((b) => b.id === 'esri-world-imagery')?.available, false);
  } finally {
    await nothingCached.dispose();
  }

  asked = 0;
  const online = await startRuntime({ network: { isOnline: () => true }, cachedTileSources });
  try {
    await online.client.request('map.providers.list', undefined);
    assert.equal(asked, 0, 'online, the cache scan is not waited on');
  } finally {
    await online.dispose();
  }
});

test('a successful poll reaches the shell without a status transition, so "updated" does not go stale', async () => {
  const h = await startRuntime({ demo: true, sourcesUpdateThrottleMs: 5 });
  try {
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    let events = 0;
    h.runtime.on('sources.changed', () => events++);
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    const usgs = (await h.client.request('sources.list', undefined)).find((s) => s.providerId === 'usgs-earthquakes');
    assert.equal(usgs?.health.status, 'LIVE', 'no transition: LIVE before and after');
    assert.equal(events, 1, 'one sources.changed for the poll, throttled');
  } finally {
    await h.dispose();
  }
});

test('Diagnostics reports the renderer the page says it uses, and "unknown" before it has said', async () => {
  const h = await startRuntime({ demo: true });
  try {
    assert.deepEqual((await h.client.request('diagnostics.get', undefined)).renderer, { active: 'unknown' });
    await h.client.request('diagnostics.renderer', { active: '3D', webgl2: true, gpu: 'Test GPU', fps: 179 });
    assert.deepEqual((await h.client.request('diagnostics.get', undefined)).renderer, {
      active: '3D',
      webgl2: true,
      gpu: 'Test GPU',
      fps: 179,
    });
  } finally {
    await h.dispose();
  }
});

test('world.related: "nearby" is measured with altitude, so satellites overhead are not near an earthquake', async () => {
  const h = await startRuntime({ demo: true });
  try {
    const at = new Date(h.runtime.core.clock.now()).toISOString();
    const obs = (providerId: string, objectType: string, externalId: string, lon: number, altitudeM?: number) => ({
      id: `${providerId}:${externalId}:${at}`,
      providerId,
      objectType,
      externalId,
      observedAt: at,
      receivedAt: at,
      position: { latitude: -40, longitude: lon, ...(altitudeM !== undefined ? { altitudeM } : {}) },
      payload: {},
      quality: { complete: true, sourceQuality: 'authoritative' as const },
      provenance: { providerId, sourceName: providerId, origin: 'live' as const, receivedAt: at },
    });
    const state = h.runtime.core.state;
    state.ingest([obs('usgs-earthquakes', 'earthquake', 'q1', -20)], {
      snapshot: false,
      providerId: 'usgs-earthquakes',
    });
    state.ingest([obs('celestrak', 'satellite', '99999', -20.1, 550_000)], {
      snapshot: false,
      providerId: 'celestrak',
    });
    state.ingest([obs('adsb-lol', 'aircraft', 'abc123', -19.5, 10_000)], { snapshot: false, providerId: 'adsb-lol' });
    state.flush();
    const quake = [...state.ids()].find((id) => id.startsWith('earthquake:'))!;
    const related = await h.client.request('world.related', { objectId: quake });
    const types = related.objects.map((o) => o.type).sort();
    assert.deepEqual(types, ['aircraft'], 'the aircraft 42 km away at 10 km is near; the satellite 550 km up is not');
  } finally {
    await h.dispose();
  }
});

test('search finds the states and provinces the map names (the bundled label file)', async () => {
  const labels = new URL('../../../../apps/desktop/assets/reference/labels.json', import.meta.url);
  const h = await startRuntime({ demo: true, referenceLabelsPath: fileURLToPath(labels) });
  try {
    for (let i = 0; i < 50 && !h.runtime.core.referencePlaces.ready; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(h.runtime.core.referencePlaces.ready, 'loaded');
    for (const [text, name] of [
      ['North Carolina', 'North Carolina'],
      ['Bavaria', 'Bavaria'],
      ['fly to Ontario', 'Ontario'],
    ] as const) {
      const results = await h.client.request('search.query', { text });
      const top = results.find((r) => r.kind === 'place');
      assert.equal(top?.title, name, text);
    }
  } finally {
    await h.dispose();
  }
});

test('search finds cities offline (the bundled populated places), and typed queries keep their meaning', async () => {
  const labels = new URL('../../../../apps/desktop/assets/reference/labels.json', import.meta.url);
  const places = new URL('../../../../apps/desktop/assets/reference/places.json', import.meta.url);
  const h = await startRuntime({
    demo: true,
    referenceLabelsPath: fileURLToPath(labels),
    referencePlacesPath: fileURLToPath(places),
  });
  try {
    for (let i = 0; i < 100 && !h.runtime.core.referencePlaces.ready; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(h.runtime.core.referencePlaces.ready, 'loaded');
    for (const [text, name, subtitle] of [
      ['Helsinki', 'Helsinki', 'City · Southern Finland · FI'],
      ['fly to Kansas City', 'Kansas City', 'City · Missouri · US'],
      ['Bombay', 'Mumbai', 'City · Maharashtra · IN'],
    ] as const) {
      const results = await h.client.request('search.query', { text });
      const top = results.find((r) => r.kind === 'place');
      assert.equal(top?.title, name, text);
      assert.equal(top?.subtitle, subtitle, text);
    }
    // Paris the region (Natural Earth's admin-1 Paris) keeps its place; the city is offered too.
    const paris = await h.client.request('search.query', { text: 'Paris' });
    assert.ok(
      paris.some((r) => r.kind === 'place' && r.subtitle === 'City · Île-de-France · FR'),
      'Paris, France',
    );
    // A country or a state is still the place a typed query means, not a town of that name.
    const japan = await h.client.request('search.query', { text: 'earthquakes in Japan' });
    const quakes = japan.find((r) => r.kind === 'query');
    assert.equal(quakes?.title, 'Earthquakes in Japan (0)');
    assert.equal(quakes?.query?.region?.kind, 'bounds', "Japan's bounds, not a town's circle");
    const georgia = await h.client.request('search.query', { text: 'Georgia' });
    assert.notEqual(georgia.find((r) => r.kind === 'place')?.kind, undefined);
    assert.notEqual(
      georgia.find((r) => r.kind === 'place')?.subtitle?.startsWith('City'),
      true,
      'a country or state first',
    );
  } finally {
    await h.dispose();
  }
});

test('an installed pack basemap: the offline vector basemaps get its address, versioned by the pack', async () => {
  const h = await startRuntime({ offlineBasemapUrl: 'worldview://app/__pack/basemap.pmtiles' });
  try {
    const none = await h.client.request('map.providers.list', undefined);
    const dark = none.basemaps.find((b) => b.id === 'worldview-dark')!;
    assert.equal(dark.available, false, 'no pack: not selectable');
    const empty = dark.descriptor;
    assert.equal(empty.kind === 'pmtiles' && empty.url, '');
    // A pack with a basemap installed (the registry is exercised in packages/offline).
    h.runtime.core.packs.pmtilesPaths = () => [path.join('packs', 'hawaii-2026-09', 'maps', 'basemap.pmtiles')];
    h.runtime.core.packs.pmtilesAttribution = () => 'Protomaps · © OpenStreetMap contributors (ODbL)';
    const list = await h.client.request('map.providers.list', undefined);
    const entry = list.basemaps.find((b) => b.id === 'worldview-dark')!;
    assert.equal(entry.available, true);
    assert.ok(entry.descriptor.kind === 'pmtiles');
    assert.equal(
      entry.descriptor.kind === 'pmtiles' && entry.descriptor.url,
      'worldview://app/__pack/basemap.pmtiles?pack=hawaii-2026-09',
    );
    assert.equal(entry.attribution, 'Protomaps · © OpenStreetMap contributors (ODbL)', "the pack's own credit");
    assert.equal(
      entry.descriptor.kind === 'pmtiles' && entry.descriptor.attribution,
      'Protomaps · © OpenStreetMap contributors (ODbL)',
    );
    assert.equal(h.runtime.core.offlineBasemapPath(), path.join('packs', 'hawaii-2026-09', 'maps', 'basemap.pmtiles'));
  } finally {
    await h.dispose();
  }
});

test('a Martin source that does not answer is listed as two unavailable basemaps, with why; none without a URL', async () => {
  const h = await startRuntime({ demo: true });
  try {
    const before = await h.client.request('map.providers.list', undefined);
    assert.equal(before.basemaps.filter((b) => b.id.startsWith('martin-')).length, 0);
    // A high loopback port nothing listens on (port 9 is one fetch refuses outright).
    await h.client.request('settings.set', {
      martin: { url: 'http://127.0.0.1:59999/basemap', trustedHost: '', attribution: '' },
    });
    const list = await h.client.request('map.providers.list', undefined);
    const martin = list.basemaps.filter((b) => b.id.startsWith('martin-'));
    assert.deepEqual(
      martin.map((b) => [b.id, b.available]),
      [
        ['martin-dark', false],
        ['martin-light', false],
      ],
    );
    assert.equal(
      martin[0]!.unavailableReason,
      'Martin: http://127.0.0.1:59999/basemap could not be read (nothing is listening there — is Martin running?)',
    );
  } finally {
    await h.dispose();
  }
});
