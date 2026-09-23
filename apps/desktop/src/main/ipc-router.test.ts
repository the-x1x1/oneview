import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_CHANNELS, EVENT_CHANNELS, wireChannel, type AppSettings } from '@worldview/ipc-contract';
import { ProviderError } from '@worldview/provider-sdk';
import { IpcRouter, type IpcInvokeEventLike, type IpcMainLike, type WindowSinkLike } from './ipc-router.js';
import { REQUEST_SCHEMAS } from './ipc-schemas.js';
import { StubRuntime } from './testing/stub-runtime.js';
import { fromWire, isJsonWire } from '../shared/event-wire.js';

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, (event: IpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown>();
  handle(
    channel: string,
    listener: (event: IpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  /** What Electron does: dispatch by wire channel; unknown channels are not handled at all. */
  async invoke(channel: string, payload: unknown, event: IpcInvokeEventLike): Promise<unknown> {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`No handler registered for '${channel}'`);
    return h(event, payload);
  }
}

class FakeWindow implements WindowSinkLike {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  destroyed = false;
  constructor(readonly id: number) {}
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const trusted = (id = 1): IpcInvokeEventLike => ({
  sender: { id },
  senderFrame: { url: 'file:///app/dist/renderer/index.html' },
});
const untrusted: IpcInvokeEventLike = { sender: { id: 9 }, senderFrame: { url: 'https://evil.example/' } };
const trustedSender = (e: IpcInvokeEventLike) => (e.senderFrame?.url ?? '').startsWith('file:///app/dist/renderer/');

function setup(opts: { runtime?: StubRuntime; clock?: { now(): number } } = {}) {
  const ipcMain = new FakeIpcMain();
  const runtime = opts.runtime ?? new StubRuntime();
  const router = new IpcRouter({
    ipcMain,
    runtime,
    isTrustedSender: trustedSender,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  router.register();
  return { ipcMain, runtime, router };
}

test('router: registers exactly the request catalogue and nothing else; unknown channels are refused', async () => {
  const { ipcMain, router } = setup();
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), REQUEST_CHANNELS.map(wireChannel).sort());
  assert.equal(Object.keys(REQUEST_SCHEMAS).length, REQUEST_CHANNELS.length, 'one schema per channel');
  await assert.rejects(
    ipcMain.invoke('worldview:fs.readFile', { path: '/etc/passwd' }, trusted()),
    /No handler registered/,
  );
  const direct = await router.handle('fs.readFile', {}, trusted());
  assert.deepEqual(direct, {
    ok: false,
    error: { code: 'DENIED', message: 'unknown channel', channel: 'fs.readFile' },
  });
  const prefixed = await router.handle('worldview:execute', {}, trusted());
  assert.equal(prefixed.ok, false);
  // Prototype keys never resolve to handlers.
  const proto = await router.handle('constructor', {}, trusted());
  assert.equal(proto.ok, false);
});

test('router: every channel rejects a malformed payload and accepts a well-formed one', async () => {
  const { router } = setup();
  const good: Partial<Record<(typeof REQUEST_CHANNELS)[number], unknown>> = {
    'app.openExternal': { url: 'https://earthquake.usgs.gov/' },
    'settings.set': { renderMode: '2D' },
    'world.query': { objectTypes: ['aircraft'], limit: 10 },
    'world.get': { objectId: 'aircraft:icao24:abc123' },
    'world.track': { objectId: 'x', time: { start: '2026-09-21T00:00:00.000Z', end: '2026-09-21T01:00:00.000Z' } },
    'world.events': {},
    'world.event': { eventId: 'event:x' },
    'world.subscribe': { bounds: { west: -10, south: -10, east: 10, north: 10 } },
    'world.related': { objectId: 'x' },
    'world.whatChanged': {
      region: { kind: 'bounds', bounds: { west: -10, south: -10, east: 10, north: 10 } },
      time: { start: '2026-09-21T00:00:00.000Z', end: '2026-09-21T01:00:00.000Z' },
    },
    'world.viewport': { bounds: { west: -10, south: -10, east: 10, north: 10 }, zoom: 4 },
    'tiles.prefetch': {
      sourceId: 'esri-world-imagery',
      bounds: { west: -10, south: -10, east: 10, north: 10 },
      zoom: 4,
    },
    'sources.manifest': { providerId: 'usgs-earthquakes' },
    'sources.setEnabled': { providerId: 'usgs-earthquakes', enabled: false },
    'sources.refresh': { providerId: 'usgs-earthquakes' },
    'sources.settings.get': { providerId: 'usgs-earthquakes' },
    'sources.settings.set': { providerId: 'usgs-earthquakes', settings: { window: 'day' } },
    'credentials.has': { key: 'firms.mapKey' },
    'credentials.set': { key: 'firms.mapKey', value: 'abc' },
    'credentials.delete': { key: 'firms.mapKey' },
    'history.query': { time: { start: '2026-09-21T00:00:00.000Z', end: '2026-09-21T01:00:00.000Z' } },
    'history.availability': { objectTypes: ['earthquake'] },
    'history.usage': undefined,
    'diagnostics.renderer': { active: '3D', webgl2: true },
    'timeline.set': { mode: 'PAUSED', speed: 5 },
    'search.query': { text: 'tokyo', limit: 5 },
    'lenses.save': {
      id: 'my-lens',
      name: 'Mine',
      objectTypes: ['aircraft'],
      eventTypes: [],
      renderingRules: [],
      visiblePanels: ['selection'],
    },
    'lenses.delete': { id: 'my-lens' },
    'collections.save': {
      id: 'c1',
      name: 'Trip',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      items: [
        {
          id: 'i1',
          kind: 'location',
          title: 'Home',
          createdAt: '2026-09-21T00:00:00.000Z',
          updatedAt: '2026-09-21T00:00:00.000Z',
          position: { latitude: 1, longitude: 2 },
        },
      ],
    },
    'collections.delete': { id: 'c1' },
    'collections.export': { id: 'c1' },
    'watchzones.save': {
      id: 'w1',
      name: 'Bay',
      geometry: { kind: 'circle', center: { latitude: 37, longitude: -122 }, radiusM: 5000 },
      eventTypes: ['earthquake'],
      notifications: { inApp: true, desktop: false },
      enabled: true,
      createdAt: '2026-09-21T00:00:00.000Z',
    },
    'watchzones.delete': { id: 'w1' },
    'feed.recent': { limit: 20, minimumSeverity: 'MINOR' },
    'offline.removePack': { id: 'pack-1' },
    'offline.setPackEnabled': { id: 'pack-1', enabled: true },
    'export.objects': { query: { objectTypes: ['earthquake'] }, format: 'geojson' },
    'camera.register': { name: 'Porch', url: 'rtsp://192.168.1.10/stream' },
    'camera.snapshot': { cameraId: 'cam-1' },
    'camera.stream': { cameraId: 'cam-1' },
    'camera.unregister': { cameraId: 'cam-1' },
  };
  const bad: Partial<Record<(typeof REQUEST_CHANNELS)[number], unknown>> = {
    'app.openExternal': { url: 'javascript:alert(1)' },
    'settings.set': { privacy: { telemetry: true } },
    'world.query': { limit: -1 },
    'world.get': { objectId: '' },
    'world.viewport': { bounds: { west: 0, south: 50, east: 1, north: 10 }, zoom: 1 },
    'sources.manifest': { providerId: '../../etc' },
    'credentials.set': { key: 'k', value: 'x'.repeat(5000) },
    'credentials.has': { key: 'key with spaces' },
    'timeline.set': { speed: 3 },
    'camera.register': { name: 'x', url: 'file:///etc/passwd' },
    'lenses.save': {
      id: 'l',
      name: 'L',
      objectTypes: ['a'],
      eventTypes: [],
      renderingRules: [],
      visiblePanels: [],
      extra: true,
    },
    'export.objects': { query: {}, format: 'xlsx' },
    'feed.recent': { limit: 100000 },
    'collections.save': { id: 'c', name: 'n', createdAt: 'yesterday', updatedAt: 'today', items: [] },
  };
  for (const channel of REQUEST_CHANNELS) {
    const payload = channel in good ? good[channel] : undefined;
    const r = await router.handle(channel, payload, trusted());
    assert.equal(r.ok, true, `${channel} should accept ${JSON.stringify(payload)}: ${JSON.stringify(r)}`);
    // Every channel refuses a payload of the wrong basic shape.
    const wrong = await router.handle(channel, payload === undefined ? { unexpected: 1 } : 42, trusted());
    assert.equal(wrong.ok, false, `${channel} should reject a wrong-shape payload`);
    if (!wrong.ok) assert.equal(wrong.error.code, 'INVALID_REQUEST');
  }
  for (const [channel, payload] of Object.entries(bad)) {
    const r = await router.handle(channel, payload, trusted());
    assert.equal(r.ok, false, `${channel} should reject ${JSON.stringify(payload)}`);
    if (!r.ok) {
      assert.equal(r.error.code, 'INVALID_REQUEST');
      assert.equal(r.error.channel, channel);
    }
  }
});

test('router: untrusted senders are refused before validation or handlers run', async () => {
  const { router, runtime } = setup();
  const r = await router.handle('settings.get', undefined, untrusted);
  assert.deepEqual(r, { ok: false, error: { code: 'DENIED', message: 'untrusted sender', channel: 'settings.get' } });
  assert.equal(runtime.calls.length, 0);
  const noFrame = await router.handle('settings.get', undefined, { sender: { id: 2 }, senderFrame: null });
  assert.equal(noFrame.ok, false);
});

test('router: credentials.* is rate limited to 10 per minute per window', async () => {
  let now = 1_000_000;
  const { router, runtime } = setup({ clock: { now: () => now } });
  for (let i = 0; i < 10; i++)
    assert.equal((await router.handle('credentials.has', { key: 'k' }, trusted(1))).ok, true);
  const eleventh = await router.handle('credentials.has', { key: 'k' }, trusted(1));
  assert.equal(eleventh.ok, false);
  if (!eleventh.ok) {
    assert.equal(eleventh.error.code, 'DENIED');
    assert.match(eleventh.error.message, /rate limited/);
  }
  assert.equal(
    (await router.handle('credentials.has', { key: 'k' }, trusted(2))).ok,
    true,
    'another window has its own budget',
  );
  assert.equal((await router.handle('settings.get', undefined, trusted(1))).ok, true, 'other channels unaffected');
  now += 61_000;
  assert.equal(
    (await router.handle('credentials.has', { key: 'k' }, trusted(1))).ok,
    true,
    'budget refills after the window',
  );
  assert.equal(runtime.calls.filter((c) => c.channel === 'credentials.has').length, 12);
});

test('router: errors are mapped to IpcError without stacks, paths or secrets', async () => {
  const runtime = new StubRuntime({
    failures: {
      'world.get': new Error('ENOENT /home/alice/.config/WorldView/history/x.duckdb token=SECRET'),
      'sources.refresh': new ProviderError('HOST_NOT_ALLOWED', 'host evil.example not allowed'),
      'sources.list': new ProviderError('TIMEOUT', 'request timed out'),
      'world.event': { code: 'NOT_FOUND', message: 'no such event', channel: 'ignored' },
      'lenses.delete': Object.assign(new Error('built-in lenses cannot be deleted'), { ipcCode: 'DENIED' }),
    },
  });
  const { router } = setup({ runtime });
  const internal = await router.handle('world.get', { objectId: 'x' }, trusted());
  assert.deepEqual(internal, {
    ok: false,
    error: { code: 'INTERNAL', message: 'internal error (details are in the application log)', channel: 'world.get' },
  });
  const denied = await router.handle('sources.refresh', { providerId: 'usgs-earthquakes' }, trusted());
  assert.equal(!denied.ok && denied.error.code, 'DENIED');
  const unavailable = await router.handle('sources.list', undefined, trusted());
  assert.equal(!unavailable.ok && unavailable.error.code, 'UNAVAILABLE');
  const notFound = await router.handle('world.event', { eventId: 'event:x' }, trusted());
  assert.deepEqual(notFound, {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'no such event', channel: 'world.event' },
  });
  const hinted = await router.handle('lenses.delete', { id: 'overview' }, trusted());
  assert.deepEqual(hinted, {
    ok: false,
    error: { code: 'DENIED', message: 'built-in lenses cannot be deleted', channel: 'lenses.delete' },
  });
  for (const r of [internal, denied, unavailable, notFound, hinted]) {
    const text = JSON.stringify(r);
    assert.ok(!text.includes('stack') && !text.includes('alice') && !text.includes('SECRET'), text);
  }
});

test('router: overrides take precedence; request context carries the window client id; timeouts abort', async () => {
  const runtime = new StubRuntime();
  const ipcMain = new FakeIpcMain();
  let seenSignal: AbortSignal | undefined;
  const router = new IpcRouter({
    ipcMain,
    runtime,
    isTrustedSender: trustedSender,
    requestTimeoutMs: 20,
    overrides: {
      'credentials.has': async () => ({ present: true }),
      'world.subscribe': async (_req, ctx) => {
        seenSignal = ctx.signal;
        await new Promise((r) => setTimeout(r, 60));
        return { snapshot: [], count: 0 };
      },
    },
  });
  router.register();
  const r = await router.handle('credentials.has', { key: 'k' }, trusted(7));
  assert.deepEqual(r, { ok: true, value: { present: true } });
  assert.equal(runtime.calls.length, 0, 'override replaced the runtime handler');
  await router.handle('settings.get', undefined, trusted(7));
  assert.equal(runtime.calls[0]?.clientId, 'win:7');
  const slow = await router.handle('world.subscribe', {}, trusted(7));
  assert.deepEqual(slow, {
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'request timed out', channel: 'world.subscribe' },
  });
  assert.equal(seenSignal?.aborted, true);
});

test('router: runtime events fan out to attached windows; targeted events reach one window; destroyed windows are dropped', () => {
  const { router, runtime } = setup();
  const a = new FakeWindow(1);
  const b = new FakeWindow(2);
  const detachA = router.attachWindow(a);
  router.attachWindow(b);
  const settings: AppSettings = {
    renderMode: '2D',
    firstRunCompleted: true,
    basemapId: 'x',
    terrainId: 'y',
    activeLensId: 'overview',
    reducedMotion: false,
    textScale: 1,
    updater: { automatic: false, prerelease: false },
    cameras: { go2rtcPath: '' },
    demoMode: false,
    privacy: { telemetry: false },
    providers: {},
    hiddenLayers: [],
    tileCache: { maxMB: 2048, preloadWorld: false },
    history: { maxMB: 10_240 },
  };
  runtime.emit('settings.changed', settings);
  assert.deepEqual(a.sent, [{ channel: 'worldview:settings.changed', payload: settings }]);
  assert.deepEqual(b.sent, [{ channel: 'worldview:settings.changed', payload: settings }]);
  runtime.emit('feed.item', { id: 'f', at: '2026-09-21T00:00:00Z', title: 'x', severity: 'INFO', type: 't' }, 'win:2');
  assert.equal(a.sent.length, 1, 'targeted event skipped window 1');
  assert.equal(b.sent.length, 2);
  b.destroyed = true;
  runtime.emit('connection.changed', {
    state: 'OFFLINE',
    networkOnline: false,
    remoteLive: 0,
    remoteTotal: 0,
    localLive: 0,
    at: '2026-09-21T00:00:00Z',
  });
  assert.equal(b.sent.length, 2, 'destroyed window receives nothing');
  assert.equal(a.sent.length, 2);
  detachA();
  runtime.emit('connection.changed', {
    state: 'CONNECTED',
    networkOnline: true,
    remoteLive: 1,
    remoteTotal: 1,
    localLive: 0,
    at: '2026-09-21T00:00:00Z',
  });
  assert.equal(a.sent.length, 2, 'detached window receives nothing');
  for (const e of EVENT_CHANNELS) assert.ok(wireChannel(e).startsWith('worldview:'));
  router.dispose();
});

test('router: a world delta goes out as JSON, encoded once for every window', () => {
  const { runtime, router } = setup();
  const a = new FakeWindow(1);
  const b = new FakeWindow(2);
  router.attachWindow(a);
  router.attachWindow(b);
  const delta = {
    added: ['satellite:norad:25544'],
    updated: [],
    removed: [],
    refreshed: [],
    at: '2026-09-21T00:00:00Z',
    objectCount: 1,
    objects: [],
    freshness: [],
  };
  runtime.emit('world.changed', delta);
  const sent = a.sent[0]!;
  assert.equal(sent.channel, 'worldview:world.changed');
  assert.ok(isJsonWire(sent.payload), 'one string across IPC and the context bridge, not an object graph');
  assert.deepEqual(fromWire(sent.payload), delta);
  assert.equal(b.sent[0]!.payload, sent.payload, 'the same encoding, not one per window');
  router.dispose();
});

test('router: a large world delta goes out in parts that add up to it', () => {
  const { runtime, router } = setup();
  const win = new FakeWindow(1);
  router.attachWindow(win);
  const objects = Array.from({ length: 4_500 }, (_, i) => ({ id: `satellite:norad:${i}`, type: 'satellite' }));
  const delta = {
    added: objects.slice(0, 10).map((o) => o.id),
    updated: objects.slice(10).map((o) => o.id),
    removed: ['aircraft:icao24:gone'],
    refreshed: ['aircraft:icao24:old'],
    at: '2026-09-21T00:00:00Z',
    objectCount: 4_500,
    objects,
    freshness: [{ id: 'aircraft:icao24:old', freshness: 'STALE' }],
  };
  runtime.emit('world.changed', delta as never);
  const parts = win.sent
    .filter((m) => m.channel === 'worldview:world.changed')
    .map((m) => fromWire<typeof delta>(m.payload));
  assert.equal(parts.length, 3, '2,000 objects a message');
  assert.ok(parts.every((p) => p.objects.length <= 2_000));
  assert.deepEqual(
    parts.flatMap((p) => p.objects.map((o) => o.id)),
    objects.map((o) => o.id),
    'every object once, in order',
  );
  assert.deepEqual(
    parts.flatMap((p) => p.added),
    delta.added,
  );
  assert.deepEqual(
    parts.flatMap((p) => p.updated),
    delta.updated,
  );
  assert.deepEqual(
    parts.flatMap((p) => p.removed),
    delta.removed,
    'removals once',
  );
  assert.deepEqual(
    parts.flatMap((p) => p.freshness),
    delta.freshness,
  );
  assert.ok(parts.every((p) => p.at === delta.at && p.objectCount === delta.objectCount));
  router.dispose();
});

test('router: a world.subscribe snapshot is answered as JSON; small responses are not', async () => {
  const snapshot = { snapshot: [], count: 0 };
  const router = new IpcRouter({
    ipcMain: new FakeIpcMain(),
    runtime: new StubRuntime(),
    isTrustedSender: trustedSender,
    overrides: {
      'credentials.has': async () => ({ present: true }),
      'world.subscribe': async () => snapshot,
    },
  });
  router.register();
  const r = (await router.handle('world.subscribe', {}, trusted())) as { ok: true; value: unknown };
  assert.equal(r.ok, true);
  assert.ok(isJsonWire(r.value), 'the snapshot crosses as one string');
  assert.deepEqual(fromWire(r.value), snapshot);
  assert.deepEqual(await router.handle('credentials.has', { key: 'k' }, trusted()), {
    ok: true,
    value: { present: true },
  });
  router.dispose();
});
