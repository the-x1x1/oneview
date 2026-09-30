import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_RANGE_BYTES, PACK_BASEMAP_ROUTE, packBasemapResponse, parseRange } from './pack-basemap.js';

const request = (range?: string) =>
  new Request(`worldview://app${PACK_BASEMAP_ROUTE}?pack=x`, range ? { headers: { Range: range } } : {});

test('parseRange: the forms a PMTiles reader sends, and what is refused', () => {
  assert.deepEqual(parseRange('bytes=0-126', 1000), { start: 0, end: 126 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=990-2000', 1000), { start: 990, end: 999 }, 'clipped to the end');
  assert.equal(parseRange('bytes=1000-', 1000), undefined, 'past the end');
  assert.equal(parseRange('bytes=5-2', 1000), undefined);
  assert.equal(parseRange('bytes=0-1,5-6', 1000), undefined, 'one range only');
  assert.equal(parseRange('items=0-1', 1000), undefined);
});

test('the pack basemap: 206 with exactly the bytes asked for; 404 without a pack; 416 past the end', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wv-pack-'));
  const file = path.join(dir, 'basemap.pmtiles');
  const data = new Uint8Array(4096).map((_, i) => i % 251);
  await writeFile(file, data);
  const r = await packBasemapResponse(request('bytes=100-199'), file);
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/4096');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), data.subarray(100, 200));
  const whole = await packBasemapResponse(request(), file);
  assert.equal(whole.status, 200);
  assert.equal((await whole.arrayBuffer()).byteLength, 4096);
  assert.equal((await packBasemapResponse(request('bytes=0-1'), undefined)).status, 404, 'no pack installed');
  assert.equal((await packBasemapResponse(request('bytes=0-1'), path.join(dir, 'gone'))).status, 404);
  const past = await packBasemapResponse(request('bytes=5000-'), file);
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */4096');
  assert.ok(MAX_RANGE_BYTES >= 1024 * 1024, 'a directory or a tile always fits');
});
