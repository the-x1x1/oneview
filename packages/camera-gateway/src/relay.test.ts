import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import { CameraRelay } from './relay.js';
import { hlsBaseFor, rewritePlaylist, containedRelativePath, resolveContained } from './hls.js';
import { fakeByteFetcher, fakeUpstreamOpener, JPEG_BYTES, HTML_BYTES, mjpegChunks } from './testing.js';

const TOKEN = 'a'.repeat(32);
const CAM = '0123456789ab';
const SECRET_HEADER = 'Basic ' + Buffer.from('admin:topsecret').toString('base64');

function relayWith(opts: { max?: number; playlist?: string; slow?: boolean } = {}) {
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink] });
  const fetchBytes = fakeByteFetcher((url) => {
    if (url.endsWith('.m3u8'))
      return {
        body:
          opts.playlist ??
          '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg1.ts\n#EXTINF:2.0,\nsub/seg2.ts?tok=1\n#EXTINF:2.0,\n../escape.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-ENDLIST\n',
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      };
    if (url.includes('/html')) return { bytes: HTML_BYTES, headers: { 'content-type': 'image/jpeg' } };
    if (url.includes('/500')) return { status: 500 };
    if (url.includes('/403')) return { status: 403 };
    if (url.includes('/timeout')) return { error: 'timeout' };
    return { bytes: JPEG_BYTES, headers: { 'content-type': 'image/jpeg' } };
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const openUpstream = fakeUpstreamOpener((url) => {
    if (/\.ts(\?|$)/.test(url))
      return { headers: { 'content-type': 'video/mp2t' }, chunks: [new Uint8Array([1, 2, 3])] };
    if (url.includes('/html')) return { headers: { 'content-type': 'text/html' }, chunks: [HTML_BYTES] };
    if (opts.slow)
      return {
        chunks: async function* () {
          yield mjpegChunks(1)[1]!;
          await gate;
        },
      };
    return { chunks: mjpegChunks(3) };
  });
  const relay = new CameraRelay({
    fetchBytes,
    openUpstream,
    logger: hub.logger('camera'),
    token: () => TOKEN,
    ...(opts.max !== undefined ? { maxConcurrentStreams: opts.max } : {}),
  });
  const headers = async () => ({ Authorization: SECRET_HEADER, 'User-Agent': 'WorldView/test' });
  return { relay, sink, fetchBytes, openUpstream, headers, release: () => release?.() };
}

test('relay binds to 127.0.0.1 on a random port and answers 404 for unknown ids and wrong tokens', async () => {
  const { relay, headers } = relayWith();
  const port = await relay.start();
  try {
    assert.ok(port > 0);
    relay.add({ cameraId: CAM, url: 'http://cam.local/snap.jpg', kind: 'snapshot', headers });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/cam/${CAM}/${'b'.repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${base}/cam/ffffffffffff/${TOKEN}`)).status, 404);
    assert.equal((await fetch(`${base}/cam`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/cam/${CAM}/${TOKEN}`, { method: 'POST' })).status, 405);
    const ok = await fetch(relay.urlFor(CAM)!);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [...JPEG_BYTES]);
  } finally {
    await relay.stop();
  }
  assert.equal(relay.isListening(), false);
  assert.equal(relay.urlFor(CAM), undefined);
});

test('relay streams a fake MJPEG upstream with credential injection and never logs the header', async () => {
  const { relay, sink, openUpstream, headers } = relayWith();
  await relay.start();
  try {
    relay.add({ cameraId: CAM, url: 'http://cam.local/video.mjpg', kind: 'mjpeg', headers });
    const res = await fetch(relay.urlFor(CAM)!);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^multipart\/x-mixed-replace/);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(body.byteLength, Buffer.concat(mjpegChunks(3)).byteLength);
    assert.equal(openUpstream.calls[0]!.headers['Authorization'], SECRET_HEADER);
    const logs = JSON.stringify(sink.records);
    assert.ok(!logs.includes('topsecret') && !logs.includes(SECRET_HEADER), 'credential appeared in logs');
    assert.ok(!logs.includes('cam.local'), 'upstream host appeared in logs');
    assert.ok(relay.activeStreams() === 0);
  } finally {
    await relay.stop();
  }
});

test('relay refuses non-media upstream bodies and maps upstream failures to typed statuses', async () => {
  const { relay, headers } = relayWith();
  await relay.start();
  try {
    relay.add({ cameraId: CAM, url: 'http://cam.local/html', kind: 'mjpeg', headers });
    assert.equal((await fetch(relay.urlFor(CAM)!)).status, 502);
    relay.add({ cameraId: 'aaaaaaaaaaaa', url: 'http://cam.local/html', kind: 'snapshot', headers });
    assert.equal((await fetch(relay.urlFor('aaaaaaaaaaaa')!)).status, 502);
    relay.add({ cameraId: 'bbbbbbbbbbbb', url: 'http://cam.local/500', kind: 'snapshot', headers });
    assert.equal((await fetch(relay.urlFor('bbbbbbbbbbbb')!)).status, 502);
    relay.add({ cameraId: 'cccccccccccc', url: 'http://cam.local/403', kind: 'snapshot', headers });
    const refused = await fetch(relay.urlFor('cccccccccccc')!);
    assert.equal(refused.status, 502);
    assert.equal(await refused.text(), 'frame unavailable');
    relay.add({ cameraId: 'dddddddddddd', url: 'http://cam.local/timeout', kind: 'snapshot', headers });
    assert.equal((await fetch(relay.urlFor('dddddddddddd')!)).status, 504);
  } finally {
    await relay.stop();
  }
});

test('relay caps concurrent upstream streams', async () => {
  const { relay, headers, release } = relayWith({ max: 1, slow: true });
  await relay.start();
  try {
    relay.add({ cameraId: CAM, url: 'http://cam.local/video.mjpg', kind: 'mjpeg', headers });
    const first = fetch(relay.urlFor(CAM)!);
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    assert.equal(relay.activeStreams(), 1);
    const second = await fetch(relay.urlFor(CAM)!);
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '1');
    release();
    await firstRes.arrayBuffer();
  } finally {
    await relay.stop();
  }
});

test('relay rewrites HLS playlists to relay paths and refuses references outside the registered directory', async () => {
  const { relay, headers, fetchBytes, openUpstream } = relayWith();
  await relay.start();
  try {
    relay.add({ cameraId: CAM, url: 'https://cam.local/live/index.m3u8', kind: 'hls', headers });
    const url = relay.urlFor(CAM)!;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    const text = await res.text();
    assert.ok(text.includes(`${url}/r/seg1.ts`));
    assert.ok(text.includes(`${url}/r/sub/seg2.ts?tok=1`));
    assert.ok(text.includes(`URI="${url}/r/key.bin"`));
    assert.ok(!text.includes('escape.ts'), 'escaping reference must be dropped');
    assert.ok(!text.includes('cam.local'), 'upstream host must not leak to the renderer');
    assert.equal(fetchBytes.calls[0]!.headers['Authorization'], SECRET_HEADER);

    const seg = await fetch(`${url}/r/sub/seg2.ts?tok=1`);
    assert.equal(seg.status, 200);
    assert.equal(seg.headers.get('content-type'), 'video/mp2t');
    assert.deepEqual([...new Uint8Array(await seg.arrayBuffer())], [1, 2, 3]);
    assert.equal(openUpstream.calls.at(-1)!.url, 'https://cam.local/live/sub/seg2.ts?tok=1');

    assert.equal((await fetch(`${url}/r/../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${url}/r/%2e%2e/escape.ts`)).status, 404);
    assert.equal((await fetch(`${url}/r/http://evil.example/x.ts`)).status, 404);
    assert.equal((await fetch(`${url}/r//evil.example/x.ts`)).status, 404);
    assert.ok(
      openUpstream.calls.every((c) => c.url.startsWith('https://cam.local/live/')),
      'relay must only contact the registered directory',
    );
    relay.add({ cameraId: 'eeeeeeeeeeee', url: 'http://cam.local/snap.jpg', kind: 'snapshot', headers });
    assert.equal((await fetch(`${relay.urlFor('eeeeeeeeeeee')!}/r/seg1.ts`)).status, 404, '/r/ is HLS-only');
  } finally {
    await relay.stop();
  }
});

test('relay refuses a camera that points at itself', async () => {
  const { relay, headers } = relayWith();
  const port = await relay.start();
  try {
    assert.throws(
      () => relay.add({ cameraId: CAM, url: `http://127.0.0.1:${port}/cam/x/y`, kind: 'snapshot', headers }),
      /relay itself/,
    );
  } finally {
    await relay.stop();
  }
});

test('hls containment helpers', () => {
  const base = hlsBaseFor('https://h.example/a/b/index.m3u8');
  assert.deepEqual(base, { origin: 'https://h.example', dir: '/a/b/' });
  assert.equal(containedRelativePath('seg.ts', 'https://h.example/a/b/index.m3u8', base), 'seg.ts');
  assert.equal(containedRelativePath('/a/b/c/seg.ts?x=1', 'https://h.example/a/b/index.m3u8', base), 'c/seg.ts?x=1');
  assert.equal(containedRelativePath('../seg.ts', 'https://h.example/a/b/index.m3u8', base), undefined);
  assert.equal(
    containedRelativePath('https://other.example/a/b/seg.ts', 'https://h.example/a/b/index.m3u8', base),
    undefined,
  );
  assert.equal(
    containedRelativePath('http://h.example/a/b/seg.ts', 'https://h.example/a/b/index.m3u8', base),
    undefined,
    'scheme downgrade is a different origin',
  );
  assert.equal(resolveContained('c/seg.ts', base), 'https://h.example/a/b/c/seg.ts');
  assert.equal(resolveContained('../x', base), undefined);
  assert.equal(resolveContained('/abs', base), undefined);
  assert.equal(resolveContained('//evil/x', base), undefined);
  const out = rewritePlaylist(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhttps://cdn.other/hi.m3u8\n',
    'https://h.example/a/b/index.m3u8',
    base,
    'http://127.0.0.1:1/cam/x/y',
  );
  assert.equal(
    out,
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://127.0.0.1:1/cam/x/y/r/low/index.m3u8\n',
    'off-origin variant and its tag line are dropped',
  );
});
