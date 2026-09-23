import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvider as createUsgs } from '@worldview/provider-usgs';
import type { Collection, WatchZone, WorldEvents } from '@worldview/ipc-contract';
import type { ProviderContext, ProviderHealth, ProviderManifest, WorldProvider } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { readFixture, settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * The user-facing state the runtime owns: watch zones and their notifications, lenses,
 * collections (including import/export through the HostBridge), the export policy gate
 * and provider settings. All of it survives a restart because it lives on disk.
 */
test('integration: watch zones fire notifications for matching events and are persisted', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs()] });
  try {
    const notifications: Array<WorldEvents['notification']> = [];
    h.runtime.on('notification', (n) => notifications.push(n));

    // A zone over Honshu, where the fixture's largest earthquake is.
    const zone: WatchZone = {
      id: 'honshu',
      name: 'Honshu',
      geometry: { kind: 'circle', center: { latitude: 38.0, longitude: 142.0 }, radiusM: 600_000 },
      eventTypes: ['earthquake'],
      minimumSeverity: 'MINOR',
      notifications: { inApp: true, desktop: true },
      enabled: true,
      createdAt: '2026-09-21T00:00:00.000Z',
    };
    const zones = await h.client.request('watchzones.save', zone);
    assert.equal(zones.length, 1);
    assert.equal(zones[0]?.id, 'honshu');

    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();

    assert.ok(notifications.length >= 1, 'an earthquake inside the zone produced a notification');
    assert.equal(notifications[0]?.watchZoneId, 'honshu');
    assert.ok(notifications[0]?.title.length > 0);
    assert.ok(h.host.notifications.length >= 1, 'desktop notifications were requested through the host bridge');

    // The zone's entry event is a real event in the store and in the feed.
    const events = await h.client.request('world.events', { eventTypes: ['watch-zone-entry'] });
    assert.ok(events.items.length >= 1);
    assert.ok(
      events.items.every((e) => e.provenance.providerId === 'worldview'),
      'zone events are derived, not attributed to a source',
    );

    // Persistence: the document is on disk in the documented envelope.
    const raw = JSON.parse(await fs.readFile(path.join(h.dataDir, 'watchzones.json'), 'utf8')) as {
      version: number;
      items: WatchZone[];
    };
    assert.equal(raw.version, 1);
    assert.equal(raw.items[0]?.id, 'honshu');

    // Deleting it stops the evaluation.
    assert.deepEqual(await h.client.request('watchzones.delete', { id: 'honshu' }), []);

    // An invalid zone is refused rather than stored.
    await assert.rejects(
      h.client.request('watchzones.save', { id: 'bad' } as unknown as WatchZone),
      /invalid watch zone/,
    );
  } finally {
    await h.dispose();
  }
});

test('integration: a zone with its notifications off, or in quiet hours, raises events but does not interrupt', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs()] });
  try {
    const notifications: Array<WorldEvents['notification']> = [];
    h.runtime.on('notification', (n) => notifications.push(n));
    const base: WatchZone = {
      id: 'honshu-quiet',
      name: 'Honshu',
      geometry: { kind: 'circle', center: { latitude: 38.0, longitude: 142.0 }, radiusM: 600_000 },
      eventTypes: ['earthquake'],
      minimumSeverity: 'MINOR',
      notifications: { inApp: false, desktop: false },
      enabled: true,
      createdAt: '2026-09-21T00:00:00.000Z',
    };
    await h.client.request('watchzones.save', base);
    // A second zone with its switches on, but quiet all day: only SEVERE and above get through.
    const saved = await h.client.request('watchzones.save', {
      ...base,
      id: 'honshu-night',
      notifications: { inApp: true, desktop: true },
      quietHours: { start: '00:00', end: '23:59' },
    });
    assert.deepEqual(saved.find((z) => z.id === 'honshu-night')?.quietHours, { start: '00:00', end: '23:59' });
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();
    const events = await h.client.request('world.events', { eventTypes: ['watch-zone-entry'] });
    assert.ok(events.items.length >= 2, 'both zones still raised their events');
    const minuteNow = new Date().getHours() * 60 + new Date().getMinutes();
    if (minuteNow < 23 * 60 + 59)
      assert.ok(
        notifications.every((n) => n.severity === 'SEVERE' || n.severity === 'EXTREME'),
        `quiet hours let only severe events through: ${notifications.map((n) => n.severity).join(',')}`,
      );
    assert.ok(
      notifications.every((n) => n.watchZoneId !== 'honshu-quiet'),
      'in-app off: no toast for that zone',
    );
    assert.ok(h.host.notifications.length <= notifications.length, 'desktop only where in-app went through too');
  } finally {
    await h.dispose();
  }
});

test('integration: escalation — a zone can list everything in-app and reach the desktop only for the severe', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs()] });
  try {
    const notifications: Array<WorldEvents['notification']> = [];
    h.runtime.on('notification', (n) => notifications.push(n));
    const saved = await h.client.request('watchzones.save', {
      id: 'honshu-escalation',
      name: 'Honshu',
      geometry: { kind: 'circle', center: { latitude: 38.0, longitude: 142.0 }, radiusM: 600_000 },
      eventTypes: ['earthquake'],
      minimumSeverity: 'MINOR',
      desktopMinimumSeverity: 'EXTREME',
      notifications: { inApp: true, desktop: true },
      enabled: true,
      createdAt: '2026-09-21T00:00:00.000Z',
    });
    assert.equal(saved[0]?.desktopMinimumSeverity, 'EXTREME', 'kept through validation');
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();
    assert.ok(notifications.length >= 1, 'in-app: every hit');
    const extreme = notifications.filter((n) => n.severity === 'EXTREME').length;
    assert.equal(h.host.notifications.length, extreme, 'desktop: only the extreme ones');
  } finally {
    await h.dispose();
  }
});

test('integration: collections and lenses round-trip through the host bridge and survive a restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-runtime-restart-'));
  const h = await startRuntime({ dataDir, providerInstances: [] });
  try {
    const collection: Collection = {
      id: 'trip',
      name: 'Pacific trip',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      items: [
        {
          id: 'i1',
          kind: 'location',
          title: 'Honolulu',
          createdAt: '2026-09-21T00:00:00.000Z',
          updatedAt: '2026-09-21T00:00:00.000Z',
          position: { latitude: 21.3, longitude: -157.8 },
        },
      ],
    };
    await h.client.request('collections.save', collection);

    // Export writes exactly where the host bridge points.
    const target = path.join(dataDir, 'exported-collection.json');
    h.host.saveQueue.push(target);
    const exported = await h.client.request('collections.export', { id: 'trip' });
    assert.deepEqual(exported, { path: target });
    const written = JSON.parse(await fs.readFile(target, 'utf8')) as { version: number; collection: Collection };
    assert.equal(written.collection.items.length, 1);

    // Import validates the file instead of trusting it.
    await h.client.request('collections.delete', { id: 'trip' });
    h.host.openQueue.push(target);
    const imported = await h.client.request('collections.import', undefined);
    assert.equal(imported.imported?.id, 'trip');
    assert.deepEqual(imported.issues, []);

    const junk = path.join(dataDir, 'junk.json');
    await fs.writeFile(junk, '{"collection":{"id":"x"}}');
    h.host.openQueue.push(junk);
    const rejected = await h.client.request('collections.import', undefined);
    assert.equal(rejected.imported, null);
    assert.deepEqual(rejected.issues, ['file does not contain a valid collection']);

    // Lenses: built-ins are listed and protected; user lenses are stored.
    const builtIn = await h.client.request('lenses.list', undefined);
    assert.ok(builtIn.some((l) => l.id === 'overview' && l.builtIn));
    await assert.rejects(h.client.request('lenses.delete', { id: 'overview' }), /built-in lenses cannot be deleted/);
    const withUser = await h.client.request('lenses.save', {
      id: 'quakes-only',
      name: 'Quakes',
      objectTypes: ['earthquake'],
      eventTypes: ['earthquake'],
      renderingRules: [],
      visiblePanels: ['selection'],
    });
    assert.ok(withUser.some((l) => l.id === 'quakes-only'));

    // Provider settings are persisted for the provider that reads them.
    await h.client.request('sources.settings.set', {
      providerId: 'usgs-earthquakes',
      settings: { feed: 'hour', minMagnitude: 2.5 },
    });
    assert.deepEqual(await h.client.request('sources.settings.get', { providerId: 'usgs-earthquakes' }), {
      feed: 'hour',
      minMagnitude: 2.5,
    });

    await h.dispose();

    // --- restart against the same directory -------------------------------------
    const again = await startRuntime({ dataDir, providerInstances: [] });
    try {
      assert.equal((await again.client.request('collections.list', undefined)).length, 1);
      assert.ok((await again.client.request('lenses.list', undefined)).some((l) => l.id === 'quakes-only'));
      assert.deepEqual(await again.client.request('sources.settings.get', { providerId: 'usgs-earthquakes' }), {
        feed: 'hour',
        minMagnitude: 2.5,
      });
    } finally {
      await again.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('integration: export.objects is policy-gated per provider and reports what it skipped', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs()] });
  try {
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();

    // USGS allows export, so everything is written and nothing is skipped.
    const target = path.join(h.dataDir, 'export.geojson');
    h.host.saveQueue.push(target);
    const result = await h.client.request('export.objects', {
      query: { objectTypes: ['earthquake'] },
      format: 'geojson',
    });
    assert.ok('path' in result, 'the export completed');
    assert.deepEqual('skippedProviders' in result ? result.skippedProviders : ['?'], []);
    const geojson = JSON.parse(await fs.readFile(target, 'utf8')) as {
      type: string;
      features: unknown[];
      attribution?: string[];
    };
    assert.equal(geojson.type, 'FeatureCollection');
    assert.equal(geojson.features.length, 8);
    assert.deepEqual(
      geojson.attribution,
      ['Data courtesy of the U.S. Geological Survey'],
      'attribution travels with exported data',
    );

    // CSV quotes every cell and neutralises formula injection.
    const csvTarget = path.join(h.dataDir, 'export.csv');
    h.host.saveQueue.push(csvTarget);
    await h.client.request('export.objects', { query: { objectTypes: ['earthquake'] }, format: 'csv' });
    const csv = await fs.readFile(csvTarget, 'utf8');
    assert.match(csv.split('\n')[0]!, /^id,type,observedAt/);
    assert.equal(csv.split('\n').filter((l) => l.trim()).length, 9);
    assert.equal(/\n[=+@]/.test(csv), false, 'no cell starts with a spreadsheet formula character');

    // Without a save dialog the export is cancelled, never written somewhere unasked.
    assert.deepEqual(await h.client.request('export.objects', { query: {}, format: 'json' }), { cancelled: true });
  } finally {
    await h.dispose();
  }
});

/** A provider whose data policy forbids export, so the gate has something to refuse. */
const NO_EXPORT_MANIFEST: ProviderManifest = {
  id: 'cctv-public',
  name: 'Public cameras (export-forbidden test double)',
  version: '0.1.0',
  description: 'Emits one camera object under a data policy that forbids export, so the export gate is exercised.',
  objectTypes: ['camera'],
  categories: ['infrastructure'],
  transport: 'filesystem',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 300_000,
    minIntervalMs: 60_000,
    timeoutMs: 5_000,
    maxRetries: 0,
    maxRequestsPerMinute: 10,
    staleWhileErrorMs: 0,
  },
  dataPolicy: {
    cacheAllowed: false,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: false,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: false,
    attributionRequired: true,
    attributionText: 'Camera frames © the operating authority',
  },
  attribution: { text: 'Camera frames © the operating authority' },
  commercialReview: 'conditional',
  enabledByDefault: true,
  allowedHosts: [],
};

class NoExportCameraProvider implements WorldProvider {
  readonly manifest = NO_EXPORT_MANIFEST;
  private context!: ProviderContext;
  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async query(): Promise<Observation[]> {
    const at = new Date(this.context.clock.now()).toISOString();
    return [
      {
        id: `cctv-public:CAM1:${at}`,
        providerId: 'cctv-public',
        externalId: 'CAM1',
        objectType: 'camera',
        observedAt: at,
        receivedAt: at,
        position: { latitude: 21.3, longitude: -157.86 },
        payload: {
          name: 'Harbour camera',
          pack: 'fintraffic',
          frameUrl: 'https://weathercam.digitraffic.fi/CAM1.jpg',
          media: [{ kind: 'snapshot', ref: 'public:fintraffic:CAM1' }],
        },
        quality: { complete: true, sourceQuality: 'authoritative' },
        provenance: { providerId: 'cctv-public', sourceName: NO_EXPORT_MANIFEST.name, origin: 'live', receivedAt: at },
      },
    ];
  }
  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: 'LIVE',
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
    };
  }
}

test('integration: export refuses objects whose provider forbids export and names the provider', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs(), new NoExportCameraProvider()] });
  try {
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await h.client.request('sources.refresh', { providerId: 'cctv-public' });
    await settle();
    assert.equal((await h.client.request('world.query', { objectTypes: ['camera'] })).items.length, 1);

    const target = path.join(h.dataDir, 'mixed.geojson');
    h.host.saveQueue.push(target);
    const result = await h.client.request('export.objects', { query: {}, format: 'geojson' });
    assert.ok('path' in result);
    assert.deepEqual(
      'skippedProviders' in result ? result.skippedProviders : [],
      ['cctv-public'],
      'the refusing provider is named, not silently dropped',
    );

    const geojson = JSON.parse(await fs.readFile(target, 'utf8')) as {
      features: Array<{ properties: { type: string } }>;
    };
    assert.equal(geojson.features.length, 8, 'only the exportable objects were written');
    assert.equal(
      geojson.features.some((f) => f.properties.type === 'camera'),
      false,
    );
  } finally {
    await h.dispose();
  }
});

test('integration: public frame refs follow the camera objects, not every batch', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs(), new NoExportCameraProvider()] });
  try {
    const frames = h.runtime.core.publicFrames;
    let syncs = 0;
    const original = frames.syncFromObjects.bind(frames);
    frames.syncFromObjects = (objects) => {
      syncs++;
      return original(objects);
    };
    await h.client.request('sources.refresh', { providerId: 'cctv-public' });
    await settle();
    assert.equal(frames.get('public:fintraffic:CAM1')?.frameUrl, 'https://weathercam.digitraffic.fi/CAM1.jpg');
    const afterCameras = syncs;
    assert.ok(afterCameras >= 1);
    // An earthquake batch cannot change cameras: no re-derivation.
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();
    assert.equal(syncs, afterCameras, 'a batch without cameras does not re-derive the frame registry');
    // Switching the camera source off removes its cameras, and with them the frame ref.
    await h.client.request('sources.setEnabled', { providerId: 'cctv-public', enabled: false });
    h.runtime.core.state.flush(); // the harness runs with change batching off; the app flushes on a timer
    await settle();
    assert.equal(frames.get('public:fintraffic:CAM1'), undefined, 'a removed camera is no longer fetchable');
  } finally {
    await h.dispose();
  }
});

test('integration: camera objects carry lifted media and registrations reach the cameras-local provider settings', async () => {
  const h = await startRuntime({ providerInstances: [new NoExportCameraProvider()] });
  try {
    await h.client.request('sources.refresh', { providerId: 'cctv-public' });
    await settle();

    // ADR-002: payload.media is lifted onto the object so the gateway can resolve it.
    const camera = (await h.client.request('world.query', { objectTypes: ['camera'] })).items[0]!;
    assert.deepEqual(camera.media, [{ kind: 'snapshot', ref: 'public:fintraffic:CAM1' }]);

    // Registering a user camera persists it (without URL or secret) for cameras-local.
    const registration = await h.client.request('camera.register', {
      name: 'Driveway',
      url: 'https://cam.example/snapshot.jpg',
      position: { latitude: 21.3, longitude: -157.8 },
    });
    assert.match(registration.cameraId, /^[0-9a-f]{12}$/);
    assert.equal(registration.gateway, 'direct');

    const listed = await h.client.request('camera.list', undefined);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, 'Driveway');

    const settings = await h.client.request('sources.settings.get', { providerId: 'cameras-local' });
    const cameras = settings['cameras'] as Array<Record<string, unknown>>;
    assert.equal(cameras.length, 1);
    assert.equal(cameras[0]?.['cameraId'], registration.cameraId);
    assert.equal(
      JSON.stringify(settings).includes('cam.example'),
      false,
      'no URL and no secret is written into provider settings',
    );

    await h.client.request('camera.unregister', { cameraId: registration.cameraId });
    assert.deepEqual((await h.client.request('sources.settings.get', { providerId: 'cameras-local' }))['cameras'], []);
  } finally {
    await h.dispose();
  }
});

/** 250 cameras at once: enough for a snapshot of more than one page. */
class ManyCamerasProvider extends NoExportCameraProvider {
  override async query(): Promise<Observation[]> {
    const [one] = await super.query();
    return Array.from({ length: 250 }, (_, i) => ({
      ...one!,
      id: `cctv-public:CAM${i}:${one!.observedAt}`,
      externalId: `CAM${i}`,
      position: { latitude: 21 + i / 1000, longitude: -157 },
    }));
  }
}

test('integration: a large world.subscribe snapshot arrives in pages, each once, and a new subscription ends the old', async () => {
  const h = await startRuntime({ providerInstances: [new ManyCamerasProvider()] });
  try {
    await h.client.request('sources.refresh', { providerId: 'cctv-public' });
    await settle();
    const first = await h.client.request('world.subscribe', { objectTypes: ['camera'], pageSize: 100 });
    assert.equal(first.count, 250);
    assert.equal(first.snapshot.length, 100);
    assert.equal(first.more?.remaining, 150);
    const ids = new Set(first.snapshot.map((o) => o.id));
    const second = await h.client.request('world.subscribe.more', { token: first.more!.token });
    assert.equal(second.done, false);
    const third = await h.client.request('world.subscribe.more', { token: first.more!.token });
    assert.equal(third.done, true);
    for (const o of [...second.snapshot, ...third.snapshot]) ids.add(o.id);
    assert.equal(ids.size, 250, 'every object exactly once');
    // Unpaged, as before.
    const whole = await h.client.request('world.subscribe', { objectTypes: ['camera'] });
    assert.equal(whole.snapshot.length, 250);
    assert.equal(whole.more, undefined);
    // A paged snapshot replaced by a newer subscription answers NOT_FOUND.
    const paged = await h.client.request('world.subscribe', { objectTypes: ['camera'], pageSize: 100 });
    await h.client.request('world.subscribe', { objectTypes: ['camera'] });
    await assert.rejects(
      h.client.request('world.subscribe.more', { token: paged.more!.token }),
      (e: unknown) => (e as { ipcCode?: string }).ipcCode === 'NOT_FOUND', // the router turns this into IpcError NOT_FOUND
    );
  } finally {
    await h.dispose();
  }
});
