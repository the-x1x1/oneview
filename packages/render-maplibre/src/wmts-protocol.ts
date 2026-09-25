import { wmtsTileUrl, type WmtsOverlay } from '@worldview/world-model';
import type { MapLibreLike, ProtocolLoader } from './maplibre-like.js';

/**
 * `wvwmts://<overlay id>/{z}/{x}/{y}`: a Web Mercator WMTS whose matrices are not named by
 * the zoom written plainly (BKG TopPlusOpen's `00`…`18`). A MapLibre template can only say
 * `{z}`, so the source asks this protocol, which writes the service's own label for the
 * zoom into the tile URL and fetches it like any other tile (same https hosts, same CSP).
 */
export const WMTS_PROTOCOL = 'wvwmts';

const overlays = new Map<string, WmtsOverlay>();
const registered = new WeakSet<object>();

export function wmtsProtocolTiles(o: WmtsOverlay): string[] {
  return [`${WMTS_PROTOCOL}://${encodeURIComponent(o.id)}/{z}/{x}/{y}`];
}

/** The URL a `wvwmts://` request stands for, or undefined when it names nothing known. */
export function resolveWmtsProtocolUrl(url: string): string | undefined {
  const m = /^wvwmts:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) return undefined;
  const o = overlays.get(decodeURIComponent(m[1]!));
  if (!o) return undefined;
  return wmtsTileUrl(o, Number(m[2]), Number(m[3]), Number(m[4]));
}

export function setWmtsProtocolOverlays(list: readonly WmtsOverlay[]): void {
  overlays.clear();
  for (const o of list) overlays.set(o.id, o);
}

export function ensureWmtsProtocol(
  maplibre: Pick<MapLibreLike, 'addProtocol'>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): boolean {
  if (registered.has(maplibre)) return false;
  const loader: ProtocolLoader = async (request, abort) => {
    const real = resolveWmtsProtocolUrl(request.url);
    if (!real) throw new Error(`no WMTS overlay for ${request.url}`);
    const res = await fetchImpl(real, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      data: await res.arrayBuffer(),
      cacheControl: res.headers.get('cache-control'),
      expires: res.headers.get('expires'),
    };
  };
  maplibre.addProtocol(WMTS_PROTOCOL, loader);
  registered.add(maplibre);
  return true;
}
