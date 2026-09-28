import { overlaySeries, type RasterOverlay } from '@worldview/world-model';
import type { CesiumLike, ImageryLayerLike, ImageryProviderLike, ViewerLike } from './cesium-like.js';

/**
 * Raster overlays (ADR-008 amendment) on the globe: one imagery layer per overlay, kept
 * right above the basemap (which the stack controller holds at index 0) and below the
 * reference borders, in list order. XYZ becomes a UrlTemplateImageryProvider, WMS a
 * WebMapServiceImageryProvider (Cesium builds the GetMap requests), WMTS a
 * WebMapTileServiceImageryProvider (RESTful template or KVP). A descriptor's alpha is its
 * opacity; its attribution is the provider's credit.
 */
export function imageryProviderFor(cesium: CesiumLike, o: RasterOverlay): ImageryProviderLike {
  const bounds = o.bounds
    ? cesium.Rectangle.fromDegrees(o.bounds.west, o.bounds.south, o.bounds.east, o.bounds.north)
    : undefined;
  // A descriptor's zooms are Web Mercator's. Cesium's WMS provider tiles geographically by
  // default (two tiles at level 0), so its level L is Web Mercator zoom L + 1 in scale: a
  // WMS layer's limits are shifted down one level (clamped at 0) or it would appear one
  // level late and be asked one level too deep. XYZ and WMTS providers tile Web Mercator.
  const shift = o.kind === 'wms' ? 1 : 0;
  const common = {
    credit: o.attribution,
    ...(o.minZoom !== undefined ? { minimumLevel: Math.max(0, o.minZoom - shift) } : {}),
    ...(o.maxZoom !== undefined ? { maximumLevel: Math.max(0, o.maxZoom - shift) } : {}),
    ...(o.tileSize !== undefined ? { tileWidth: o.tileSize, tileHeight: o.tileSize } : {}),
    ...(bounds ? { rectangle: bounds } : {}),
  };
  switch (o.kind) {
    case 'xyz':
      return new cesium.UrlTemplateImageryProvider({
        // Cesium spells the TMS row `{reverseY}`; everything else is the same template language.
        url: o.url.replace('{-y}', '{reverseY}'),
        ...(o.subdomains?.length ? { subdomains: o.subdomains } : {}),
        hasAlphaChannel: true,
        ...common,
      });
    case 'wms': {
      const version = o.version ?? '1.3.0';
      return cesium.createWmsImageryProvider({
        url: o.url,
        layers: o.layers,
        parameters: {
          service: 'WMS',
          version,
          format: o.format ?? 'image/png',
          transparent: o.transparent === false ? 'false' : 'true',
          styles: o.styles ?? '',
          ...(o.parameters ?? {}),
        },
        enablePickFeatures: false,
        ...common,
      });
    }
    case 'wmts':
      return cesium.createWmtsImageryProvider({
        url: o.url,
        layer: o.layer,
        style: o.style,
        format: o.format,
        tileMatrixSetID: o.tileMatrixSet,
        ...(o.tileMatrixLabels?.length ? { tileMatrixLabels: o.tileMatrixLabels } : {}),
        ...common,
      });
  }
}

interface Held {
  key: string;
  series: string;
  layer: ImageryLayerLike;
}

/**
 * What stays the same between two frames of one overlay (world-model `overlaySeries`): a
 * radar or satellite source publishes a new descriptor every few minutes that differs only
 * in its id and frame time, and it is the same layer advancing, not a new one. Shared with
 * the 2D map, so both hand a frame over the same way.
 */
export { overlaySeries };

/** How long a replaced frame stays under its successor, so the new tiles load over it. */
export const FRAME_HANDOVER_MS = 4000;

/**
 * Keeps the viewer's imagery layers for overlays equal to a list.
 *
 * Layers are kept by identity: a list that adds or removes one overlay leaves the others'
 * loaded tiles alone. Rebuilding every layer on every change made the whole overlay stack
 * blink each time the radar advanced a frame. A new frame of the same overlay is laid over
 * the old one, and the old one goes a few seconds later, once the new tiles have had time
 * to arrive.
 */
export class RasterOverlays3D {
  private held: Held[] = [];
  private list: readonly RasterOverlay[] = [];
  private readonly retiring = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cesium: CesiumLike,
    private readonly viewer: ViewerLike,
    private readonly onError: (message: string) => void,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) =>
      setTimeout(fn, ms),
  ) {}

  set(overlays: readonly RasterOverlay[]): void {
    this.list = overlays;
    this.apply();
  }

  /** The basemap layer was rebuilt at index 0 or the scene changed: put the overlays back in place. */
  reapply(): void {
    this.removeAll();
    this.apply();
  }

  private apply(): void {
    const wanted = this.list.map((o) => ({ o, key: JSON.stringify(o), series: overlaySeries(o) }));
    const unchanged = wanted.length === this.held.length && wanted.every((w, i) => w.key === this.held[i]!.key);
    if (unchanged) return;
    const byKey = new Map(this.held.map((h) => [h.key, h]));
    const bySeries = new Map(this.held.map((h) => [h.series, h]));
    const next: Held[] = [];
    const replaced: Held[] = [];
    for (const w of wanted) {
      const same = byKey.get(w.key);
      if (same) {
        byKey.delete(w.key);
        bySeries.delete(same.series);
        next.push(same);
        continue;
      }
      let provider: ImageryProviderLike;
      try {
        provider = imageryProviderFor(this.cesium, w.o);
      } catch (err) {
        this.onError(`overlay: ${w.o.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const layer = this.cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider));
      layer.alpha = w.o.opacity ?? 1;
      const previous = bySeries.get(w.series);
      if (previous) {
        byKey.delete(previous.key);
        bySeries.delete(w.series);
        replaced.push(previous);
      }
      next.push({ key: w.key, series: w.series, layer });
    }
    // Whatever is left was dropped from the list: gone at once.
    for (const h of byKey.values()) this.viewer.imageryLayers.remove(h.layer, true);
    // Order: index 0 is the basemap; overlays follow in list order, beneath whatever came
    // after (the reference borders). Detach and re-add the kept ones so the order is exact.
    for (const h of [...next, ...replaced]) if (this.held.includes(h)) this.viewer.imageryLayers.remove(h.layer, false);
    for (const [i, h] of next.entries()) this.viewer.imageryLayers.add(h.layer, 1 + i);
    // A replaced frame stays just under its successor for the handover, then goes.
    for (const old of replaced) {
      const successor = next.find((h) => h.series === old.series);
      const at = successor ? next.indexOf(successor) : next.length;
      this.viewer.imageryLayers.add(old.layer, 1 + at);
      const timer = this.schedule(() => {
        this.retiring.delete(timer);
        this.viewer.imageryLayers.remove(old.layer, true);
        this.viewer.scene.requestRender();
      }, FRAME_HANDOVER_MS);
      this.retiring.add(timer);
    }
    this.held = next;
    this.viewer.scene.requestRender();
  }

  private removeAll(): void {
    for (const h of this.held) this.viewer.imageryLayers.remove(h.layer, true);
    this.held = [];
  }

  dispose(): void {
    for (const t of this.retiring) clearTimeout(t);
    this.retiring.clear();
    this.removeAll();
    this.list = [];
  }
}
