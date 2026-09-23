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
import { PUBLIC_CAMERA_FRAME_HOSTS } from '@worldview/provider-cctv-public';

test('gateway frame-host allowlist equals the provider pack definitions (defence in depth, kept in sync)', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(PUBLIC_FRAME_HOSTS).map(([k, v]) => [k, [...v]])),
    Object.fromEntries(Object.entries(PUBLIC_CAMERA_FRAME_HOSTS).map(([k, v]) => [k, [...v]])),
  );
});

function cameraObject(
  over: { id?: string; pack?: string; frameUrl?: string; ref?: string; mediaInProperties?: boolean } = {},
): WorldObject {
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
    properties: {
      pack,
      frameUrl: over.frameUrl ?? 'https://weathercam.digitraffic.fi/C0150201.jpg',
      refreshSeconds: 600,
      attribution: 'Fintraffic / digitraffic.fi, license CC BY 4.0',
      ...(over.mediaInProperties === false ? {} : { media }),
    },
    provenance: {
      providerId: 'public-cameras',
      sourceName: 'Public cameras',
      origin: 'live',
      receivedAt: '2026-09-21T08:00:00.000Z',
    },
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

test('a host-and-path entry pins a shared host to one prefix (TfL frames on S3)', () => {
  const hosts = PUBLIC_FRAME_HOSTS['tfl']!;
  assert.equal(isAllowedFrameUrl('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01101.jpg', hosts), true);
  assert.equal(isAllowedFrameUrl('https://s3-eu-west-1.amazonaws.com/another-bucket/x.jpg', hosts), false);
  assert.equal(
    isAllowedFrameUrl('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/../another/x.jpg', hosts),
    false,
  );
  assert.equal(isAllowedFrameUrl('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/a%2Fb.jpg', hosts), false);
  assert.equal(isAllowedFrameUrl('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk.evil/x.jpg', hosts), false);
  assert.equal(isAllowedFrameUrl('https://evil.example/jamcams.tfl.gov.uk/x.jpg', hosts), false);
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
  assert.equal(
    publicCameraFromObject(cameraObject({ ref: 'public:nsw:C0150201' })),
    undefined,
    'ref pack must match payload pack',
  );
  assert.equal(publicCameraFromObject({ ...cameraObject(), type: 'aircraft' }), undefined);
});

test('registry sync/upsert/remove', () => {
  const reg = new PublicFrameRegistry();
  const r = reg.syncFromObjects([
    cameraObject(),
    cameraObject({ id: 'camera:public-cameras:fintraffic:bad', frameUrl: 'https://evil.example/x.jpg' }),
  ]);
  assert.deepEqual(r, { accepted: 1, rejected: 1 });
  assert.equal(reg.size(), 1);
  assert.ok(reg.get('public:fintraffic:C0150201'));
  assert.equal(
    reg.upsertFromObject(
      cameraObject({
        id: 'camera:public-cameras:nsw:42',
        pack: 'nsw',
        frameUrl: 'https://webcams.transport.nsw.gov.au/a.jpg',
        ref: 'public:nsw:42',
      }),
    ),
    true,
  );
  assert.equal(reg.size(), 2);
  reg.removeObject('camera:public-cameras:nsw:42');
  assert.equal(reg.size(), 1);
  assert.equal(
    reg.upsertFromObject(cameraObject({ frameUrl: 'https://evil.example/x.jpg' })),
    false,
    'a later bad update evicts the entry',
  );
  assert.equal(reg.size(), 0);
});

test('hub routes registrations by scheme and snapshots by id shape; public frames use our own User-Agent', async () => {
  const fetchBytes = fakeByteFetcher((url, opts) => {
    if (url.includes('webcams.transport.nsw.gov.au'))
      return /^Mozilla/.test(opts.headers?.['User-Agent'] ?? '')
        ? { bytes: JPEG_BYTES }
        : { bytes: HTML_BYTES, headers: { 'content-type': 'text/html' } };
    return { bytes: JPEG_BYTES };
  });
  const relay = new CameraRelay({ fetchBytes, openUpstream: fakeUpstreamOpener(() => ({ chunks: [] })) });
  const direct = new DirectGateway({ fetchBytes, secrets: new MemorySecretStore(), relay });
  const publicFrames = new PublicFrameRegistry();
  publicFrames.syncFromObjects([
    cameraObject(),
    cameraObject({
      id: 'camera:public-cameras:nsw:42',
      pack: 'nsw',
      frameUrl: 'https://webcams.transport.nsw.gov.au/a.jpg',
      ref: 'public:nsw:42',
    }),
  ]);
  const hub = new CameraHub({ direct, publicFrames, fetchBytes, relay });
  await relay.start();
  try {
    await assert.rejects(
      hub.register({ name: 'rtsp', url: 'rtsp://cam/live' }),
      (e: unknown) => e instanceof CameraError && e.code === 'UNSUPPORTED_SCHEME',
    );
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
    await assert.rejects(
      hub.snapshot('public:nsw:42'),
      (e: unknown) => e instanceof CameraError && e.code === 'NOT_AN_IMAGE',
    );
    assert.equal(hub.publicFrameHealth('public:nsw:42').status, 'unavailable');
    assert.ok(
      fetchBytes.calls.every((c) => !/^Mozilla/.test(c.headers['User-Agent'] ?? '')),
      'never sends a browser User-Agent',
    );

    await assert.rejects(
      hub.snapshot('public:fintraffic:NOPE'),
      (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND',
    );
    await assert.rejects(
      hub.snapshot('public:evil:x'),
      (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND',
    );
    await assert.rejects(
      hub.snapshot('https://weathercam.digitraffic.fi/C0150201.jpg'),
      (e: unknown) => e instanceof CameraError && e.code === 'NOT_FOUND',
      'raw URLs are never accepted',
    );

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

test('hub follows a public frame redirect only to where the same pack may serve frames', async () => {
  const fetchBytes = fakeByteFetcher((url) => {
    // Hong Kong: the stable URL redirects to the current frame on the same host.
    if (url === 'https://tdcctv.data.one.gov.hk/H109F.JPG')
      return { status: 302, headers: { location: '/H109F-20260923.JPG' } };
    if (url === 'https://tdcctv.data.one.gov.hk/H109F-20260923.JPG') return { bytes: JPEG_BYTES };
    // A camera whose host redirects somewhere else.
    if (url === 'https://tdcctv.data.one.gov.hk/K107F.JPG')
      return { status: 301, headers: { location: 'https://evil.example/K107F.JPG' } };
    // Iceland: the pin is a path prefix; a redirect out of it is refused like one off the host.
    if (url === 'https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg')
      return { status: 302, headers: { location: 'https://www.vegagerdin.is/admin/login' } };
    // Endless redirects stop after two hops.
    if (url.startsWith('https://tdcctv.data.one.gov.hk/LOOP')) {
      const n = Number(url.match(/LOOP(\d+)/)?.[1] ?? 0);
      return { status: 302, headers: { location: `/LOOP${n + 1}.JPG` } };
    }
    return { status: 404 };
  });
  const relay = new CameraRelay({ fetchBytes, openUpstream: fakeUpstreamOpener(() => ({ chunks: [] })) });
  const direct = new DirectGateway({ fetchBytes, secrets: new MemorySecretStore(), relay });
  const publicFrames = new PublicFrameRegistry();
  const hk = (key: string) =>
    cameraObject({
      id: `camera:public-cameras:hongkong:${key}`,
      pack: 'hongkong',
      frameUrl: `https://tdcctv.data.one.gov.hk/${key}.JPG`,
      ref: `public:hongkong:${key}`,
    });
  publicFrames.syncFromObjects([
    hk('H109F'),
    hk('K107F'),
    hk('LOOP0'),
    cameraObject({
      id: 'camera:public-cameras:iceland:hellisheidi_1',
      pack: 'iceland',
      frameUrl: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg',
      ref: 'public:iceland:hellisheidi_1',
    }),
  ]);
  assert.equal(publicFrames.size(), 4);
  const hub = new CameraHub({ direct, publicFrames, fetchBytes, relay });
  const frame = await hub.snapshot('public:hongkong:H109F');
  assert.equal(frame.mimeType, 'image/jpeg');
  for (const ref of ['public:hongkong:K107F', 'public:iceland:hellisheidi_1']) {
    await assert.rejects(
      hub.snapshot(ref),
      (e: unknown) => e instanceof CameraError && e.code === 'UPSTREAM_ERROR',
      ref,
    );
  }
  assert.ok(!fetchBytes.calls.some((c) => c.url.includes('evil.example') || c.url.includes('/admin/')));
  await assert.rejects(hub.snapshot('public:hongkong:LOOP0'), (e: unknown) => e instanceof CameraError);
  assert.equal(fetchBytes.calls.filter((c) => c.url.includes('LOOP')).length, 3, 'the first request and two hops');
});
