import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import { ProviderHost } from '@worldview/provider-runtime';
import { WorldState } from '@worldview/state-engine';
import { testing as sdkTesting } from '@worldview/provider-sdk';
import { createProvider as createPublicCameras, FINTRAFFIC_STATIONS_URL } from '@worldview/provider-cctv-public';
import { CameraError, CameraHub, CameraRelay, DirectGateway, MemorySecretStore, PublicFrameRegistry, testing } from '../../src/index.js';

/**
 * Failure injection for the camera path: upstream 500, timeout and a non-image body
 * must surface as typed CameraErrors, degrade the relevant health, and leave the rest
 * of the application (other cameras, the relay, the catalog provider) running.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fixture = (n: string) => readFileSync(path.join(root, 'fixtures', 'cctv-public', n), 'utf8');

type Mode = 'ok' | '500' | 'timeout' | 'html' | 'too-large' | 'network';

function makeStack(modes: Record<string, Mode>) {
  const sink = new RingBufferSink();
  const logger = new LoggerHub({ level: 'debug', sinks: [sink] }).logger('camera');
  const fetchBytes = testing.fakeByteFetcher((url) => {
    const mode = Object.entries(modes).find(([k]) => url.includes(k))?.[1] ?? 'ok';
    switch (mode) {
      case '500': return { status: 500 };
      case 'timeout': return { error: 'timeout' };
      case 'network': return { error: 'network' };
      case 'too-large': return { error: 'too-large' };
      case 'html': return { bytes: testing.HTML_BYTES, headers: { 'content-type': 'image/jpeg' } };
      default: return { bytes: testing.JPEG_BYTES, headers: { 'content-type': 'image/jpeg' } };
    }
  });
  const relay = new CameraRelay({ fetchBytes, openUpstream: testing.fakeUpstreamOpener(() => ({ chunks: testing.mjpegChunks(1) })), logger });
  const direct = new DirectGateway({ fetchBytes, secrets: new MemorySecretStore(), relay, logger });
  const publicFrames = new PublicFrameRegistry({ logger });
  const hub = new CameraHub({ direct, publicFrames, fetchBytes, relay, logger });
  return { hub, direct, relay, publicFrames, fetchBytes, sink };
}

test('failure: upstream 500 / timeout / non-image surface as typed errors; healthy cameras keep working', async () => {
  const { hub, direct, relay, sink } = makeStack({ '/broken': '500', '/slow': 'timeout', '/login': 'html', '/huge': 'too-large', '/down': 'network' });
  await relay.start();
  try {
    const good = await hub.register({ name: 'good', url: 'http://cam.local/good.jpg' });
    const broken = await hub.register({ name: 'broken', url: 'http://cam.local/broken.jpg' });
    const slow = await hub.register({ name: 'slow', url: 'http://cam.local/slow.jpg' });
    const login = await hub.register({ name: 'login', url: 'http://cam.local/login.jpg' });
    const huge = await hub.register({ name: 'huge', url: 'http://cam.local/huge.jpg' });
    const down = await hub.register({ name: 'down', url: 'http://cam.local/down.jpg' });

    const expect = async (id: string, code: CameraError['code'], httpStatus?: number) => {
      await assert.rejects(hub.snapshot(id), (e: unknown) => e instanceof CameraError && e.code === code && (httpStatus === undefined || e.httpStatus === httpStatus), `${id} → ${code}`);
    };
    await expect(broken.cameraId, 'UPSTREAM_ERROR', 500);
    await expect(slow.cameraId, 'TIMEOUT');
    await expect(login.cameraId, 'NOT_AN_IMAGE');
    await expect(huge.cameraId, 'TOO_LARGE');
    await expect(down.cameraId, 'NETWORK');

    // The healthy camera is unaffected, through both the gateway and the relay.
    assert.equal((await hub.snapshot(good.cameraId)).mimeType, 'image/jpeg');
    const stream = await hub.stream(good.cameraId);
    assert.equal((await fetch(stream.url)).status, 200);
    const brokenStream = await hub.stream(broken.cameraId);
    assert.equal((await fetch(brokenStream.url)).status, 502, 'relay answers a typed status instead of dying');
    assert.equal(relay.isListening(), true);

    const list = await hub.list();
    const byId = Object.fromEntries(list.map((c) => [c.cameraId, c.health]));
    assert.equal(byId[good.cameraId]?.status, 'ok');
    assert.equal(byId[broken.cameraId]?.status, 'unavailable');
    assert.equal(byId[broken.cameraId]?.lastError?.code, 'UPSTREAM_ERROR');
    assert.equal(byId[login.cameraId]?.lastError?.code, 'NOT_AN_IMAGE');
    assert.equal((await direct.status()).state, 'ready', 'one healthy camera keeps the gateway ready');

    // Once a camera has worked, a retryable failure marks it degraded rather than unavailable.
    await hub.unregister(good.cameraId);
    for (const id of [slow.cameraId, login.cameraId, huge.cameraId, down.cameraId]) await hub.unregister(id);
    assert.equal((await direct.status()).state, 'degraded', 'all remaining cameras unavailable → degraded');
    assert.match((await direct.status()).message ?? '', /unavailable/);

    // IPC mapping stays typed and secret-free.
    const err = await hub.snapshot(broken.cameraId).catch((e: unknown) => e as CameraError);
    assert.equal(err.ipcCode, 'UNAVAILABLE');
    assert.ok(!JSON.stringify(sink.records).includes('cam.local'), 'upstream host never logged');
  } finally {
    await relay.stop();
  }
});

test('failure: public frame host refuses or times out → frame unavailable, catalog provider stays healthy', async () => {
  const { hub, publicFrames } = makeStack({ 'webcams.transport.nsw.gov.au': 'html', 'C0150102': '500', 'C1400301': 'timeout' });
  // Catalog through the real ProviderHost → WorldState → registry sync (the runtime wiring).
  const clock = new sdkTesting.VirtualClock(Date.parse('2026-09-21T08:05:00.000Z'));
  const loggerHub = new LoggerHub({ level: 'warn', sinks: [new RingBufferSink()] });
  const host = new ProviderHost({
    clock, loggerHub, manualScheduling: true, sleep: async () => {},
    fetchImpl: (async (input: string | URL | Request) => new Response(String(input) === FINTRAFFIC_STATIONS_URL ? fixture('fintraffic-stations.geojson') : fixture('nsw-traffic-cam.json'), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new sdkTesting.MemoryCache(clock, allowed),
    settingsStore: () => new sdkTesting.MemorySettings({}),
  });
  const state = new WorldState({ clock, flushDelayMs: 0 });
  host.onObservations((b) => { state.ingest(b.observations, { snapshot: b.snapshot, providerId: b.providerId, ...(b.freshness ? { freshness: b.freshness } : {}) }); publicFrames.syncFromObjects(state.all()); });
  host.register(createPublicCameras());
  await host.start();
  await host.pollNow('public-cameras');
  assert.equal(state.size, 9);
  assert.equal(publicFrames.size(), 9);

  assert.equal((await hub.snapshot('public:fintraffic:C0150101')).mimeType, 'image/jpeg');
  await assert.rejects(hub.snapshot('public:fintraffic:C0150102'), (e: unknown) => e instanceof CameraError && e.code === 'UPSTREAM_ERROR' && e.httpStatus === 500);
  await assert.rejects(hub.snapshot('public:fintraffic:C1400301'), (e: unknown) => e instanceof CameraError && e.code === 'TIMEOUT');
  await assert.rejects(hub.snapshot('public:nsw:1'), (e: unknown) => e instanceof CameraError && e.code === 'NOT_AN_IMAGE');
  assert.equal(hub.publicFrameHealth('public:nsw:1').status, 'unavailable');
  assert.equal(hub.publicFrameHealth('public:fintraffic:C0150101').status, 'ok');
  // Frame failures never touch the catalog provider's health: the app keeps its 9 camera objects.
  assert.equal(host.health.get('public-cameras')?.health.status, 'LIVE');
  assert.equal(state.size, 9);
  await host.dispose();
});

test('failure: one catalog pack returning 500 → provider DEGRADED, other pack still ingested', async () => {
  const clock = new sdkTesting.VirtualClock(Date.parse('2026-09-21T08:05:00.000Z'));
  const loggerHub = new LoggerHub({ level: 'warn', sinks: [new RingBufferSink()] });
  const host = new ProviderHost({
    clock, loggerHub, manualScheduling: true, sleep: async () => {},
    fetchImpl: (async (input: string | URL | Request) => String(input) === FINTRAFFIC_STATIONS_URL ? new Response(fixture('fintraffic-stations.geojson'), { status: 200 }) : new Response('down', { status: 500 })) as typeof fetch,
    credentials: { get: async () => undefined, has: async () => false },
    cacheStore: (_id, allowed) => new sdkTesting.MemoryCache(clock, allowed),
    settingsStore: () => new sdkTesting.MemorySettings({}),
  });
  const state = new WorldState({ clock, flushDelayMs: 0 });
  host.onObservations((b) => state.ingest(b.observations, { snapshot: b.snapshot, providerId: b.providerId }));
  host.register(createPublicCameras());
  await host.start();
  const batch = await host.pollNow('public-cameras');
  assert.equal(batch?.observations.length, 5, 'Fintraffic pack ingested although NSW is down');
  assert.equal(state.size, 5);
  const h = host.health.get('public-cameras')?.health;
  assert.equal(h?.status, 'DEGRADED');
  assert.equal(h?.lastError?.code, 'HTTP_5XX');
  assert.match(h?.message ?? '', /nsw/);
  await host.dispose();
});
