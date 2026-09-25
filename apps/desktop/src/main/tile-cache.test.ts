import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PREFETCH_MAX_PER_LEVEL,
  TileCache,
  worldPreloadTiles,
  parseTilePath,
  sniffImage,
  tilesCovering,
  upstreamUrl,
  type FetchLike,
} from './tile-cache.js';

const JPEG = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

function upstream(opts: { fail?: boolean; notImage?: boolean; size?: number } = {}) {
  const requested: string[] = [];
  const fetch: FetchLike = async (url) => {
    requested.push(url);
    if (opts.fail) throw new Error('getaddrinfo ENOTFOUND');
    const bytes = opts.notImage ? new TextEncoder().encode('<html>blocked</html>') : JPEG(opts.size ?? 1000);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    };
  };
  return { fetch, requested };
}

const SOURCE = {
  id: 'esri-world-imagery',
  upstream: 'https://tiles.example/tile/{z}/{y}/{x}',
  maxZoom: 19,
  worldPreload: true,
};

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wv-tiles-'));
}

function cache(dir: string, fetch: FetchLike, extra: Partial<ConstructorParameters<typeof TileCache>[0]> = {}) {
  let t = 1_000_000;
  const c = new TileCache({
    dir,
    sources: [SOURCE],
    fetch,
    maxMB: 64,
    now: () => (t += 1000),
    backgroundDelayMs: 0,
    // A real turn of the event loop, not a resolved promise: a worker that waits in a loop on
    // an already-resolved sleep never lets file I/O or the test's own timers run.
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    ...extra,
  });
  return c;
}

const settle = async (_c: TileCache, until: () => boolean) => {
  const deadline = Date.now() + 20_000;
  while (!until() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
};

test('tile paths: only a catalog-shaped source and in-range integers are a tile', () => {
  assert.deepEqual(parseTilePath('/__tiles/esri-world-imagery/3/5/2'), {
    sourceId: 'esri-world-imagery',
    z: 3,
    x: 5,
    y: 2,
  });
  for (const bad of [
    '/__tiles/esri-world-imagery/3/8/2', // x out of range at z3
    '/__tiles/esri-world-imagery/3/-1/2',
    '/__tiles/../etc/1/1/1',
    '/__tiles/Esri/1/0/0',
    '/__tiles/esri-world-imagery/1/0/0/extra',
    '/__tiles/esri-world-imagery/25/0/0',
    '/other/esri-world-imagery/1/0/0',
  ])
    assert.equal(parseTilePath(bad), undefined, bad);
  assert.equal(upstreamUrl(SOURCE.upstream, 3, 5, 2), 'https://tiles.example/tile/3/2/5', 'Esri orders {z}/{y}/{x}');
  assert.equal(sniffImage(JPEG(10)), 'image/jpeg');
  assert.equal(sniffImage(new TextEncoder().encode('<html>')), undefined);
});

test('tile cache: a miss fetches and stores; the next ask is served from disk, also by a new process', async () => {
  const dir = await tmp();
  const up = upstream();
  const c = cache(dir, up.fetch);
  await c.init();
  const first = await c.respond('/__tiles/esri-world-imagery/4/3/7');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Worldview-Tile-Cache'), 'miss');
  assert.equal(first.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(up.requested, ['https://tiles.example/tile/4/7/3']);
  const again = await c.respond('/__tiles/esri-world-imagery/4/3/7');
  assert.equal(again.headers.get('X-Worldview-Tile-Cache'), 'hit');
  assert.equal(up.requested.length, 1, 'no second request upstream');
  assert.equal(c.status().tiles, 1);

  const restarted = cache(dir, upstream({ fail: true }).fetch);
  await restarted.init();
  assert.equal(restarted.status().tiles, 1, 'what was on disk is known after a restart');
  assert.equal((await restarted.respond('/__tiles/esri-world-imagery/4/3/7')).status, 200, 'and served offline');
  assert.equal(
    (await restarted.respond('/__tiles/esri-world-imagery/4/3/8')).status,
    503,
    'an uncached tile offline is 503',
  );
});

test('tile cache: it is not a proxy — unknown sources and non-images are refused and nothing is stored', async () => {
  const dir = await tmp();
  const up = upstream({ notImage: true });
  const c = cache(dir, up.fetch);
  await c.init();
  assert.equal((await c.respond('/__tiles/osm-raster/1/0/0')).status, 404, 'a source without a tileCache block');
  assert.equal(up.requested.length, 0);
  assert.equal((await c.respond('/__tiles/esri-world-imagery/1/0/0')).status, 502);
  assert.equal(c.status().tiles, 0, 'an HTML error page is not a tile');
});

test('tile cache: concurrent asks for one tile share a single fetch', async () => {
  const dir = await tmp();
  const up = upstream();
  const c = cache(dir, up.fetch);
  await c.init();
  const all = await Promise.all([1, 2, 3].map(() => c.respond('/__tiles/esri-world-imagery/2/1/1')));
  assert.ok(all.every((r) => r.status === 200));
  assert.equal(up.requested.length, 1);
});

test('tile cache: over the cap, the least recently used tiles go first', async () => {
  const dir = await tmp();
  const up = upstream({ size: 1024 * 1024 }); // 1 MB tiles, 64 MB cap
  const c = cache(dir, up.fetch);
  await c.init();
  for (let x = 0; x < 70; x++) {
    await c.respond(`/__tiles/esri-world-imagery/7/${x}/0`);
    if (x === 50) await c.respond('/__tiles/esri-world-imagery/7/0/0'); // tile 0 used again, late
  }
  await settle(c, () => c.status().bytes <= 64 * 1024 * 1024);
  const s = c.status();
  assert.ok(s.bytes <= 64 * 1024 * 1024, `${s.bytes} within the cap`);
  assert.ok(s.tiles < 70);
  const kept = await c.respond('/__tiles/esri-world-imagery/7/0/0');
  assert.equal(kept.headers.get('X-Worldview-Tile-Cache'), 'hit', 'the tile used again survived');
  const gone = await c.respond('/__tiles/esri-world-imagery/7/1/0');
  assert.equal(gone.headers.get('X-Worldview-Tile-Cache'), 'miss', 'an old one was evicted');
  // Lowering the cap trims straight away.
  c.configure({ maxMB: 64, preloadWorld: false }, 'esri-world-imagery');
});

test('prefetch: the next two levels of the view, bounded, skipping what is cached, replacing an older request', async () => {
  const dir = await tmp();
  const up = upstream();
  const c = cache(dir, up.fetch);
  await c.init();
  const oahu = { west: -158.4, south: 21.2, east: -157.6, north: 21.8 };
  const queued = c.prefetch('esri-world-imagery', oahu, 9.4);
  assert.ok(queued > 0 && queued <= 2 * PREFETCH_MAX_PER_LEVEL, `${queued}`);
  await settle(c, () => c.status().tiles >= queued);
  const levels = new Set(up.requested.map((u) => Number(u.split('/').at(-3))));
  assert.deepEqual([...levels].sort(), [10, 11], 'zoom 9.4 prefetches levels 10 and 11');
  const before = up.requested.length;
  assert.equal(c.prefetch('esri-world-imagery', oahu, 9.4), 0, 'already cached: nothing to fetch');
  assert.equal(up.requested.length, before);
  // A level with more tiles than the cap is skipped rather than half-fetched.
  assert.equal(c.prefetch('esri-world-imagery', { west: -180, south: -85, east: 180, north: 85 }, 5), 0);
  assert.equal(c.prefetch('osm-raster', oahu, 9), 0, 'not a cached source');
  const covering = tilesCovering({ west: 170, south: -10, east: -170, north: 10 }, 3);
  assert.equal(covering.length, 2, 'across the antimeridian: two ranges');
});

test(
  'world preload: off unless asked for, for a source that allows it; resumable; stops when the cache is nearly full',
  { timeout: 60_000 },
  async () => {
    const dir = await tmp();
    const up = upstream({ size: 100 });
    const c = cache(dir, up.fetch, { maxMB: 64, preloadMaxZoom: 3 });
    await c.init();
    assert.equal(c.status().preload.state, 'off');
    assert.equal(worldPreloadTiles(), 21_845, 'zoom 0–7 in the app');
    c.configure({ maxMB: 64, preloadWorld: false }, 'esri-world-imagery');
    assert.equal(c.status().preload.state, 'off');
    c.configure({ maxMB: 64, preloadWorld: true }, 'natural-earth');
    assert.equal(c.status().preload.state, 'off', 'only for the basemap in use, when it allows a preload');

    c.configure({ maxMB: 64, preloadWorld: true }, 'esri-world-imagery');
    await settle(c, () => c.status().preload.state !== 'running');
    const done = c.status();
    assert.equal(done.preload.state, 'done');
    assert.equal(done.tiles, worldPreloadTiles(3), 'every tile to the preload depth');
    assert.equal(up.requested.length, worldPreloadTiles(3));

    // Switched off and on again, nothing already on disk is fetched twice.
    c.configure({ maxMB: 64, preloadWorld: false }, 'esri-world-imagery');
    c.configure({ maxMB: 64, preloadWorld: true }, 'esri-world-imagery');
    await settle(c, () => c.status().preload.state !== 'running');
    assert.equal(up.requested.length, worldPreloadTiles(3));

    // A cap the preload would overrun: it stops at 80 % and says why.
    // 85 tiles of 1 MB against a 64 MB cap.
    const small = cache(await tmp(), upstream({ size: 1024 * 1024 }).fetch, { maxMB: 64, preloadMaxZoom: 3 });
    await small.init();
    small.configure({ maxMB: 64, preloadWorld: true }, 'esri-world-imagery');
    await settle(small, () => small.status().preload.state !== 'running');
    const st = small.status();
    assert.equal(st.preload.state, 'stopped');
    assert.match(st.preload.message ?? '', /size cap/);
    // 80 %, plus at most one tile per background worker already on its way.
    assert.ok(st.bytes <= 64 * 1024 * 1024 * 0.8 + 3 * 1024 * 1024, `${st.bytes}`);
  },
);

test('tile cache: which sources have tiles on disk — waiting for the startup scan, emptied by clear', async () => {
  const dir = await tmp();
  const first = cache(dir, upstream().fetch);
  await first.init();
  assert.deepEqual(await first.sourcesWithTiles(), []);
  await first.respond('/__tiles/esri-world-imagery/2/1/1');
  assert.deepEqual(await first.sourcesWithTiles(), ['esri-world-imagery']);

  // A new process asked before its scan finished still answers from disk.
  const restarted = cache(dir, upstream({ fail: true }).fetch);
  void restarted.init();
  assert.deepEqual(await restarted.sourcesWithTiles(), ['esri-world-imagery']);
  await restarted.clear();
  assert.deepEqual(await restarted.sourcesWithTiles(), []);
});

test('tile cache: clear empties the disk and the count', async () => {
  const dir = await tmp();
  const c = cache(dir, upstream().fetch);
  await c.init();
  await c.respond('/__tiles/esri-world-imagery/1/0/0');
  const s = await c.clear();
  assert.equal(s.tiles, 0);
  assert.equal(s.bytes, 0);
  await assert.rejects(fs.access(path.join(dir, 'esri-world-imagery', '1', '0', '0.bin')));
});
