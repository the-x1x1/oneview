import type { RasterOverlay } from '@worldview/world-model';
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
  const common = {
    credit: o.attribution,
    ...(o.minZoom !== undefined ? { minimumLevel: o.minZoom } : {}),
    ...(o.maxZoom !== undefined ? { maximumLevel: o.maxZoom } : {}),
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
  layer: ImageryLayerLike;
}

/** Keeps the viewer's imagery layers for overlays equal to a list. */
export class RasterOverlays3D {
  private held: Held[] = [];
  private list: readonly RasterOverlay[] = [];

  constructor(
    private readonly cesium: CesiumLike,
    private readonly viewer: ViewerLike,
    private readonly onError: (message: string) => void,
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
    const wanted = this.list.map((o) => ({ o, key: JSON.stringify(o) }));
    const unchanged = wanted.length === this.held.length && wanted.every((w, i) => w.key === this.held[i]!.key);
    if (unchanged) return;
    this.removeAll();
    for (const [i, { o, key }] of wanted.entries()) {
      let provider: ImageryProviderLike;
      try {
        provider = imageryProviderFor(this.cesium, o);
      } catch (err) {
        this.onError(`overlay: ${o.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const layer = this.cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider));
      layer.alpha = o.opacity ?? 1;
      // Index 0 is the basemap; overlays follow it in list order, beneath whatever came after.
      this.viewer.imageryLayers.add(layer, 1 + i);
      this.held.push({ key, layer });
    }
    this.viewer.scene.requestRender();
  }

  private removeAll(): void {
    for (const h of this.held) this.viewer.imageryLayers.remove(h.layer, true);
    this.held = [];
  }

  dispose(): void {
    this.removeAll();
    this.list = [];
  }
}
