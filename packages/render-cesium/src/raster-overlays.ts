import { drawnBounds, overlaySeries, type RasterOverlay } from '@worldview/world-model';
import {
  applyBrightnessFade,
  clampSplit,
  featherWeights,
  latitudeWeights,
  splitSideFor,
  type FadeRamp,
  type ImagerySplit,
} from '@worldview/render-core';
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
export function imageryProviderFor(
  cesium: CesiumLike,
  o: RasterOverlay,
  onFaded?: (coverage: number) => void,
  onFallback?: () => void,
): ImageryProviderLike {
  const faded = (p: ImageryProviderLike): ImageryProviderLike => {
    if (!o.fadeBelow) return p;
    const feather = o.featherDeg && o.bounds ? { slice: o.bounds, deg: o.featherDeg } : undefined;
    return withBrightnessFade(p, o.fadeBelow, undefined, feather, onFaded);
  };
  const provider = faded(baseImageryProvider(cesium, o));
  if (o.kind !== 'wmts' || !o.fallbackUrl) return provider;
  return withFallbackTiles(provider, faded(baseImageryProvider(cesium, { ...o, url: o.fallbackUrl })), onFallback);
}

/** How long after an overlay's first failed tile it is judged: failing if it has delivered none. */
export const TILE_FAILURE_CHECK_MS = 15_000;

/** A failed tile's HTTP status, when the failure says one (Cesium's RequestErrorEvent). */
function failedStatus(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; error?: { statusCode?: unknown } } | undefined;
  const status = e?.statusCode ?? e?.error?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A tile this frame does not have (404) asked of the frame before it (world-model
 * `fallbackUrl`), rather than left to the globe, which fills a missing tile from a coarser
 * one: GIBS's missing GOES-East tiles showed as blocks. Any other failure stays a failure.
 */
export function withFallbackTiles(
  provider: ImageryProviderLike,
  fallback: ImageryProviderLike,
  onFallback?: () => void,
): ImageryProviderLike {
  const p = provider as ImageryProviderLike & Partial<RequestsImages>;
  const original = p.requestImage?.bind(p);
  const other = (fallback as ImageryProviderLike & Partial<RequestsImages>).requestImage?.bind(fallback);
  if (!original || !other) return provider;
  p.requestImage = (x, y, level, request) => {
    const pending = original(x, y, level, request);
    if (!pending) return pending;
    return pending.catch((err: unknown) => {
      if (failedStatus(err) !== 404) throw err;
      const again = other(x, y, level);
      if (!again) throw err;
      onFallback?.();
      return again;
    });
  };
  return provider;
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
  ramp: FadeRamp,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
  feather?: { slice: { west: number; east: number; south?: number; north?: number }; deg: number },
  onFaded?: (coverage: number) => void,
): P {
  const p = provider as P & Partial<RequestsImages>;
  const original = p.requestImage?.bind(p);
  if (!original) return provider;
  p.requestImage = (x, y, level, request) => {
    const pending = original(x, y, level, request);
    if (!pending) return pending;
    return pending.then((image) =>
      fadeTile(
        image as TileImage | undefined,
        ramp,
        createCanvas,
        feather ? { x, y, level, ...feather } : undefined,
        onFaded,
      ),
    );
  };
  return provider;
}

function fadeTile(
  image: TileImage | undefined,
  ramp: FadeRamp,
  createCanvas: () => HTMLCanvasElement,
  feather?: {
    x: number;
    y: number;
    level: number;
    slice: { west: number; east: number; south?: number; north?: number };
    deg: number;
  },
  onFaded?: (coverage: number) => void,
): unknown {
  if (!image || !(image.width > 0) || !(image.height > 0)) return image;
  const canvas = createCanvas();
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return image;
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // The globe's WMTS tiles are Web Mercator (x from 180° W, 2^level columns), whatever their pixels.
  const weights = feather
    ? featherWeights({ z: feather.level, x: feather.x }, canvas.width, feather.slice, feather.deg)
    : undefined;
  const rows =
    feather && feather.slice.south !== undefined && feather.slice.north !== undefined
      ? tileRowWeights(
          { level: feather.level, y: feather.y },
          canvas.height,
          { south: feather.slice.south, north: feather.slice.north },
          isImageBitmap(image),
        )
      : undefined;
  applyBrightnessFade(data.data, ramp, weights, canvas.width, rows);
  if (onFaded) {
    // How much of the tile is left to see, 0–1: the mean of its alpha.
    let sum = 0;
    for (let i = 3; i < data.data.length; i += 4) sum += data.data[i]!;
    onFaded(sum / 255 / (data.data.length / 4));
  }
  ctx.putImageData(data, 0, 0);
  // Hand Cesium back the kind of picture it gave, so it is uploaded the way it expects.
  // Cesium decodes imagery to an ImageBitmap already flipped upside down (`flipY` at decode)
  // because WebGL ignores UNPACK_FLIP_Y for bitmaps, and uploads everything else with that
  // flip on. A canvas drawn from its flipped bitmap was therefore flipped a second time:
  // every faded tile (the infrared slices, true colour) lay upside down within its own square,
  // so neighbouring tiles did not meet — the "seams" seen on 2026-09-29 at tile edges such as
  // 41° N. A bitmap made from the canvas keeps the orientation Cesium chose.
  if (isImageBitmap(image) && typeof createImageBitmap === 'function') return createImageBitmap(canvas);
  return canvas;
}

/**
 * The latitude fade's per-row weights for a globe tile, in the order of the picture's rows.
 * Cesium hands over an ImageBitmap already upside down (decoded with `flipY`, see fadeTile),
 * so its first row is the tile's south edge: the weights are reversed for it. Applied the
 * right way up to a flipped picture, the fade kept the band beyond 60° and cleared the one
 * nearest the equator — on 2026-09-29 every hemisphere-sized tile (the NASA slices at the
 * whole-globe view) lost nearly all its cloud, while the deeper tiles, which the fade does not
 * touch, were whole.
 */
export function tileRowWeights(
  tile: { level: number; y: number },
  height: number,
  slice: { south: number; north: number },
  flipped: boolean,
): Float32Array | undefined {
  const rows = latitudeWeights({ z: tile.level, y: tile.y }, height, slice);
  return rows && flipped ? rows.reverse() : rows;
}

/** The provider with its delivered and failed tiles counted into `tiles` (throttled requests are not asked). */
function counted(provider: ImageryProviderLike, tiles: TileCounts): ImageryProviderLike {
  const p = provider as ImageryProviderLike & Partial<RequestsImages>;
  const original = p.requestImage?.bind(p);
  if (!original) return provider;
  p.requestImage = (x, y, level, request) => {
    const pending = original(x, y, level, request);
    if (!pending) return pending;
    return pending.then(
      (image) => {
        tiles.ok++;
        if (level > tiles.deepest) tiles.deepest = level;
        return image;
      },
      (err: unknown) => {
        tiles.failed++;
        throw err;
      },
    );
  };
  return provider;
}

function isImageBitmap(v: unknown): boolean {
  return typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap;
}

/** A failed tile, in a line: the HTTP status or the error's message, and the zoom level. */
export function describeTileError(e: TileProviderErrorLike | undefined): string {
  const inner = e?.error as { statusCode?: unknown; message?: unknown } | undefined;
  const status = typeof inner?.statusCode === 'number' ? `HTTP ${inner.statusCode}` : undefined;
  const message =
    status ??
    (typeof inner?.message === 'string' && inner.message ? inner.message : undefined) ??
    (e?.message ? e.message.split('\n')[0]! : 'no detail');
  if (e?.level === undefined) return message;
  // The tile, so the request can be repeated by hand: zoom/column/row, as the URL writes them.
  return e.x !== undefined && e.y !== undefined
    ? `${message}, tile ${e.level}/${e.x}/${e.y}`
    : `${message}, zoom ${e.level}`;
}

/**
 * From this camera zoom in, a clouds-only infrared layer (`fadeBelow` with `monochrome`) is
 * asked for one imagery level deeper than Cesium would choose. Cesium picks a level whose
 * texels are about as far apart as its terrain samples, which on this laptop's Balanced
 * quality (screen-space error 3) is three screen pixels a texel: fine for photographs, but a
 * clouds-only layer shows each texel's edge as a step — on 2026-09-29 GOES-East over Colombia
 * came from level 4 tiles, three and a half times magnified, as blocky white scraps. The globe
 * is told the layer's tiles are half as wide (Cesium uses a WMTS or XYZ provider's tile width
 * for choosing the level and nothing else; it uploads the image at its own size).
 *
 * Only from here in: a whole-globe view is the one place the magnification does not show, and
 * there it would only cost four times the tiles.
 */
export const DEEPER_TILES_FROM_ZOOM = 4;

/** The tile size the globe is told for an overlay at a camera zoom (see DEEPER_TILES_FROM_ZOOM). */
export function toldTileSize(o: RasterOverlay, zoom: number): number | undefined {
  const size = o.tileSize ?? 256;
  if (o.fadeBelow?.monochrome && o.kind !== 'wms' && zoom >= DEEPER_TILES_FROM_ZOOM) return size / 2;
  return o.tileSize;
}

/**
 * Make the provider's tile width follow the camera: read by Cesium each time it lays imagery
 * over a terrain tile, so tiles made after a zoom use the new level and the rest stay as they are.
 */
function followZoom(provider: ImageryProviderLike, o: RasterOverlay, zoom: () => number): void {
  if (!o.fadeBelow?.monochrome || o.kind === 'wms') return;
  const size = () => toldTileSize(o, zoom()) ?? 256;
  Object.defineProperty(provider, 'tileWidth', { get: size, configurable: true });
  Object.defineProperty(provider, 'tileHeight', { get: size, configurable: true });
}

function baseImageryProvider(cesium: CesiumLike, o: RasterOverlay): ImageryProviderLike {
  // Drawn a little past a feathered slice's edges, where it fades out under its neighbour.
  const drawn = drawnBounds(o);
  const bounds = drawn ? cesium.Rectangle.fromDegrees(drawn.west, drawn.south, drawn.east, drawn.north) : undefined;
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
  /** Tiles delivered, failed, and (faded layers) delivered with nothing left to see: the layer report. */
  tiles: TileCounts;
}

export interface TileCounts {
  ok: number;
  failed: number;
  blank: number;
  /** The deepest level a tile was delivered at (-1 before any): how sharp the layer can be. */
  deepest: number;
  /** Tiles the frame lacked, drawn from the frame before it (`withFallbackTiles`). */
  fallback?: number;
  /** Faded tiles, and the sum of how much of each was left to see (0–1): the mean is the report's `cov`. */
  faded?: number;
  coverage?: number;
}

/**
 * How often the globe's overlay stack is reported (`[layers]` in the console, which the main
 * process writes to app.log as "renderer layers"), when it has changed. A layer that loads
 * and draws nothing looks exactly like a clear sky from outside: on 2026-09-29 the three NASA
 * infrared slices drew on the 2D map and not on the globe, with no error anywhere. The report
 * names each overlay's place in the stack, whether it is shown, and what its tiles did.
 */
export const LAYER_REPORT_MS = 60_000;

/** Where the layer report goes and when; the default prints `[layers]` lines on an unreferenced timer. */
export interface LayerReporter {
  schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  emit(line: string): void;
}

const defaultReporter: LayerReporter = {
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  emit: (line) => console.info(`[layers] ${line}`),
};

/** One line for the layer report: each overlay's place, visibility, opacity and tile counts. */
export function layerReport(
  entries: readonly { providerId: string; index: number; show: boolean; alpha: number; tiles: TileCounts }[],
  total: number,
): string {
  const parts = entries.map(
    (e) =>
      `${e.providerId}@${e.index}${e.show ? '' : ' hidden'} a${Math.round(e.alpha * 100) / 100} ok${e.tiles.ok} fail${e.tiles.failed} blank${e.tiles.blank}${e.tiles.fallback ? ` prev${e.tiles.fallback}` : ''}${
        e.tiles.faded ? ` cov${Math.round((100 * (e.tiles.coverage ?? 0)) / e.tiles.faded)}%` : ''
      } L${e.tiles.deepest}`,
  );
  return `${total} layers; ${parts.join('; ') || 'no overlays'}`;
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
    private readonly reporter: LayerReporter = defaultReporter,
  ) {}

  set(overlays: readonly RasterOverlay[]): void {
    this.list = overlays;
    // A failure here is an overlay not drawn, said as such — never a thrown error that takes
    // the whole window down with it (it did once: "renderer drew nothing").
    try {
      this.apply();
    } catch (err) {
      this.onError(`overlays: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      const tiles: TileCounts = { ok: 0, failed: 0, blank: 0, deepest: -1 };
      try {
        provider = counted(
          imageryProviderFor(
            this.cesium,
            w.o,
            (coverage) => {
              if (coverage === 0) tiles.blank++;
              tiles.faded = (tiles.faded ?? 0) + 1;
              tiles.coverage = (tiles.coverage ?? 0) + coverage;
            },
            () => {
              tiles.fallback = (tiles.fallback ?? 0) + 1;
            },
          ),
          tiles,
        );
      } catch (err) {
        this.onError(`overlay: ${w.o.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      followZoom(provider, w.o, () => this.zoom);
      this.watchTiles(provider, w.o.name, tiles);
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
        tiles,
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
    for (const [i, h] of next.entries()) this.addAt(h.layer, 1 + i);
    // A replaced frame stays just under its successor for the handover, then goes.
    for (const old of replaced) {
      const successor = next.find((h) => h.series === old.series);
      const at = successor ? next.indexOf(successor) : next.length;
      this.addAt(old.layer, 1 + at);
      this.retire(old, FRAME_HANDOVER_MS, FRAME_HANDOVER_MS);
    }
    this.held = next;
    this.viewer.scene.requestRender();
    this.scheduleReport();
  }

  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReport = '';

  /** The stack as the layer report reads it now. */
  report(): string {
    const layers = this.viewer.imageryLayers;
    return layerReport(
      this.held.map((h) => ({
        providerId: h.providerId,
        index: layers.indexOf ? layers.indexOf(h.layer) : -1,
        show: h.layer.show,
        alpha: h.layer.alpha,
        tiles: h.tiles,
      })),
      layers.length,
    );
  }

  private scheduleReport(ms = LAYER_REPORT_MS / 4): void {
    if (this.reportTimer !== undefined || this.held.length === 0) return;
    // The first a little after a change, once tiles have had time to arrive; then once a
    // minute while there are overlays, said only when something changed.
    this.reportTimer = this.reporter.schedule(() => {
      this.reportTimer = undefined;
      const line = this.report();
      if (line !== this.lastReport) {
        this.lastReport = line;
        this.reporter.emit(line);
      }
      this.scheduleReport(LAYER_REPORT_MS);
    }, ms);
  }

  /**
   * Said when an overlay layer's tiles fail. Cesium reports a failed imagery tile only through
   * the provider's error event — without a listener, not at all where the log can see it — so
   * a layer that drew nothing (a tile cache refusing every tile, a canvas that could not be
   * read) looked exactly like a clear sky.
   *
   * The first failure is logged at once. The notice on screen waits `TILE_FAILURE_CHECK_MS`
   * and comes only if the layer has still delivered no tile by then: GIBS answers 404 for the
   * odd tile of a frame it is still building (one zoom-1 tile of an infrared layer at start,
   * on the reference laptop) while every other tile draws, and that was a toast each time.
   */
  private watchTiles(provider: ImageryProviderLike, name: string, tiles: TileCounts): void {
    const errors = provider.errorEvent;
    if (!errors) return;
    let said = false;
    errors.addEventListener((e) => {
      if (said) return;
      said = true;
      const detail = describeTileError(e);
      console.warn('[render-cesium] overlay %s: a tile failed (%s)', name, detail);
      this.schedule(() => {
        const still = this.held.some((h) => h.tiles === tiles);
        if (still && tiles.ok === 0) this.onError(`overlay: ${name}: tiles are failing (${detail})`);
      }, TILE_FAILURE_CHECK_MS);
    });
  }

  /**
   * Add a layer at `index`, or at the end if the collection is shorter. With "No basemap"
   * chosen there is no base layer at index 0, and Cesium throws for an index past the end:
   * on 2026-09-29 the app started blank ("renderer drew nothing") with basemap none and a
   * true-colour layer chosen, because the first overlay asked for index 1 of an empty list.
   */
  private addAt(layer: ImageryLayerLike, index: number): void {
    const layers = this.viewer.imageryLayers;
    layers.add(layer, Math.min(index, layers.length));
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
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer);
    this.reportTimer = undefined;
    for (const t of this.retiring.keys()) clearTimeout(t);
    this.retiring.clear();
    this.removeAll();
    this.list = [];
  }
}
