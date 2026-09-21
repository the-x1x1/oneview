import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { PublicFrameRegistry, publicCameraFromObject, isAllowedFrameUrl, PUBLIC_FRAME_HOSTS } from './public-frames.js';
import { CameraHub } from './hub.js';
import { DirectGateway } from './direct-gateway.js';
import { MemorySecretStore } from './secret-store.js';
import { CameraRelay } from './relay.js';
import { CameraError } from './errors.js';
import { fakeByteFetcher, fakeUpstreamOpener, JPEG_BYTES, HTML_BYTES } from './testing.js';

function cameraObject(over: { id?: string; pack?: string; frameUrl?: string; ref?: string; mediaInProperties?: boolean } = {}): WorldObject {
  const pack = over.pack ?? 'fintraffic';
  const ref = over.ref ?? `public:${pack}:C0150201`;
  const media = [{ kind: 'snapshot' as const, ref, mimeType: 'image/jpeg' }];
  const obj: WorldObject = {
    id: over.id ?? `camera:public-cameras:${pack}:C0150201`,
    type: 'camera',
    sourceRefs: [],
    observedAt: '2026-09-21T08:00:00.000Z',
    updatedAt: '2026-09-21T08:00:00.000Z',
    freshness: 'LIVE',
    confidence: 0.9,
    labels: { name: 'vt1 Espoo (view 01)' },
    properties: { pack, frameUrl: over.frameUrl ?? 'https://weathercam.digitraffic.fi/C0150201.jpg', refreshSeconds: 600, attribution: 'Fintraffic / digitraffic.fi, license CC BY 4.0', ...(over.mediaInProperties === false ? {} : { media }) },
    provenance: { providerId: 'public-cameras', sourceName: 'Public cameras', origin: 'live', receivedAt: '2026-09-21T08:00:00.000Z' },
  };
  if (over.mediaInProperties === false) obj.media = media;
  return obj;
}

test('frame host allowlist accepts only https URLs on the pack host without credentials', () => {
  const hosts = PUBLIC_FRAME_HOSTS['fintraffic']!;
  assert.equal(isAllowedFrameUrl('https://weathercam.digitraffic.fi/C0150201.jpg', hosts), true);
  assert.equal(isAllowedFrameUrl('http://weathercam.digitraffic.fi/C0150201.jpg', hosts), false);
  assert.equal(isAllowedFrameUrl('https://evil.example/C0150201.jpg', hosts), false);
  assert.equal(isAllowedFrameUrl('https://weathercam.digitraffic.fi.evil.example/x.jpg', hosts), false);
  assert.equal(isAllowedFrameUrl('https://u:p@weathercam.digitraffic.fi/x.jpg', hosts), false);
  assert.equal(isAllowedFrameUrl('not a url', hosts), false);
});

test('publicCameraFromObject reads media from WorldObject.media or the payload fallback and enforces the allowlist', () => {
  const fromMedia = publicCameraFromObject(cameraObject({ mediaInProperties: false }));
  assert.equal(fromMedia?.ref, 'public:fintraffic:C0150201');
  assert.equal(fromMedia?.cameraId, 'C0150201');
  assert.equal(fromMedia?.refreshSeconds, 600);
  assert.equal(fromMedia?.name, 'vt1 Espoo (view 01)');
  const fromPayload = publicCameraFromObject(cameraObject());
  assert.equal(fromPayload?.frameUrl, 'https://weathercam.digitraffic.fi/C0150201.jpg');
  assert.equal(publicCameraFromObject(cameraObject({ frameUrl: 'https://evil.example/x.jpg' })), undefined);
  assert.equal(publicCameraFromObject(cameraObject({ pack: 'unknown-pack' })), undefined);
  assert.equal(publicCameraFromObject(cameraObject({ ref: 'public:nsw:C0150201' })), undefined, 'ref pack must match payload pack');
  assert.equal(publicCameraFromObject({ ...cameraObject(), type: 'aircraft' }), undefined);
});

test('registry sync/upsert/remove', () => {
  const reg = new PublicFrameRegistry();
  const r = reg.syncFromObjects([cameraObject(), cameraObject({ id: 'camera:public-cameras:fintraffic:bad', frameUrl: 'https://evil.example/x.jpg' })]);
  assert.deepEqual(r, { accepted: 1, rejected: 1 });
  assert.equal(reg.size(), 1);
  assert.ok(reg.get('public:fintraffic:C0150201'));
  assert.equal(reg.upsertFromObject(cameraObject({ id: 'camera:public-cameras:nsw:42', pack: 'nsw', frameUrl: 'https://webcams.transport.nsw.gov.au/a.jpg', ref: 'public:nsw:42' })), true);
  assert.equal(reg.size(), 2);
  reg.removeObject('camera:public-cameras:nsw:42');
  assert.equal(reg.size(), 1);
  assert.equal(reg.upsertFromObject(cameraObject({ frameUrl: 'https://evil.example/x.jpg' })), false, 'a later bad update evicts the entry');
  assert.equal(reg.size(), 0);
});

test('hub routes registrations by scheme and snapshots by id shape; public frames use our own User-Agent', async () => {
  const fetchBytes = fakeByteFetcher((url, opts) => {
    if (url.includes('webcams.transport.nsw.gov.au')) return /^Mozilla/.test(opts.headers?.['User-Agent'] ?? '') ? { bytes: JPEG_BYTES } : { bytes: HTML_BYTES, headers: { 'content-type': 'text/html' } };
    return { bytes: JPEG_BYTES };
  });
  const relay = new CameraRelay({ fetchBytes, openUpstream: fakeUpstreamOpener(() => ({ chunks: [] })) });
  const direct = new DirectGateway({ fetchBytes, secrets: new MemorySecretStore(), relay });
  const publicFrames = new PublicFrameRegistry();
  publicFrames.syncFromObjects([cameraObject(), cameraObject({ id: 'camera:public-cameras:nsw:42', pack: 'nsw', frameUrl: 'https://webcams.transport.nsw.gov.au/a.jpg', ref: 'public:nsw:42' })]);
  const hub = new CameraHub({ direct, publicFrames, fetchBytes, relay });
  await relay.start();
  try {
    await assert.rejects(hub.register({ name: 'rtsp', url: 'rtsp://cam/live' }), (e: unknown) => e instanceof CameraError && e.code === 'UNSUPPORTED_SCHEME');
    const local = await hub.register({ name: 'local', url: 'http://cam/snap.jpg' });
    assert.equal(local.gateway, 'direct');
    assert.equal((await hub.snapshot(local.cameraId)).mimeType, 'image/jpeg');
    assert.equal((await hub.list()).length, 1);

    const fin = await hub.snapshot('public:fintraffic:C0150201');
    assert.equal(fin.cameraId, 'public:fintraffic:C0150201');
    assert.equal(fin.mimeType, 'image/jpeg');
    const call = fetchBytes.calls.find((c) => c.url.includes('digitraffic'))!;
    assert.match(call.headers['User-Agent'] ?? '', /^WorldView\//);
    assert.equal(call.headers['Authorization'], undefined);

    // The NSW host answers non-browser clients with an HTML placeholder: we do NOT impersonate a browser; the frame is unavailable.
    await assert.rejects(hub.snapshot('public:nsw:42'), (e: unknown) => e instanceof CameraError && e.code === 'NOT_AN_IMAGE');
    assert.equal(hub.publicFrameHealth('public:nsw:42').status, 'unavailable');
    assert.ok(fetchBytes.calls.every((c) => !/^Mozilla/.test(c.headers['User-Agent'] ?? '')), 'never sends a browser User-Agent');

    await assert.rejects(hub.snapshot('public:fintraffic:NOPE'), (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND');
    await assert.rejects(hub.snapshot('public:evil:x'), (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND');
    await assert.rejects(hub.snapshot('https://weathercam.digitraffic.fi/C0150201.jpg'), (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND', 'raw URLs are never accepted');

    const stream = await hub.stream('public:fintraffic:C0150201');
    assert.equal(stream.kind, 'snapshot-poll');
    const res = await fetch(stream.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    const status = await hub.status();
    assert.equal(status.publicCameras, 2);
    assert.equal(status.direct.state, 'ready');
    assert.equal(status.go2rtc, undefined);
    await hub.unregister(local.cameraId);
    assert.equal((await hub.list()).length, 0);
  } finally {
    await relay.stop();
  }
});
