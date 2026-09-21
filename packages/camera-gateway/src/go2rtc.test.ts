import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import { Go2rtcSidecar, GO2RTC_PINNED_VERSION, type FetchLike, type SpawnFn, type SpawnedProcess } from './go2rtc-sidecar.js';
import { Go2rtcGateway } from './go2rtc-gateway.js';
import { MemorySecretStore } from './secret-store.js';
import { CameraError } from './errors.js';
import { CameraRelay } from './relay.js';
import { fakeByteFetcher, fakeUpstreamOpener, JPEG_BYTES } from './testing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface FakeApi { calls: Array<{ method: string; url: string }>; streams: Map<string, string>; up: boolean; version: string }

function fakeApi(opts: Partial<FakeApi> = {}): { api: FakeApi; fetch: FetchLike } {
  const api: FakeApi = { calls: [], streams: new Map(), up: true, version: GO2RTC_PINNED_VERSION, ...opts };
  const respond = (status: number, json: unknown = {}, bytes: Uint8Array = new Uint8Array()) => ({
    status,
    headers: { get: () => null },
    json: async () => json,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    api.calls.push({ method, url });
    if (!api.up) throw new Error('fetch failed: ECONNREFUSED');
    const u = new URL(url);
    assert.equal(u.hostname, '127.0.0.1', 'sidecar API must be loopback');
    if (u.pathname === '/api') return respond(200, { version: api.version });
    if (u.pathname === '/api/streams' && method === 'PUT') { api.streams.set(u.searchParams.get('name')!, u.searchParams.get('src')!); return respond(200); }
    if (u.pathname === '/api/streams' && method === 'DELETE') { api.streams.delete(u.searchParams.get('src')!); return respond(200); }
    if (u.pathname === '/api/frame.jpeg') return api.streams.has(u.searchParams.get('src')!) ? respond(200, {}, JPEG_BYTES) : respond(404);
    return respond(404);
  };
  return { api, fetch };
}

function fakeSpawn(): { spawn: SpawnFn; spawned: Array<{ command: string; args: string[] }>; procs: SpawnedProcess[] } {
  const spawned: Array<{ command: string; args: string[] }> = [];
  const procs: SpawnedProcess[] = [];
  const spawn: SpawnFn = (command, args) => {
    spawned.push({ command, args });
    const listeners: Array<(code: number | null, signal: string | null) => void> = [];
    const proc: SpawnedProcess = {
      pid: 4242,
      kill: () => { for (const l of listeners) l(null, 'SIGTERM'); return true; },
      on: (event, listener) => { if (event === 'exit') listeners.push(listener as (code: number | null, signal: string | null) => void); },
    };
    procs.push(proc);
    return proc;
  };
  return { spawn, spawned, procs };
}

function sidecarWith(opts: { binaryPath?: string; exists?: boolean; api?: Partial<FakeApi> }) {
  const { api, fetch } = fakeApi(opts.api);
  const { spawn, spawned } = fakeSpawn();
  const written: Array<{ file: string; content: string }> = [];
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink] });
  const sidecar = new Go2rtcSidecar({
    ...(opts.binaryPath !== undefined ? { binaryPath: opts.binaryPath } : {}),
    configDir: '/data/worldview',
    spawn,
    fetch,
    fileExists: () => opts.exists ?? true,
    writeFile: async (file, content) => { written.push({ file, content }); },
    logger: hub.logger('camera'),
    sleep: async () => {},
    healthTimeoutMs: 1000,
  });
  return { sidecar, api, fetch, spawned, written, sink };
}

test('pinned go2rtc version matches the software licence registry', () => {
  const registry = JSON.parse(readFileSync(path.join(root, 'config', 'licenses', 'software.json'), 'utf8')) as { records: Array<{ name: string; commitOrVersion: string }> };
  const rec = registry.records.find((r) => r.name === 'go2rtc');
  assert.ok(rec, 'go2rtc record missing from software.json');
  assert.ok(rec.commitOrVersion.includes(`v${GO2RTC_PINNED_VERSION}`), `software.json pins ${rec.commitOrVersion}, code pins v${GO2RTC_PINNED_VERSION}`);
});

test('sidecar does not start when no binary is configured', async () => {
  const { sidecar, spawned, written, api } = sidecarWith({});
  assert.equal(sidecar.configured(), false);
  assert.equal(await sidecar.start(), false);
  assert.equal(spawned.length, 0, 'spawn must not be called');
  assert.equal(written.length, 0, 'no config written');
  assert.equal(api.calls.length, 0);
  assert.equal(sidecar.status().status, 'not-configured');
});

test('sidecar does not start when the configured binary is absent', async () => {
  const { sidecar, spawned, written } = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc', exists: false });
  assert.equal(await sidecar.start(), false);
  assert.equal(spawned.length, 0);
  assert.equal(written.length, 0);
  assert.equal(sidecar.status().status, 'not-configured');
  assert.match(sidecar.status().message ?? '', /not found/);
});

test('generated config binds only to loopback and disables the WebRTC/SRTP listeners', async () => {
  const { sidecar, spawned, written } = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc' });
  const config = sidecar.generateConfig();
  const listens = [...config.matchAll(/listen:\s*"([^"]*)"/g)].map((m) => m[1]!);
  assert.ok(listens.length >= 4, 'expected api, rtsp, webrtc and srtp listen entries');
  for (const l of listens) assert.ok(l === '' || l.startsWith('127.0.0.1:'), `listener "${l}" is not loopback`);
  assert.ok(config.includes('listen: "127.0.0.1:1984"'));
  assert.ok(config.includes('listen: "127.0.0.1:8554"'));
  assert.ok(!/0\.0\.0\.0|":\d+"/.test(config), 'no wildcard binds');
  assert.ok(config.includes('streams: {}'), 'streams are added via the API, never written to disk');
  assert.ok(config.includes(`v${GO2RTC_PINNED_VERSION}`));
  assert.equal(await sidecar.start(), true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.command, '/opt/go2rtc/go2rtc');
  const expectedConfig = path.join('/data/worldview', 'go2rtc.yaml');
  assert.deepEqual(spawned[0]!.args, ['-config', expectedConfig], 'the config path is built for this platform');
  assert.equal(written[0]!.file, expectedConfig);
  assert.equal(written[0]!.content, config);
  assert.deepEqual(sidecar.status(), { id: 'go2rtc', status: 'running', version: GO2RTC_PINNED_VERSION });
  await sidecar.stop();
  assert.equal(sidecar.status().status, 'stopped');
});

test('sidecar reports an error when the API never answers, and a message on version mismatch', async () => {
  const dead = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc', api: { up: false } });
  assert.equal(await dead.sidecar.start(), false);
  assert.equal(dead.sidecar.status().status, 'error');
  const older = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc', api: { version: '1.8.0' } });
  assert.equal(await older.sidecar.start(), true);
  assert.equal(older.sidecar.status().version, '1.8.0');
  assert.match(older.sidecar.status().message ?? '', /pinned/);
});

test('go2rtc gateway registers streams through the loopback API, re-attaching credentials only there', async () => {
  const { sidecar, api, fetch, sink } = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc' });
  const secrets = new MemorySecretStore();
  const gw = new Go2rtcGateway({ sidecar, fetch, secrets, clock: { now: () => 0 }, logger: new LoggerHub({ level: 'debug', sinks: [sink] }).logger('camera') });
  await assert.rejects(gw.snapshot('000000000000'), (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND');
  const reg = await gw.register({ name: 'Yard', url: 'rtsp://admin:pa%3Ass@192.168.1.20:554/h264', position: { latitude: 1, longitude: 2 } });
  assert.equal(reg.gateway, 'go2rtc');
  assert.equal(reg.objectId, `camera:cameras-local:${reg.cameraId}`);
  assert.equal(api.streams.size, 0, 'sidecar not running yet: nothing pushed');
  await assert.rejects(gw.snapshot(reg.cameraId), (e: unknown) => e instanceof CameraError && e.code === 'UNAVAILABLE');
  assert.equal((await gw.status()).state, 'unavailable');

  assert.equal(await sidecar.start(), true);
  await gw.syncStreams();
  assert.equal(api.streams.get(reg.cameraId), 'rtsp://admin:pa%3Ass@192.168.1.20:554/h264', 'credential re-attached for the loopback call');
  assert.equal(gw.export()[0]!.url, 'rtsp://192.168.1.20:554/h264');
  const snap = await gw.snapshot(reg.cameraId);
  assert.equal(snap.mimeType, 'image/jpeg');
  const desc = await gw.stream(reg.cameraId);
  assert.equal(desc.kind, 'hls');
  assert.equal(desc.url, `http://127.0.0.1:1984/api/stream.m3u8?src=${reg.cameraId}`);
  assert.ok(!JSON.stringify(sink.records).includes('pa:ss') && !JSON.stringify(sink.records).includes('pa%3Ass'), 'credential leaked into logs');
  await gw.unregister(reg.cameraId);
  assert.equal(api.streams.size, 0);
  assert.equal(secrets.keys().length, 0);
  assert.equal((await gw.list()).length, 0);
});

test('go2rtc gateway fronts HLS with the token relay when one is configured', async () => {
  const { sidecar, fetch: apiFetch } = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc' });
  await sidecar.start();
  const relay = new CameraRelay({ fetchBytes: fakeByteFetcher(() => ({ body: '#EXTM3U\n#EXTINF:1,\nhls/segment.ts?id=1\n', headers: { 'content-type': 'application/vnd.apple.mpegurl' } })), openUpstream: fakeUpstreamOpener(() => ({ chunks: [] })) });
  const port = await relay.start();
  try {
    const gw = new Go2rtcGateway({ sidecar, fetch: apiFetch, secrets: new MemorySecretStore(), relay });
    const reg = await gw.register({ name: 'cam', url: 'rtsp://cam/live' });
    const desc = await gw.stream(reg.cameraId);
    assert.equal(desc.kind, 'hls');
    assert.ok(desc.url.startsWith(`http://127.0.0.1:${port}/cam/${reg.cameraId}/`));
    const res = await fetch(desc.url);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(`${desc.url}/r/hls/segment.ts?id=1`));
  } finally {
    await relay.stop();
    await sidecar.stop();
  }
});

test('sidecar: changing the binary path stops the running process before the swap', async () => {
  const { sidecar, spawned } = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc' });
  assert.equal(await sidecar.start(), true);
  assert.equal(sidecar.isRunning(), true);
  assert.deepEqual(spawned.map((s) => s.command), ['/opt/go2rtc/go2rtc']);

  await sidecar.setBinaryPath('/opt/go2rtc/go2rtc-v2');
  assert.equal(sidecar.isRunning(), false, 'the old process is not left running under the new path');
  assert.equal(sidecar.status().status, 'stopped');
  assert.equal(spawned.length, 1, 'the swap does not start anything by itself');

  assert.equal(await sidecar.start(), true);
  assert.deepEqual(spawned.map((s) => s.command), ['/opt/go2rtc/go2rtc', '/opt/go2rtc/go2rtc-v2']);
});

test('sidecar: clearing the binary path returns it to not-configured and refuses to start', async () => {
  const { sidecar, spawned } = sidecarWith({ binaryPath: '/opt/go2rtc/go2rtc' });
  await sidecar.start();
  await sidecar.setBinaryPath('');
  assert.equal(sidecar.configured(), false);
  assert.equal(sidecar.status().status, 'not-configured');
  assert.equal(await sidecar.start(), false);
  assert.equal(spawned.length, 1, 'nothing spawned after the path was cleared');
});

test('go2rtc gateway: an RTSP camera is refused while no sidecar is configured', async () => {
  const { sidecar } = sidecarWith({});
  const gateway = new Go2rtcGateway({ sidecar, fetch: fakeApi().fetch, secrets: new MemorySecretStore() });
  await assert.rejects(
    () => gateway.register({ name: 'Yard', url: 'rtsp://10.0.0.9:554/stream' }),
    (err: unknown) => err instanceof CameraError && err.code === 'UNSUPPORTED_SCHEME',
    'a camera that could never stream is not accepted',
  );
  assert.deepEqual(await gateway.list(), []);
  assert.equal((await gateway.status()).state, 'not-configured');
});
