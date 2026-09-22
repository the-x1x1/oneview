import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraError } from './errors.js';
import { cameraIdFor, inferKind, parseCameraUrl } from './url.js';
import { detectImageType, firstJpegFrame } from './image.js';
import { JPEG_BYTES, PNG_BYTES, HTML_BYTES, mjpegChunks } from './testing.js';

const HTTP = ['http', 'https'] as const;

test('parseCameraUrl strips credentials and returns them separately', () => {
  const p = parseCameraUrl('http://admin:s3cret%40x@192.168.1.10:8080/snapshot.jpg?res=hd#frag', HTTP);
  assert.equal(p.url, 'http://192.168.1.10:8080/snapshot.jpg?res=hd');
  assert.deepEqual(p.credential, { username: 'admin', password: 's3cret@x' });
  assert.equal(p.kind, 'snapshot');
  assert.equal(p.port, 8080);
  assert.ok(!p.url.includes('s3cret'));
});

test('parseCameraUrl rejects non-camera and disallowed schemes with typed errors', () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://cam/x.jpg', 'data:image/jpeg;base64,xx']) {
    assert.throws(
      () => parseCameraUrl(bad, HTTP),
      (e: unknown) => e instanceof CameraError && e.code === 'UNSUPPORTED_SCHEME',
      bad,
    );
  }
  assert.throws(
    () => parseCameraUrl('rtsp://cam/live', HTTP),
    (e: unknown) => e instanceof CameraError && e.code === 'UNSUPPORTED_SCHEME' && /go2rtc/.test(e.message),
  );
  assert.throws(
    () => parseCameraUrl('not a url', HTTP),
    (e: unknown) => e instanceof CameraError && e.code === 'INVALID_URL',
  );
  assert.throws(
    () => parseCameraUrl('', HTTP),
    (e: unknown) => e instanceof CameraError && e.code === 'INVALID_URL',
  );
  assert.throws(
    () => parseCameraUrl('http://', HTTP),
    (e: unknown) => e instanceof CameraError,
  );
  const rtsp = parseCameraUrl('rtsp://user:pw@cam.local:554/stream1', ['rtsp', 'rtsps']);
  assert.equal(rtsp.kind, 'rtsp');
  assert.equal(rtsp.url, 'rtsp://cam.local:554/stream1');
});

test('camera ids are deterministic and independent of credentials/case/fragment', () => {
  const a = cameraIdFor(parseCameraUrl('HTTP://Cam.Local/snap.jpg#x', HTTP).url);
  const b = cameraIdFor(parseCameraUrl('http://user:pw@cam.local/snap.jpg', HTTP).url);
  const c = cameraIdFor(parseCameraUrl('http://cam.local/other.jpg', HTTP).url);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('source kind inference', () => {
  const k = (u: string) => inferKind(new URL(u).protocol.replace(':', ''), new URL(u));
  assert.equal(k('https://cam/live/index.m3u8'), 'hls');
  assert.equal(k('http://cam/video.mjpg'), 'mjpeg');
  assert.equal(k('http://cam/mjpeg/1'), 'mjpeg');
  assert.equal(k('http://cam/cgi-bin/mjpg/video.cgi?channel=1&subtype=1'), 'mjpeg');
  assert.equal(k('http://cam/axis-cgi/mjpg/video.cgi'), 'mjpeg');
  assert.equal(k('http://cam/videostream.cgi?action=stream'), 'mjpeg');
  assert.equal(k('http://cam/snapshot.jpg'), 'snapshot');
  assert.equal(k('http://cam/cgi-bin/snapshot.cgi'), 'snapshot');
  assert.equal(k('rtsp://cam/live'), 'rtsp');
});

test('image magic detection and MJPEG first-frame extraction', async () => {
  assert.equal(detectImageType(JPEG_BYTES), 'image/jpeg');
  assert.equal(detectImageType(PNG_BYTES), 'image/png');
  assert.equal(detectImageType(HTML_BYTES), undefined);
  async function* body(): AsyncGenerator<Uint8Array> {
    for (const c of mjpegChunks(3)) yield c;
  }
  const frame = await firstJpegFrame(body(), 1024 * 1024);
  assert.deepEqual([...frame], [...JPEG_BYTES]);
  async function* split(): AsyncGenerator<Uint8Array> {
    const all = Buffer.concat(mjpegChunks(1));
    for (let i = 0; i < all.length; i += 5) yield all.subarray(i, i + 5);
  }
  assert.deepEqual([...(await firstJpegFrame(split(), 1024))], [...JPEG_BYTES]);
  async function* noise(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 10; i++) yield new Uint8Array(100);
  }
  await assert.rejects(
    firstJpegFrame(noise(), 500),
    (e: unknown) => e instanceof CameraError && e.code === 'TOO_LARGE',
  );
});
