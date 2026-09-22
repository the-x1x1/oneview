import type { MapLibreLike, PmtilesLike, ProtocolLoader } from './maplibre-like.js';

/**
 * Registers the `pmtiles://` protocol once per MapLibre module. Worldpacks are
 * Protomaps PMTiles extracts; the shell hands the renderer a file or app-scheme
 * URL and the style's source becomes `pmtiles://<url>`.
 */
export const PMTILES_PROTOCOL = 'pmtiles';

const registered = new WeakMap<Pick<MapLibreLike, 'addProtocol' | 'removeProtocol'>, ProtocolLoader>();

export function ensurePmtilesProtocol(
  maplibre: Pick<MapLibreLike, 'addProtocol' | 'removeProtocol'>,
  pmtiles: PmtilesLike,
): { loader: ProtocolLoader; registeredNow: boolean } {
  const existing = registered.get(maplibre);
  if (existing) return { loader: existing, registeredNow: false };
  const protocol = new pmtiles.Protocol({ metadata: true });
  maplibre.addProtocol(PMTILES_PROTOCOL, protocol.tile);
  registered.set(maplibre, protocol.tile);
  return { loader: protocol.tile, registeredNow: true };
}

export function removePmtilesProtocol(maplibre: Pick<MapLibreLike, 'addProtocol' | 'removeProtocol'>): boolean {
  if (!registered.has(maplibre)) return false;
  maplibre.removeProtocol(PMTILES_PROTOCOL);
  registered.delete(maplibre);
  return true;
}

/** Normalise a pack path/url into a `pmtiles://` source url. */
export function pmtilesSourceUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('pmtiles://')) return pathOrUrl;
  return `pmtiles://${pathOrUrl}`;
}
