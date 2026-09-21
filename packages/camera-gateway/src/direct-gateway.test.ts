import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import { CameraError } from './errors.js';
import { DirectGateway } from './direct-gateway.js';
import { MemorySecretStore } from './secret-store.js';
import { CameraRelay } from './relay.js';
import { fakeByteFetcher, fakeUpstreamOpener, JPEG_BYTES, PNG_BYTES, HTML_BYTES, mjpegChunks } from './testing.js';

const clock = { now: () => Date.parse('2026-09-21T08:00:00Z') };

function setup() {
  const secrets = new MemorySecretStore();
  const fetchBytes = fakeByteFetcher((url, opts) => {
    if (url.includes('/png')) return { bytes: PNG_BYTES };
    if (url.includes('/html')) return { bytes: HTML_BYTES, headers: { 'content-type': 'image/jpeg' } };
    if (url.includes('/auth')) return opts.headers?.['Authorization'] ? { bytes: JPEG_BYTES } : { status: 401 };
    return { bytes: JPEG_BYTES, headers: { 'content-type': 'image/jpeg' } };
  });
  const openUpstream = fakeUpstreamOpener(() => ({ chunks: mjpegChunks(2) }));
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink] });
  const gateway = new DirectGateway({ fetchBytes, openUpstream, secrets, clock, logger: hub.logger('camera') });
  return { gateway, secrets, fetchBytes, openUpstream, sink };
}

test('register moves URL credentials to the secret store and keeps only the key', async () => {
  const { gateway, secrets } = setup();
  const reg = await gateway.register({ name: 'Garage', url: 'http://admin:hunter2@10.0.0.5/auth/snap.jpg', position: { latitude: 48.1, longitude: 11.5 }, headingDegrees: 725 });
  assert.match(reg.cameraId, /^[0-9a-f]{12}$/);
  assert.equal(reg.objectId, `camera:cameras-local:${reg.cameraId}`);
  assert.equal(reg.gateway, 'direct');
  const [record] = gateway.export();
  assert.ok(record);
  assert.equal(record.url, 'http://10.0.0.5/auth/snap.jpg');
  assert.equal(record.credentialKey, `camera.${reg.cameraId}.credential`);
  assert.equal(await secrets.get(record.credentialKey!), 'admin:hunter2');
  assert.equal(record.headingDegrees, 5);
  assert.deepEqual(record.position, { latitude: 48.1, longitude: 11.5 });
  assert.ok(!JSON.stringify(gateway.export()).includes('hunter2'));
  assert.ok(!JSON.stringify(await gateway.list()).includes('hunter2'));
});

test('re-registering the same URL yields the same id; dropping credentials deletes the secret', async () => {
  const { gateway, secrets } = setup();
  const a = await gateway.register({ name: 'A', url: 'http://u:p@cam.local/snap.jpg' });
  const b = await gateway.register({ name: 'A renamed', url: 'http://cam.local/snap.jpg' });
  assert.equal(a.cameraId, b.cameraId);
  assert.equal((await gateway.list()).length, 1);
  assert.equal((await gateway.list())[0]!.name, 'A renamed');
  assert.equal(secrets.keys().length, 0);
});

test('register rejects unsupported schemes and empty names with typed errors', async () => {
  const { gateway } = setup();
  await assert.rejects(gateway.register({ name: 'x', url: 'rtsp://cam/live' }), (e: unknown) => e instanceof CameraError && e.code === 'UNSUPPORTED_SCHEME' && e.ipcCode === 'INVALID_REQUEST');
  await assert.rejects(gateway.register({ name: '', url: 'http://cam/snap.jpg' }), (e: unknown) => e instanceof CameraError && e.code === 'INVALID_URL');
  await assert.rejects(gateway.register({ name: 'x', url: 'file:///tmp/x.jpg' }), (e: unknown) => e instanceof CameraError && e.code === 'UNSUPPORTED_SCHEME');
});

test('snapshot fetches with injected credential header, validates magic bytes and tracks health', async () => {
  const { gateway, fetchBytes, sink } = setup();
  const reg = await gateway.register({ name: 'Auth cam', url: 'http://admin:hunter2@10.0.0.5/auth/snap.jpg' });
  const snap = await gateway.snapshot(reg.cameraId);
  assert.equal(snap.mimeType, 'image/jpeg');
  assert.equal(snap.capturedAt, '2026-09-21T08:00:00.000Z');
  assert.deepEqual([...snap.bytes], [...JPEG_BYTES]);
  const call = fetchBytes.calls.at(-1)!;
  assert.equal(call.url, 'http://10.0.0.5/auth/snap.jpg');
  assert.equal(call.headers['Authorization'], `Basic ${Buffer.from('admin:hunter2').toString('base64')}`);
  assert.match(call.headers['User-Agent'] ?? '', /^WorldView\//);
  assert.equal((await gateway.list())[0]!.health.status, 'ok');
  const logs = JSON.stringify(sink.records);
  assert.ok(!logs.includes('hunter2') && !logs.includes('Basic '), 'secret leaked into logs');

  const png = await gateway.register({ name: 'PNG', url: 'http://cam/png' });
  assert.equal((await gateway.snapshot(png.cameraId)).mimeType, 'image/png');

  const html = await gateway.register({ name: 'HTML', url: 'http://cam/html' });
  await assert.rejects(gateway.snapshot(html.cameraId), (e: unknown) => e instanceof CameraError && e.code === 'NOT_AN_IMAGE');
  const entry = (await gateway.list()).find((c) => c.cameraId === html.cameraId)!;
  assert.equal(entry.health.status, 'unavailable');
  assert.equal(entry.health.lastError?.code, 'NOT_AN_IMAGE');
});

test('snapshot of an MJPEG source extracts the first frame and cancels the upstream', async () => {
  const { gateway, openUpstream } = setup();
  const reg = await gateway.register({ name: 'MJPEG', url: 'http://cam/video.mjpg' });
  const snap = await gateway.snapshot(reg.cameraId);
  assert.equal(snap.mimeType, 'image/jpeg');
  assert.ok(openUpstream.cancelled >= 1);
});

test('snapshot of unknown camera and HLS source', async () => {
  const { gateway } = setup();
  await assert.rejects(gateway.snapshot('000000000000'), (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND');
  const hls = await gateway.register({ name: 'HLS', url: 'https://cam/live/index.m3u8' });
  await assert.rejects(gateway.snapshot(hls.cameraId), (e: unknown) => e instanceof CameraError && e.code === 'UNSUPPORTED');
});

test('stream requires a relay and returns loopback descriptors per source kind', async () => {
  const { gateway: noRelay } = setup();
  const r0 = await noRelay.register({ name: 'x', url: 'http://cam/video.mjpg' });
  await assert.rejects(noRelay.stream(r0.cameraId), (e: unknown) => e instanceof CameraError && e.code === 'UNAVAILABLE');
  assert.equal((await noRelay.status()).state, 'ready');

  const secrets = new MemorySecretStore();
  const fetchBytes = fakeByteFetcher(() => ({ bytes: JPEG_BYTES }));
  const relay = new CameraRelay({ fetchBytes, openUpstream: fakeUpstreamOpener(() => ({ chunks: mjpegChunks(1) })) });
  const gateway = new DirectGateway({ fetchBytes, secrets, relay, clock });
  const port = await relay.start();
  try {
    const mj = await gateway.register({ name: 'mj', url: 'http://cam/video.mjpg' });
    const hl = await gateway.register({ name: 'hl', url: 'https://cam/live/index.m3u8' });
    const sn = await gateway.register({ name: 'sn', url: 'http://cam/snap.jpg' });
    const d1 = await gateway.stream(mj.cameraId);
    assert.equal(d1.kind, 'mjpeg');
    assert.ok(d1.url.startsWith(`http://127.0.0.1:${port}/cam/${mj.cameraId}/`));
    assert.match(d1.url, /\/cam\/[0-9a-f]{12}\/[0-9a-f]{32}$/);
    assert.equal((await gateway.stream(hl.cameraId)).kind, 'hls');
    assert.equal((await gateway.stream(sn.cameraId)).kind, 'snapshot-poll');
    const status = await gateway.status();
    assert.equal(status.state, 'ready');
    assert.equal(status.relay?.listening, true);
    assert.equal(status.relay?.port, port);
    await gateway.unregister(mj.cameraId);
    await assert.rejects(gateway.stream(mj.cameraId), (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND');
    assert.equal(relay.has(mj.cameraId), false);
  } finally {
    await relay.stop();
  }
});

test('restore() rebuilds registrations from persisted records without secrets', async () => {
  const { gateway, secrets } = setup();
  const reg = await gateway.register({ name: 'Persist', url: 'http://u:p@cam/snap.jpg' });
  const records = gateway.export();
  const fresh = new DirectGateway({ fetchBytes: fakeByteFetcher(() => ({ bytes: JPEG_BYTES })), secrets, clock });
  fresh.restore([...records, { cameraId: 'zz', objectId: 'x', name: 'bad', url: 'http://x', kind: 'snapshot', registeredAt: 'now' }]);
  const list = await fresh.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.cameraId, reg.cameraId);
  const snap = await fresh.snapshot(reg.cameraId);
  assert.equal(snap.mimeType, 'image/jpeg');
});
