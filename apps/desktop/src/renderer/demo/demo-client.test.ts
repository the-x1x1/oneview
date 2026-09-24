import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldChangedEvent } from '@worldview/ipc-contract';
import { REQUEST_CHANNELS, isIpcError } from '@worldview/ipc-contract';
import { DemoClient } from './demo-client.js';
import { advance } from './world.js';

const T0 = Date.parse('2026-09-21T08:00:00.000Z');

function clientAt(): { client: DemoClient; setNow: (ms: number) => void } {
  let now = T0;
  const client = new DemoClient({ now: () => now });
  return {
    client,
    setNow: (ms) => {
      now = ms;
    },
  };
}

test('everything the demo serves is labelled recorded data', async () => {
  const { client } = clientAt();
  const info = await client.request('app.info', undefined);
  assert.equal(info.demoMode, true);
  const sub = await client.request('world.subscribe', {});
  assert.ok(sub.snapshot.length >= 20, `objects=${sub.snapshot.length}`);
  for (const o of sub.snapshot) {
    assert.equal(o.provenance.origin, 'recorded', o.id);
    assert.equal(o.properties['recorded'], true, o.id);
  }
  const feed = await client.request('feed.recent', { limit: 100 });
  assert.ok(feed.length >= 10);
  assert.ok(feed.every((f) => f.recorded === true));
  const events = await client.request('world.events', {});
  assert.equal(events.items.length, 8, 'one event per USGS fixture feature');
  assert.ok(events.items.every((e) => e.provenance.origin === 'recorded'));
  const types = new Set(sub.snapshot.map((o) => o.type));
  for (const t of ['earthquake', 'aircraft', 'vessel', 'satellite', 'fire-detection', 'weather-alert', 'camera'])
    assert.ok(types.has(t), t);
  const settings = await client.request('settings.get', undefined);
  assert.equal(settings.demoMode, true);
  assert.equal((await client.request('updater.state', undefined)).status, 'disabled');
});

test('earthquakes mirror the USGS normalizer property names and the fixture reference set', async () => {
  const { client } = clientAt();
  const q = await client.request('world.query', { objectTypes: ['earthquake'] });
  assert.equal(q.items.length, 8);
  const kokopo = q.items.find((o) => o.id === 'earthquake:usgs:us7000wv01');
  assert.ok(kokopo);
  assert.equal(kokopo.properties['magnitude'], 5.7);
  assert.equal(kokopo.properties['magType'], 'mww');
  assert.equal(kokopo.properties['depthKm'], 45.3);
  assert.equal(kokopo.properties['detailUrl'], 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000wv01');
  assert.equal(kokopo.position?.altitudeM, -45_300);
  assert.equal(kokopo.labels['place'], '98 km SSE of Kokopo, Papua New Guinea');
  assert.ok(['LIVE', 'RECENT'].includes(kokopo.freshness));
  const related = await client.request('world.related', { objectId: kokopo.id });
  assert.equal(related.events[0]?.id, 'event:earthquake:usgs:us7000wv01');
});

test('subscription filtering and deterministic movers via tick()', async () => {
  const { client, setNow } = clientAt();
  const sub = await client.request('world.subscribe', {
    objectTypes: ['aircraft'],
    bounds: { west: -170, east: -150, south: 15, north: 30 },
  });
  assert.ok(sub.snapshot.every((o) => o.type === 'aircraft'));
  assert.ok(sub.snapshot.length >= 4 && sub.snapshot.length < 12, `hawaii aircraft=${sub.snapshot.length}`);
  const changes: WorldChangedEvent[] = [];
  client.on('world.changed', (c) => changes.push(c));
  setNow(T0 + 1000);
  client.tick(T0 + 1000);
  assert.equal(changes.length, 1);
  assert.ok(
    changes[0]!.objects.every((o) => o.type === 'aircraft'),
    'delta honours the subscription types',
  );
  const before = sub.snapshot.find((o) => o.id === 'aircraft:icao24:a4f0e1')!;
  const after = changes[0]!.objects.find((o) => o.id === 'aircraft:icao24:a4f0e1')!;
  assert.ok(after.position!.longitude > before.position!.longitude, 'UAL1541 heads east');
  // Positions are a pure function of elapsed time: a second client at the same offsets agrees.
  const other = new DemoClient({ now: () => T0 });
  other.tick(T0 + 1000);
  const again = await other.request('world.get', { objectId: 'aircraft:icao24:a4f0e1' });
  assert.deepEqual(again?.position, after.position);
  const moved = advance(0, 0, 90, 1000, 1000);
  assert.ok(moved.longitude > 0 && Math.abs(moved.latitude) < 1e-9);
  const track = await client.request('world.track', { objectId: 'aircraft:icao24:a4f0e1' });
  assert.ok(track.length >= 1 && track.length <= 241);
  const ground = await client.request('world.get', { objectId: 'aircraft:icao24:ac82ec' });
  assert.equal(ground?.properties['onGround'], true);
});

test('timeline honesty: availability only for recorded earthquakes; historical cursor serves HISTORICAL earthquakes only', async () => {
  const { client } = clientAt();
  const tl = await client.request('timeline.get', undefined);
  assert.equal(tl.mode, 'LIVE');
  assert.deepEqual(
    tl.availability.map((a) => a.objectType),
    ['earthquake'],
  );
  const set = await client.request('timeline.set', {
    mode: 'HISTORICAL',
    cursor: new Date(T0 - 2 * 3600_000).toISOString(),
  });
  assert.equal(set.mode, 'HISTORICAL');
  const hist = await client.request('world.subscribe', {});
  assert.ok(hist.snapshot.length > 0 && hist.snapshot.length < 8);
  assert.ok(hist.snapshot.every((o) => o.type === 'earthquake' && o.freshness === 'HISTORICAL'));
  const future = await client.request('timeline.set', {
    mode: 'HISTORICAL',
    cursor: new Date(T0 + 3600_000).toISOString(),
  });
  assert.ok(Date.parse(future.cursor) <= T0, 'cursor never passes now');
  await client.request('timeline.set', { mode: 'LIVE' });
  assert.equal((await client.request('world.subscribe', {})).snapshot.length >= 20, true);
});

test('sources: mixed states, enable/disable, credentials unlock AUTH_REQUIRED, values never retained', async () => {
  const { client } = clientAt();
  const list = await client.request('sources.list', undefined);
  const states = new Map(list.map((e) => [e.providerId, e.health.status]));
  assert.equal(states.get('nasa-firms'), 'AUTH_REQUIRED');
  assert.equal(states.get('aisstream'), 'OFFLINE');
  assert.equal(states.get('opensky-network'), 'DISABLED');
  assert.equal(states.get('celestrak'), 'STALE');
  assert.equal((await client.request('sources.connection', undefined)).state, 'DEGRADED');
  const changes: string[] = [];
  client.on('sources.changed', ({ entries }) =>
    changes.push(entries.find((e) => e.providerId === 'nasa-firms')!.health.status),
  );
  assert.equal((await client.request('credentials.has', { key: 'firms.mapKey' })).present, false);
  await client.request('credentials.set', { key: 'firms.mapKey', value: 'secret-value' });
  assert.equal((await client.request('credentials.has', { key: 'firms.mapKey' })).present, true);
  assert.ok(
    !JSON.stringify(await client.request('diagnostics.get', undefined)).includes('secret-value'),
    'secret never appears in diagnostics',
  );
  await client.request('sources.refresh', { providerId: 'nasa-firms' });
  assert.equal(changes.at(-1), 'LIVE');
  await client.request('sources.setEnabled', { providerId: 'usgs-earthquakes', enabled: false });
  const q = await client.request('world.query', { objectTypes: ['earthquake'] });
  assert.equal(q.items.length, 0, 'disabled provider objects are not served');
  await client.request('sources.setEnabled', { providerId: 'usgs-earthquakes', enabled: true });
  assert.equal((await client.request('world.query', { objectTypes: ['earthquake'] })).items.length, 8);
});

test('search, collections, watch zones, camera snapshot, exports and every channel answers', async () => {
  const { client } = clientAt();
  const hon = await client.request('search.query', { text: 'hono' });
  assert.equal(hon[0]?.kind, 'place');
  assert.equal(hon[0]?.title, 'Honolulu');
  const ual = await client.request('search.query', { text: 'UAL' });
  assert.ok(ual.some((r) => r.kind === 'object' && r.id === 'aircraft:icao24:a4f0e1'));
  const kok = await client.request('search.query', { text: 'kokopo' });
  assert.ok(kok.some((r) => r.kind === 'event'));

  const cols = await client.request('collections.save', {
    id: 'c1',
    name: 'Test',
    createdAt: 'a',
    updatedAt: 'a',
    items: [],
  });
  assert.equal(cols.length, 1);
  assert.deepEqual(
    await client.request('collections.export', { id: 'c1' }),
    { cancelled: true },
    'no download hook → cancelled, never a fake path',
  );
  const zones = await client.request('watchzones.save', {
    id: 'z1',
    name: 'Z',
    geometry: { kind: 'circle', center: { latitude: 21, longitude: -157 }, radiusM: 50_000 },
    eventTypes: ['earthquake'],
    notifications: { inApp: true, desktop: false },
    enabled: true,
    createdAt: 'a',
  });
  assert.equal(zones.length, 1);
  assert.equal((await client.request('watchzones.delete', { id: 'z1' })).length, 0);

  const snap = await client.request('camera.snapshot', { cameraId: 'demo-hnl-h1-01' });
  assert.equal(snap.mimeType, 'image/svg+xml');
  assert.ok(new TextDecoder().decode(snap.bytes).includes('RECORDED DATA'));

  const changed = await client.request('world.whatChanged', {
    region: { kind: 'bounds', bounds: { west: -180, east: 180, south: -90, north: 90 } },
    time: { start: new Date(T0 - 48 * 3600_000).toISOString(), end: new Date(T0).toISOString() },
  });
  assert.equal(changed.newEvents.length, 8);

  let downloads = 0;
  const dl = new DemoClient({
    now: () => T0,
    download: () => {
      downloads++;
      return 'Downloads/x';
    },
  });
  const exp = await dl.request('export.objects', { query: { objectTypes: ['earthquake'] }, format: 'geojson' });
  assert.ok('path' in exp && exp.path === 'Downloads/x');
  assert.equal(downloads, 1);

  // Every allowlisted channel is implemented (no throw) with a representative request.
  const sample: Record<string, unknown> = {
    'app.openExternal': { url: 'https://example.org' },
    'settings.set': { textScale: 1.2 },
    'world.query': {},
    'world.get': { objectId: 'x' },
    'world.track': { objectId: 'x' },
    'world.events': {},
    'world.event': { eventId: 'x' },
    'world.subscribe': {},
    'world.related': { objectId: 'x' },
    'world.whatChanged': {
      region: { kind: 'bounds', bounds: { west: 0, east: 1, south: 0, north: 1 } },
      time: { start: 'a', end: 'b' },
    },
    'world.viewport': { bounds: { west: 0, east: 1, south: 0, north: 1 }, zoom: 2 },
    'sources.manifest': { providerId: 'x' },
    'sources.setEnabled': { providerId: 'x', enabled: true },
    'sources.refresh': { providerId: 'x' },
    'sources.settings.get': { providerId: 'x' },
    'sources.settings.set': { providerId: 'x', settings: {} },
    'sources.definitions.setEnabled': { file: 'x.json', enabled: true },
    'sources.definitions.draft': { url: 'https://example.org/x.json' },
    'sources.definitions.save': { id: 'x', definition: {} },
    'credentials.has': { key: 'k' },
    'credentials.set': { key: 'k', value: 'v' },
    'credentials.delete': { key: 'k' },
    'history.query': {},
    'history.availability': {},
    'timeline.set': {},
    'search.query': { text: 'a' },
    'lenses.save': {
      id: 'custom',
      name: 'Custom',
      objectTypes: [],
      eventTypes: [],
      renderingRules: [],
      visiblePanels: [],
    },
    'lenses.delete': { id: 'custom' },
    'collections.save': { id: 'c2', name: 'x', createdAt: 'a', updatedAt: 'a', items: [] },
    'collections.delete': { id: 'c2' },
    'collections.export': { id: 'c1' },
    'watchzones.save': {
      id: 'z',
      name: 'z',
      geometry: { kind: 'bounds', bounds: { west: 0, east: 1, south: 0, north: 1 } },
      eventTypes: [],
      notifications: { inApp: true, desktop: false },
      enabled: true,
      createdAt: 'a',
    },
    'watchzones.delete': { id: 'z' },
    'feed.recent': {},
    'offline.removePack': { id: 'p' },
    'offline.setPackEnabled': { id: 'p', enabled: true },
    'export.objects': { query: {}, format: 'csv' },
    'camera.register': { name: 'c', url: 'rtsp://x' },
    'camera.snapshot': { cameraId: 'c' },
    'camera.stream': { cameraId: 'c' },
    'camera.unregister': { cameraId: 'c' },
  };
  for (const channel of REQUEST_CHANNELS) {
    // A page of a snapshot nobody paged: implemented, and it says the snapshot is gone.
    if (channel === 'sources.definitions.draft' || channel === 'sources.definitions.save') {
      await assert.rejects(
        client.request(channel, (sample[channel] ?? undefined) as never),
        (e: unknown) => isIpcError(e) && e.code === 'UNAVAILABLE',
      );
      continue;
    }
    if (channel === 'world.subscribe.more') {
      await assert.rejects(
        client.request(channel, { token: 'none' }),
        (e: unknown) => isIpcError(e) && e.code === 'NOT_FOUND',
      );
      continue;
    }
    await client.request(channel, (sample[channel] ?? undefined) as never);
  }
});
