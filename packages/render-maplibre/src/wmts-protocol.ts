import { wmtsTileUrl, type WmtsOverlay } from '@worldview/world-model';
import { applyBrightnessFade, featherWeights, type FadeRamp } from '@worldview/render-core';
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

function resolveWmtsProtocolTile(url: string): { url: string; overlay: WmtsOverlay; z: number; x: number } | undefined {
  const m = /^wvwmts:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]!);
  const o = overlays.get(id) ?? previous.get(id);
  if (!o) return undefined;
  const real = wmtsTileUrl(o, Number(m[2]), Number(m[3]), Number(m[4]));
  return real ? { url: real, overlay: o, z: Number(m[2]), x: Number(m[3]) } : undefined;
}

/**
 * A tile's background faded out (`fadeBelow`) and re-encoded: decoded to a bitmap, drawn on
 * an OffscreenCanvas, the pixel step applied (render-core brightness-fade.ts), back to PNG.
 */
export async function fadeTileBytes(
  bytes: ArrayBuffer,
  ramp: FadeRamp,
  feather?: { z: number; x: number; slice: { west: number; east: number }; deg: number },
): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return bytes;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const weights = feather
    ? featherWeights({ z: feather.z, x: feather.x }, canvas.width, feather.slice, feather.deg)
    : undefined;
  applyBrightnessFade(data.data, ramp, weights, canvas.width);
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
  fade: (
    bytes: ArrayBuffer,
    ramp: FadeRamp,
    feather?: { z: number; x: number; slice: { west: number; east: number }; deg: number },
  ) => Promise<ArrayBuffer> = fadeTileBytes,
): boolean {
  if (registered.has(maplibre)) return false;
  const loader: ProtocolLoader = async (request, abort) => {
    const tile = resolveWmtsProtocolTile(request.url);
    if (!tile) throw new Error(`no WMTS overlay for ${request.url}`);
    const res = await fetchImpl(tile.url, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    return {
      data: tile.overlay.fadeBelow
        ? await fade(
            bytes,
            tile.overlay.fadeBelow,
            tile.overlay.featherDeg && tile.overlay.bounds
              ? { z: tile.z, x: tile.x, slice: tile.overlay.bounds, deg: tile.overlay.featherDeg }
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
