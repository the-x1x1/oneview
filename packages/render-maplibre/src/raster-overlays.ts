import { overlaySeries, overlayTileTemplate, wmtsNeedsTileUrls, type RasterOverlay } from '@worldview/world-model';
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
  // A WMTS drawn clouds-only (`fadeBelow`) goes through the tile protocol too, which is where
  // the 2D map gets to touch a tile's pixels before they are drawn (wmts-protocol.ts).
  const faded = o.kind === 'wmts' && o.fadeBelow !== undefined;
  const template = faded ? undefined : overlayTileTemplate(o);
  const byTile = faded || (!template && wmtsNeedsTileUrls(o));
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

/** How long a replaced frame stays under its successor, so the new tiles load over it (as on the globe). */
export const FRAME_HANDOVER_MS = 4000;

/** An overlay the map is drawing: its id, its whole descriptor as a key, and its series. */
export interface HeldRasterOverlay {
  id: string;
  key: string;
  series: string;
}

export function heldRasterOverlay(o: RasterOverlay): HeldRasterOverlay {
  return { id: o.id, key: JSON.stringify(o), series: overlaySeries(o) };
}

/**
 * What the map must do to go from the overlays it draws to a new list, keeping what it can.
 * `keep`: drawn and unchanged, left alone with their loaded tiles. `remove`: gone from the
 * list, or changed under the same id, taken out at once. `retire`: an earlier frame of an
 * overlay whose new frame arrives (same `overlaySeries`, new id), left in place under it
 * and taken out after `FRAME_HANDOVER_MS`, so the picture never blinks to the basemap while
 * the new tiles load. `add`: the new ones in list order, each to be placed beneath the layer
 * of the overlay that follows it in the list (`before`), or at the base of the overlays when
 * it is the last; added last to first, every `before` is on the map by the time it is used.
 * When the kept ones would change order the plan keeps none and adds all again.
 */
export interface RasterOverlayPlan {
  keep: string[];
  remove: string[];
  retire: string[];
  add: Array<{ overlay: RasterOverlay; before: string | undefined }>;
}

export function planRasterOverlays(
  held: readonly HeldRasterOverlay[],
  wanted: readonly RasterOverlay[],
): RasterOverlayPlan {
  const next = wanted.map((o) => ({ o, ...heldRasterOverlay(o) }));
  const wantedKey = new Map(next.map((w) => [w.id, w.key]));
  let keep = held.filter((h) => wantedKey.get(h.id) === h.key).map((h) => h.id);
  const keptInListOrder = next.filter((w) => keep.includes(w.id)).map((w) => w.id);
  if (keptInListOrder.join('\n') !== keep.join('\n')) keep = [];
  const kept = new Set(keep);
  const added = next.filter((w) => !kept.has(w.id));
  const remove: string[] = [];
  const retire: string[] = [];
  for (const h of held) {
    if (kept.has(h.id)) continue;
    const successor = added.some((a) => a.series === h.series && a.id !== h.id);
    (successor && !wantedKey.has(h.id) ? retire : remove).push(h.id);
  }
  const add = added.map((a) => {
    const i = next.indexOf(a);
    return { overlay: a.o, before: next[i + 1]?.id };
  });
  return { keep, remove, retire, add };
}
