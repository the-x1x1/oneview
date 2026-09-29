import { overlaySeries, type RasterOverlay } from '@worldview/world-model';
import { applyBrightnessFade, clampSplit, splitSideFor, type ImagerySplit } from '@worldview/render-core';
import type {
  CesiumLike,
  ImageryLayerLike,
  ImageryProviderLike,
  TileProviderErrorLike,
  ViewerLike,
} from './cesium-like.js';

/**
 * Raster overlays (ADR-008 amendment) on the globe: one imagery layer per overlay, kept
 * right above the basemap (which the stack controller holds at index 0) and below the
 * reference borders, in list order. XYZ becomes a UrlTemplateImageryProvider, WMS a
 * WebMapServiceImageryProvider (Cesium builds the GetMap requests), WMTS a
 * WebMapTileServiceImageryProvider (RESTful template or KVP). A descriptor's alpha is its
 * opacity; its attribution is the provider's credit.
 */
export function imageryProviderFor(cesium: CesiumLike, o: RasterOverlay): ImageryProviderLike {
  const provider = baseImageryProvider(cesium, o);
  return o.fadeBelow ? withBrightnessFade(provider, o.fadeBelow) : provider;
}

type TileImage = { width: number; height: number };
interface RequestsImages {
  requestImage(x: number, y: number, level: number, request?: unknown): Promise<unknown> | undefined;
}

/**
 * An overlay's `fadeBelow` on the globe: every tile the provider returns is drawn to a canvas,
 * its background faded out (render-core brightness-fade.ts), and the canvas handed to Cesium
 * in place of the image — which Cesium takes as imagery as readily as an image.
 */
export function withBrightnessFade<P extends object>(
  provider: P,
  ramp: { from: number; to: number },
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): P {
  const p = provider as P & Partial<RequestsImages>;
  const original = p.requestImage?.bind(p);
  if (!original) return provider;
  p.requestImage = (x, y, level, request) => {
    const pending = original(x, y, level, request);
    if (!pending) return pending;
    return pending.then((image) => fadeTile(image as TileImage | undefined, ramp, createCanvas));
  };
  return provider;
}

function fadeTile(
  image: TileImage | undefined,
  ramp: { from: number; to: number },
  createCanvas: () => HTMLCanvasElement,
): unknown {
  if (!image || !(image.width > 0) || !(image.height > 0)) return image;
  const canvas = createCanvas();
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return image;
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyBrightnessFade(data.data, ramp);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** A failed tile, in a line: the HTTP status or the error's message, and the zoom level. */
export function describeTileError(e: TileProviderErrorLike | undefined): string {
  const inner = e?.error as { statusCode?: unknown; message?: unknown } | undefined;
  const status = typeof inner?.statusCode === 'number' ? `HTTP ${inner.statusCode}` : undefined;
  const message =
    status ??
    (typeof inner?.message === 'string' && inner.message ? inner.message : undefined) ??
    (e?.message ? e.message.split('\n')[0]! : 'no detail');
  return e?.level !== undefined ? `${message}, zoom ${e.level}` : message;
}

function baseImageryProvider(cesium: CesiumLike, o: RasterOverlay): ImageryProviderLike {
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
  /** The source, which the imagery comparison chooses sides by. */
  providerId: string;
  layer: ImageryLayerLike;
  /** The overlay's `hideAboveZoom`: from this camera zoom in, the layer is not shown. */
  hideAboveZoom?: number;
}

/**
 * What stays the same between two frames of one overlay (world-model `overlaySeries`): a
 * radar or satellite source publishes a new descriptor every few minutes that differs only
 * in its id and frame time, and it is the same layer advancing, not a new one. Shared with
 * the 2D map, so both hand a frame over the same way.
 */
export { overlaySeries };

/**
 * How long a replaced frame stays under its successor at least, so the new tiles load over
 * it; after that it goes once the globe has loaded every tile in view, checked every
 * FRAME_HANDOVER_CHECK_MS, and at the latest after FRAME_HANDOVER_MAX_MS. A fixed four
 * seconds was not enough for a tile cache that renders on demand (EUMETView, on a laptop's
 * connection): the old frame went first and left the new one's missing tiles as holes.
 */
export const FRAME_HANDOVER_MS = 4000;
export const FRAME_HANDOVER_CHECK_MS = 1000;
export const FRAME_HANDOVER_MAX_MS = 30_000;

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
  /** Frames being handed over, until their timer removes them: split like the rest meanwhile. */
  private readonly retiring = new Map<ReturnType<typeof setTimeout>, Held>();
  private split: ImagerySplit | null = null;
  /** The camera's zoom (renderer view state), for overlays with `hideAboveZoom`. */
  private zoom = 0;

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

  /**
   * The before/after comparison (render-core imagery-split.ts): each layer on its source's side
   * of `scene.splitPosition`, every other layer whole. Kept for layers added later, so a new
   * frame of a compared source lands on its side.
   */
  setSplit(split: ImagerySplit | null): void {
    this.split = split;
    const scene = this.viewer.scene;
    // Cesium draws nothing split unless a layer asks; the position is left where it was when
    // the comparison ends, as it is then read by nothing.
    if (split) scene.splitPosition = clampSplit(split.position);
    for (const h of this.held) this.applySplit(h);
    for (const h of this.retiring.values()) this.applySplit(h);
    scene.requestRender();
  }

  private applySplit(h: Held): void {
    const side = splitSideFor(this.split, h.providerId);
    const dir = this.cesium.SplitDirection;
    h.layer.splitDirection = side === 'left' ? dir.LEFT : side === 'right' ? dir.RIGHT : dir.NONE;
  }

  /**
   * The camera's zoom changed: a layer with `hideAboveZoom` is shown only below it (world-model
   * overlay.ts). Cheap: a flag per layer, and a frame asked for only when one changed.
   */
  setZoom(zoom: number): void {
    this.zoom = zoom;
    let changed = false;
    for (const h of [...this.held, ...this.retiring.values()]) changed = this.applyZoom(h) || changed;
    if (changed) this.viewer.scene.requestRender();
  }

  private applyZoom(h: Held): boolean {
    const show = h.hideAboveZoom === undefined || this.zoom < h.hideAboveZoom;
    if (h.layer.show === show) return false;
    h.layer.show = show;
    return true;
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
      this.watchTiles(provider, w.o.name);
      const layer = this.cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider));
      layer.alpha = w.o.opacity ?? 1;
      const previous = bySeries.get(w.series);
      if (previous) {
        byKey.delete(previous.key);
        bySeries.delete(w.series);
        replaced.push(previous);
      }
      const held: Held = {
        key: w.key,
        series: w.series,
        providerId: w.o.providerId,
        layer,
        ...(w.o.hideAboveZoom !== undefined ? { hideAboveZoom: w.o.hideAboveZoom } : {}),
      };
      this.applySplit(held);
      this.applyZoom(held);
      next.push(held);
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
      this.retire(old, FRAME_HANDOVER_MS, FRAME_HANDOVER_MS);
    }
    this.held = next;
    this.viewer.scene.requestRender();
  }

  /**
   * Said once per overlay layer when its tiles fail. Cesium reports a failed imagery tile
   * only through the provider's error event — without a listener, not at all where the log
   * can see it — so a layer that drew nothing (a tile cache refusing every tile, a canvas
   * that could not be read) looked exactly like a clear sky.
   */
  private watchTiles(provider: ImageryProviderLike, name: string): void {
    const errors = provider.errorEvent;
    if (!errors) return;
    let said = false;
    errors.addEventListener((e) => {
      if (said) return;
      said = true;
      this.onError(`overlay: ${name}: tiles are failing (${describeTileError(e)})`);
    });
  }

  /** Take a replaced frame away once the globe has its successor's tiles (FRAME_HANDOVER_MS). */
  private retire(old: Held, wait: number, waited: number): void {
    const timer = this.schedule(() => {
      this.retiring.delete(timer);
      const loaded = this.viewer.scene.globe.tilesLoaded !== false;
      if (!loaded && waited < FRAME_HANDOVER_MAX_MS) {
        this.retire(old, FRAME_HANDOVER_CHECK_MS, waited + FRAME_HANDOVER_CHECK_MS);
        return;
      }
      this.viewer.imageryLayers.remove(old.layer, true);
      this.viewer.scene.requestRender();
    }, wait);
    this.retiring.set(timer, old);
  }

  private removeAll(): void {
    for (const h of this.held) this.viewer.imageryLayers.remove(h.layer, true);
    this.held = [];
  }

  dispose(): void {
    for (const t of this.retiring.keys()) clearTimeout(t);
    this.retiring.clear();
    this.removeAll();
    this.list = [];
  }
}
