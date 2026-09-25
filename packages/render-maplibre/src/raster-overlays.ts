import { overlayTileTemplate, wmtsNeedsTileUrls, type RasterOverlay } from '@worldview/world-model';
import { wmtsProtocolTiles } from './wmts-protocol.js';
import type { LayerSpec, SourceSpec } from './styles/spec.js';

/**
 * Raster overlays (ADR-008 amendment) as MapLibre sources and layers: one raster source
 * and one raster layer per overlay, ids prefixed so they can be told from the basemap's
 * and the world's, drawn in list order beneath the reference borders. A WMS becomes a
 * `{bbox-epsg-3857}` tile template, a Web Mercator WMTS a `{z}/{x}/{y}` one (or, when its
 * matrices are not named by the plain zoom, the `wvwmts://` protocol); an overlay the 2D
 * map cannot address (a WMTS on another matrix set) is reported, not drawn.
 */
export const RASTER_OVERLAY_PREFIX = 'wv-raster:';

export function rasterOverlaySourceId(overlayId: string): string {
  return `${RASTER_OVERLAY_PREFIX}${overlayId}`;
}
export function rasterOverlayLayerId(overlayId: string): string {
  return `${RASTER_OVERLAY_PREFIX}${overlayId}:layer`;
}

export interface RasterOverlaySpec {
  sourceId: string;
  layerId: string;
  source: SourceSpec;
  layer: LayerSpec;
}

/** The specs for one overlay, or a reason the 2D map cannot draw it. */
export function rasterOverlaySpec(o: RasterOverlay): RasterOverlaySpec | { unsupported: string } {
  const template = overlayTileTemplate(o);
  const byTile = !template && wmtsNeedsTileUrls(o);
  if (!template && !byTile)
    return {
      unsupported: `${o.name}: a WMTS on matrix set "${o.kind === 'wmts' ? o.tileMatrixSet : '?'}" is not Web Mercator`,
    };
  const tiles = byTile
    ? wmtsProtocolTiles(o)
    : o.kind === 'xyz' && o.subdomains?.length
      ? o.subdomains.map((sd) => template!.replace('{s}', sd))
      : [template!];
  const sourceId = rasterOverlaySourceId(o.id);
  const layerId = rasterOverlayLayerId(o.id);
  const source: SourceSpec = {
    type: 'raster',
    tiles,
    tileSize: o.tileSize ?? 256,
    attribution: o.attribution,
    ...(o.minZoom !== undefined ? { minzoom: o.minZoom } : {}),
    ...(o.maxZoom !== undefined ? { maxzoom: o.maxZoom } : {}),
    ...(sourceBounds(o) ? { bounds: sourceBounds(o)! } : {}),
  };
  const layer: LayerSpec = {
    id: layerId,
    type: 'raster',
    source: sourceId,
    ...(o.minZoom !== undefined ? { minzoom: o.minZoom } : {}),
    paint: { 'raster-opacity': o.opacity ?? 1, 'raster-fade-duration': 150 },
  };
  return { sourceId, layerId, source, layer };
}

/**
 * The overlay's extent as a MapLibre source `bounds`, so a service that paints white outside
 * its coverage (USGSTopo) stays inside the extent its definition gives, as it does on the
 * globe. An extent across the antimeridian is written with east past 180, which MapLibre
 * reads as the same span.
 */
function sourceBounds(o: RasterOverlay): [number, number, number, number] | undefined {
  const b = o.bounds;
  if (!b) return undefined;
  const lat = (v: number) => Math.max(-85.0511287798066, Math.min(85.0511287798066, v));
  const east = b.east < b.west ? b.east + 360 : b.east;
  return [b.west, lat(b.south), east, lat(b.north)];
}
