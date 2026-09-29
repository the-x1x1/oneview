import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WmtsOverlay } from '@worldview/world-model';
import { ensureWmtsProtocol, setWmtsProtocolOverlays, wmtsProtocolTiles } from './wmts-protocol.js';
import type { ProtocolLoader } from './maplibre-like.js';

// Invented descriptor in the shape the wmts connector publishes for a GIBS layer.
const ir = {
  kind: 'wmts',
  id: 'gibs:ir',
  providerId: 'gibs',
  name: 'Infrared',
  attribution: 'test',
  url: 'https://tiles.example.invalid/ir/{TileMatrix}/{TileRow}/{TileCol}.png',
  layer: 'ir',
  style: 'default',
  format: 'image/png',
  tileMatrixSet: 'GoogleMapsCompatible_Level6',
  fadeBelow: { from: 110, to: 170 },
} as unknown as WmtsOverlay;

test('wvwmts: a clouds-only overlay is fetched, then faded with its own ramp', async () => {
  let loader: ProtocolLoader | undefined;
  const maplibre = { addProtocol: (_name: string, l: ProtocolLoader) => void (loader = l) };
  const fetched: string[] = [];
  const faded: Array<{ from: number; to: number }> = [];
  const fetchImpl = (async (url: string) => {
    fetched.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;
  ensureWmtsProtocol(maplibre, fetchImpl, async (bytes, ramp) => {
    faded.push(ramp);
    return bytes;
  });
  setWmtsProtocolOverlays([ir]);
  const tile = wmtsProtocolTiles(ir)[0]!.replace('{z}', '3').replace('{x}', '2').replace('{y}', '1');
  const answer = await loader!({ url: tile, type: 'arrayBuffer' }, new AbortController());
  assert.deepEqual(fetched, ['https://tiles.example.invalid/ir/3/1/2.png']);
  assert.deepEqual(faded, [{ from: 110, to: 170 }]);
  assert.equal((answer.data as ArrayBuffer).byteLength, 3);
});

test('wvwmts: a tile the frame lacks (404) comes from the frame before it; other failures stay failures', async () => {
  let loader: ProtocolLoader | undefined;
  const maplibre = { addProtocol: (_name: string, l: ProtocolLoader) => void (loader = l) };
  const fetched: string[] = [];
  let status = 404;
  const fetchImpl = (async (url: string) => {
    fetched.push(url);
    return url.includes('/prev/') ? new Response(new Uint8Array([7]), { status: 200 }) : new Response('no', { status });
  }) as unknown as typeof fetch;
  ensureWmtsProtocol(maplibre, fetchImpl, async (bytes) => bytes);
  const withPrevious = {
    ...ir,
    id: 'gibs:ir:now',
    fallbackUrl: 'https://tiles.example.invalid/prev/{TileMatrix}/{TileRow}/{TileCol}.png',
  } as WmtsOverlay;
  setWmtsProtocolOverlays([withPrevious]);
  const tile = wmtsProtocolTiles(withPrevious)[0]!.replace('{z}', '3').replace('{x}', '2').replace('{y}', '1');
  const answer = await loader!({ url: tile, type: 'arrayBuffer' }, new AbortController());
  assert.deepEqual(fetched, [
    'https://tiles.example.invalid/ir/3/1/2.png',
    'https://tiles.example.invalid/prev/3/1/2.png',
  ]);
  assert.equal((answer.data as ArrayBuffer).byteLength, 1);
  status = 500;
  fetched.length = 0;
  await assert.rejects(loader!({ url: tile, type: 'arrayBuffer' }, new AbortController()), /HTTP 500/);
  assert.equal(fetched.length, 1, 'a server error is not a missing tile');
});
