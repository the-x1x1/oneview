import { wmtsTileUrl, type WmtsOverlay } from '@worldview/world-model';
import {
  applyBrightnessFade,
  featherWeights,
  latitudeWeights,
  mendAntimeridianColumn,
  type FadeRamp,
} from '@worldview/render-core';
import type { MapLibreLike, ProtocolLoader } from './maplibre-like.js';

/**
 * `wvwmts://<overlay id>/{z}/{x}/{y}`: a Web Mercator WMTS whose matrices are not named by
 * the zoom written plainly (BKG TopPlusOpen's `00`…`18`). A MapLibre template can only say
 * `{z}`, so the source asks this protocol, which writes the service's own label for the
 * zoom into the tile URL and fetches it like any other tile (same https hosts, same CSP).
 */
export const WMTS_PROTOCOL = 'wvwmts';

const overlays = new Map<string, WmtsOverlay>();
/**
 * The list before the current one. A replaced radar or satellite frame stays on the map for a
 * few seconds under its successor (raster-overlays.ts FRAME_HANDOVER_MS) and still asks for
 * tiles as the camera moves; forgetting it at once made those requests fail.
 */
let previous = new Map<string, WmtsOverlay>();
const registered = new WeakSet<object>();

export function wmtsProtocolTiles(o: WmtsOverlay): string[] {
  return [`${WMTS_PROTOCOL}://${encodeURIComponent(o.id)}/{z}/{x}/{y}`];
}

/** The URL a `wvwmts://` request stands for, or undefined when it names nothing known. */
export function resolveWmtsProtocolUrl(url: string): string | undefined {
  return resolveWmtsProtocolTile(url)?.url;
}

function resolveWmtsProtocolTile(
  url: string,
): { url: string; overlay: WmtsOverlay; z: number; x: number; y: number } | undefined {
  const m = /^wvwmts:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]!);
  const o = overlays.get(id) ?? previous.get(id);
  if (!o) return undefined;
  const real = wmtsTileUrl(o, Number(m[2]), Number(m[3]), Number(m[4]));
  return real ? { url: real, overlay: o, z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) } : undefined;
}

/** Where a tile lies and the slice it belongs to, for a feathered overlay (brightness-fade.ts). */
export interface TileFeather {
  z: number;
  x: number;
  /** The tile row, for the fade at the slice's north and south edges; without it only the sides fade. */
  y?: number;
  slice: { west: number; east: number; south?: number; north?: number };
  deg: number;
}

/**
 * A tile's background faded out (`fadeBelow`) and re-encoded: decoded to a bitmap, drawn on
 * an OffscreenCanvas, the pixel step applied (render-core brightness-fade.ts), back to PNG.
 */
export async function fadeTileBytes(bytes: ArrayBuffer, ramp: FadeRamp, feather?: TileFeather): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return bytes;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (feather) mendAntimeridianColumn(data.data, canvas.width, { z: feather.z, x: feather.x });
  const weights = feather
    ? featherWeights({ z: feather.z, x: feather.x }, canvas.width, feather.slice, feather.deg)
    : undefined;
  const rows =
    feather && feather.y !== undefined && feather.slice.south !== undefined && feather.slice.north !== undefined
      ? latitudeWeights({ z: feather.z, y: feather.y }, canvas.height, {
          south: feather.slice.south,
          north: feather.slice.north,
        })
      : undefined;
  applyBrightnessFade(data.data, ramp, weights, canvas.width, rows);
  ctx.putImageData(data, 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

export function setWmtsProtocolOverlays(list: readonly WmtsOverlay[]): void {
  previous = new Map(overlays);
  overlays.clear();
  for (const o of list) overlays.set(o.id, o);
}

export function ensureWmtsProtocol(
  maplibre: Pick<MapLibreLike, 'addProtocol'>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  fade: (bytes: ArrayBuffer, ramp: FadeRamp, feather?: TileFeather) => Promise<ArrayBuffer> = fadeTileBytes,
): boolean {
  if (registered.has(maplibre)) return false;
  const loader: ProtocolLoader = async (request, abort) => {
    const tile = resolveWmtsProtocolTile(request.url);
    if (!tile) throw new Error(`no WMTS overlay for ${request.url}`);
    let res = await fetchImpl(tile.url, { signal: abort.signal });
    // A tile this frame lacks, from the frame before it (world-model `fallbackUrl`).
    const fallback =
      res.status === 404 && tile.overlay.fallbackUrl
        ? wmtsTileUrl({ ...tile.overlay, url: tile.overlay.fallbackUrl }, tile.z, tile.x, tile.y)
        : undefined;
    if (fallback) res = await fetchImpl(fallback, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    return {
      data: tile.overlay.fadeBelow
        ? await fade(
            bytes,
            tile.overlay.fadeBelow,
            tile.overlay.featherDeg && tile.overlay.bounds
              ? { z: tile.z, x: tile.x, y: tile.y, slice: tile.overlay.bounds, deg: tile.overlay.featherDeg }
              : undefined,
          )
        : bytes,
      cacheControl: res.headers.get('cache-control'),
      expires: res.headers.get('expires'),
    };
  };
  maplibre.addProtocol(WMTS_PROTOCOL, loader);
  registered.add(maplibre);
  return true;
}
