/**
 * Adapted from gods-eye-view src/maps/imagery.js (MIT).
 *
 * Imagery provider factories. The default is Cesium's bundled Natural Earth II
 * (public domain, served from Cesium's own assets: zero network, zero
 * credentials). Esri World Imagery and OSM raster are keyless but CONDITIONAL
 * (docs/legal/COMMERCIAL-DISTRIBUTION-REVIEW.md C-1, E-9): selectable, never
 * default. Attribution strings are provider-mandated wording.
 */
import type { CesiumLike, ImageryProviderLike } from './cesium-like.js';

export type ImageryFactoryModule = Pick<
  CesiumLike,
  | 'TileMapServiceImageryProvider'
  | 'UrlTemplateImageryProvider'
  | 'OpenStreetMapImageryProvider'
  | 'IonImageryProvider'
  | 'IonWorldImageryStyle'
  | 'buildModuleUrl'
>;

export const NATURAL_EARTH_ATTRIBUTION = 'Natural Earth II (public domain), bundled with CesiumJS';
export const ESRI_ATTRIBUTION =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const ESRI_WORLD_IMAGERY_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/';

/** Cesium ships Natural Earth II as a TMS tree under Assets/Textures/NaturalEarthII (levels 0–2). */
export function createNaturalEarthImagery(cesium: ImageryFactoryModule): Promise<ImageryProviderLike> {
  return cesium.TileMapServiceImageryProvider.fromUrl(cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'), {
    credit: NATURAL_EARTH_ATTRIBUTION,
  });
}

/**
 * Esri World Imagery, addressed as a tile tree rather than as a map service.
 *
 * `ArcGisMapServerImageryProvider.fromUrl` fetches the service document (`?f=json`) before
 * it can build anything, which gives the basemap a second point of failure that has
 * nothing to do with imagery: one refused, blocked or unreachable metadata request and
 * construction throws, the stack falls back to Natural Earth II, and the operator is left
 * on a three-level bundled basemap that turns to mush past a continent. Nothing in that
 * document is needed to address a tile — the layout is a plain Web Mercator `{z}/{y}/{x}`
 * pyramid, fixed and public — so building the provider directly makes it synchronous.
 * It cannot fail at construction at all, which leaves exactly one failure mode: a tile
 * that does not arrive, and `tileFailureFallback` already handles that.
 *
 * Level 19 is roughly 0.3 m/px at the equator, which is the level at which a house is a
 * shape with a roof rather than a smudge. Deeper coverage exists but is regional and
 * patchy; requesting it globally trades a sharper city centre for 404s over farmland,
 * and Cesium upsamples the deepest level it actually has.
 */
export const ESRI_WORLD_IMAGERY_TILE_URL = `${ESRI_WORLD_IMAGERY_URL}/tile/{z}/{y}/{x}`;
export const ESRI_MAX_LEVEL = 19;

/**
 * `url` replaces Esri's own tile address with another `{z}/{x}/{y}` (or `{z}/{y}/{x}`) template
 * serving the same pyramid — the desktop's disk tile cache, which fetches from Esri on a miss.
 */
export function createEsriWorldImagery(cesium: ImageryFactoryModule, url?: string): ImageryProviderLike {
  return new cesium.UrlTemplateImageryProvider({
    url: url ?? ESRI_WORLD_IMAGERY_TILE_URL,
    credit: ESRI_ATTRIBUTION,
    maximumLevel: ESRI_MAX_LEVEL,
  });
}

export function createOsmImagery(cesium: ImageryFactoryModule): ImageryProviderLike {
  return new cesium.OpenStreetMapImageryProvider({ url: OSM_TILE_URL, credit: OSM_ATTRIBUTION, maximumLevel: 19 });
}

export function createXyzImagery(
  cesium: ImageryFactoryModule,
  opts: { url: string; attribution: string; maxZoom: number; tileSize?: number },
): ImageryProviderLike {
  const init: { url: string; credit: string; maximumLevel: number; tileWidth?: number; tileHeight?: number } = {
    url: opts.url,
    credit: opts.attribution,
    maximumLevel: opts.maxZoom,
  };
  if (opts.tileSize !== undefined) {
    init.tileWidth = opts.tileSize;
    init.tileHeight = opts.tileSize;
  }
  return new cesium.UrlTemplateImageryProvider(init);
}

/** Cesium ion imagery (Bing via ion). Requires the user's own token; the free tier is non-commercial (C-8). */
export function createIonImagery(
  cesium: ImageryFactoryModule,
  assetId: number,
  accessToken: string,
): Promise<ImageryProviderLike> {
  const token = accessToken.trim();
  if (!token) throw new Error('Cesium ion imagery requires an explicit access token');
  return cesium.IonImageryProvider.fromAssetId(assetId, { accessToken: token });
}
