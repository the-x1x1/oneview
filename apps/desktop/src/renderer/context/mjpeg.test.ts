import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJpegFrames, readMjpeg } from './mjpeg.js';

const JPEG_A = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const JPEG_B = new Uint8Array([0xff, 0xd8, 9, 0xff, 0x00, 8, 0xff, 0xd9]);
const part = (jpeg: Uint8Array) =>
  new Uint8Array([...new TextEncoder().encode('--b\r\nContent-Type: image/jpeg\r\n\r\n'), ...jpeg, 13, 10]);

test('whole JPEGs are cut from a multipart stream at their markers; a partial one is kept for the next chunk', () => {
  const stream = new Uint8Array([...part(JPEG_A), ...part(JPEG_B)]);
  const all = extractJpegFrames(stream);
  assert.deepEqual(
    all.frames.map((f) => [...f]),
    [[...JPEG_A], [...JPEG_B]],
  );
  // Split mid-marker: FF | D8.
  const cutAt = part(JPEG_A).length + part(JPEG_B).indexOf(0xd8);
  const first = extractJpegFrames(stream.slice(0, cutAt));
  assert.equal(first.frames.length, 1);
  const second = extractJpegFrames(new Uint8Array([...first.rest, ...stream.slice(cutAt)]));
  assert.deepEqual(
    second.frames.map((f) => [...f]),
    [[...JPEG_B]],
    'the split marker is found',
  );
});

test('readMjpeg delivers frames and says when the stream ends, and how much it gave', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(part(JPEG_A).slice(0, 20));
      c.enqueue(part(JPEG_A).slice(20));
      c.enqueue(part(JPEG_B));
      c.close();
    },
  });
  const frames: number[][] = [];
  let dropped: number | undefined;
  await readMjpeg(
    'http://127.0.0.1:1/cam/x/y',
    { onFrame: (f) => frames.push([...f]), onDrop: (n) => (dropped = n) },
    new AbortController().signal,
    (async () => new Response(body)) as unknown as typeof fetch,
  );
  assert.deepEqual(frames, [[...JPEG_A], [...JPEG_B]]);
  assert.equal(dropped, 2);
  let failed: number | undefined;
  await readMjpeg(
    'http://127.0.0.1:1/cam/x/y',
    { onFrame: () => undefined, onDrop: (n) => (failed = n) },
    new AbortController().signal,
    (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch,
  );
  assert.equal(failed, 0, 'a refused connection is a drop with no frames');
  let aborted = false;
  const abort = new AbortController();
  abort.abort();
  await readMjpeg(
    'http://127.0.0.1:1/cam/x/y',
    { onFrame: () => undefined, onDrop: () => (aborted = true) },
    abort.signal,
    (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch,
  );
  assert.equal(aborted, false, 'closing the panel is not a drop');
});
