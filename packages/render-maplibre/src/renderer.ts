import type {
  AttributionEntry,
  BasemapDescriptor,
  FeatureUpdate,
  PickResult,
  ReferenceData,
  ReferenceOptions,
  RenderFeature,
  RendererCapabilities,
  RendererEvents,
  RenderingRule,
  Theme,
  ViewState,
  WorldRenderer,
} from '@worldview/render-core';
import { createFrameScheduler, DEFAULT_RULES, FrameCoalescer, type FrameScheduler } from '@worldview/render-core';
import { wmtsNeedsTileUrls, type GeoBounds, type GeoPosition, type RasterOverlay } from '@worldview/world-model';
import type { GeoJSONSourceLike, MapLibreLike, MapLike, PmtilesLike } from './maplibre-like.js';
import { EMPTY_COLLECTION, type GeoJsonFeature } from './geojson.js';
import { MotionModel2D, motionStepMs2d } from './motion.js';
import { SourceModel, clusterOptionsFromRules, type ClusterOptions } from './sources.js';
import { interactiveLayerIds, overlayLayerIds, overlayLayers, overlaySource, overlaySourceId } from './layers.js';
import { toPickResult } from './picking.js';
import { mapToViewState, resolveMapFlyTarget, viewStateToMap } from './view.js';
import { AttributionSync } from './attribution.js';
import { RASTER_OVERLAY_PREFIX, rasterOverlaySpec } from './raster-overlays.js';
import { ensurePmtilesProtocol } from './pmtiles.js';
import { ensureWmtsProtocol, setWmtsProtocolOverlays } from './wmts-protocol.js';
import { IconRegistry, domImageCanvasFactory, type ImageCanvasFactory } from './images.js';
import {
  buildEmptyStyle,
  DEFAULT_FONT_STACK,
  DEFAULT_GLYPHS_URL,
  styleForBasemap,
  type StyleBuildOptions,
} from './styles/worldview-dark.js';
import type { MapStyle } from './styles/spec.js';
import { parseIconImageId } from './images.js';
import {
  REFERENCE_LABELS_SOURCE,
  REFERENCE_LAYER_IDS,
  REFERENCE_LINES_SOURCE,
  referenceLayers,
  referenceSources,
} from './reference.js';

export interface MapLibreWorldRendererOptions {
  maplibre: MapLibreLike;
  /** Required for `pmtiles` basemaps (worldpacks). */
  pmtiles?: PmtilesLike;
  createCanvas?: ImageCanvasFactory;
  theme?: Theme;
  scheduler?: FrameScheduler;
  /** Rules decide which layers get MapLibre clustering (`clusterPx` > 0). */
  rules?: RenderingRule[];
  style?: StyleBuildOptions;
  now?: () => number;
  /** Wall-clock time in epoch ms — what RenderFeature.motion is in (default Date.now). */
  wallNow?: () => number;
  /**
   * How long to wait for `style.load` after a basemap change before giving up on it.
   * Injectable so tests do not have to spend the real interval.
   */
  styleLoadTimeoutMs?: number;
  /** Injectable for tests; defaults to the global timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * 'map' (the default): credits in MapLibre's attribution control, the basemap's from its
   * style source. 'host': the host draws its own credit line for every mode (the desktop
   * shell does), and a second one on the map is only a duplicate strip over the imagery.
   */
  attribution?: 'map' | 'host';
}

const DEFAULT_VIEW: ViewState = {
  center: { latitude: 20, longitude: 0 },
  altitudeM: 20_000_000,
  zoom: 1.5,
  headingDegrees: 0,
  pitchDegrees: -90,
};

/** A pause between frames longer than this is the map being idle, not drawing slowly. */
const IDLE_GAP_MS = 500;

/**
 * MapLibreWorldRenderer — the 2D adapter. GeoJSON source per layer, MapLibre
 * clustering for clusterable layers, symbol/circle/line/fill layers driven by
 * feature properties, PMTiles basemaps for worldpacks. Thin over the pure
 * modules (sources, layers, view, picking, styles).
 */

/** Feature layers drawn beneath every other feature layer, whenever they are added. */
const UNDERLAY_LAYERS: ReadonlySet<string> = new Set(['watchzones']);

/** The companion layer a layer's moving markers are drawn from (motion.ts). */
export const movingLayerId = (layer: string): string => `${layer}~moving`;

export class MapLibreWorldRenderer implements WorldRenderer {
  readonly capabilities: RendererCapabilities = {
    mode: '2D',
    terrain: false,
    tilt: true,
    clustering: true,
    maxFeatures: 200_000,
  };
  private readonly maplibre: MapLibreLike;
  private readonly scheduler: FrameScheduler;
  private readonly listeners: { [K in keyof RendererEvents]?: Set<(p: RendererEvents[K]) => void> } = {};
  private readonly sources: SourceModel;
  private readonly features = new Map<string, RenderFeature>();
  private readonly clusterOptions: Map<string, ClusterOptions>;
  /** Layers whose source refused a diff once; they are replaced whole from then on. */
  private readonly fullPushOnly = new Set<string>();
  private readonly icons: IconRegistry;
  private readonly fontStack: string[];
  private map: MapLike | undefined;
  private attribution: AttributionSync | undefined;
  private flushPass: FrameCoalescer | undefined;
  private viewPass: FrameCoalescer | undefined;
  private hoverPass: FrameCoalescer | undefined;
  private pendingHover: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } } | undefined;
  private lastHoverId: string | null = null;
  private moving = false;
  private selectedId: string | null = null;
  private lastView: ViewState = DEFAULT_VIEW;
  private currentStyle: MapStyle | string;
  private currentBasemap: BasemapDescriptor | undefined;
  private styleReady = false;
  private suspended = false;
  private disposed = false;
  private frames = 0;
  /** Rendering time accumulated in the current measurement window, idle gaps excluded. */
  private activeMs = 0;
  private lastFrameAt = Number.NaN;
  private longestFrameMs = 0;
  /** Longest `flush` (GeoJSON setData/updateData) since the last frame sample. */
  private longestPushMs = 0;
  private readonly now: () => number;
  private readonly styleLoadTimeoutMs: number;
  private reference: { data: ReferenceData | null; options: ReferenceOptions } | undefined;
  private referenceSourceData: ReferenceData | null = null;
  private rasterOverlays: readonly RasterOverlay[] = [];
  /** Overlay ids currently present as sources/layers, in draw order. */
  private rasterOverlayIds: string[] = [];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly wallNow: () => number;
  /** Markers with motion, and which of them are moving (motion.ts). */
  private readonly motion = new MotionModel2D();
  private motionTimer: unknown;
  private motionDueAt = Number.POSITIVE_INFINITY;
  /** The interval of the steps being taken now (NaN when nothing moves). */
  private motionStepMsNow = Number.NaN;
  /** The view or the markers changed: choose again what moves, once the view is still. */
  private chooseDue = true;
  /** Layers whose companion source currently holds moving markers. */
  private readonly movingLayers = new Set<string>();

  constructor(private readonly options: MapLibreWorldRendererOptions) {
    this.maplibre = options.maplibre;
    this.scheduler = options.scheduler ?? createFrameScheduler();
    this.styleLoadTimeoutMs = options.styleLoadTimeoutMs ?? 10_000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = options.now ?? (() => this.scheduler.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.sources = new SourceModel(options.theme);
    this.clusterOptions = clusterOptionsFromRules(options.rules ?? DEFAULT_RULES);
    this.icons = new IconRegistry(options.createCanvas ?? domImageCanvasFactory());
    this.fontStack = options.style?.fontStack ?? DEFAULT_FONT_STACK;
    this.currentStyle = buildEmptyStyle(options.style?.variant ?? 'dark', options.style?.glyphs ?? DEFAULT_GLYPHS_URL);
  }

  // ── events ─────────────────────────────────────────────────────────────────
  on<K extends keyof RendererEvents>(event: K, listener: (payload: RendererEvents[K]) => void): () => void {
    let set = this.listeners[event] as Set<(p: RendererEvents[K]) => void> | undefined;
    if (!set) {
      set = new Set();
      (this.listeners as Record<string, unknown>)[event] = set;
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }
  private emit<K extends keyof RendererEvents>(event: K, payload: RendererEvents[K]): void {
    const set = this.listeners[event] as Set<(p: RendererEvents[K]) => void> | undefined;
    if (set) for (const l of [...set]) l(payload);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async mount(container: HTMLElement): Promise<void> {
    if (this.map) return;
    const target = viewStateToMap({}, this.lastView);
    const map = new this.maplibre.Map({
      container,
      style: this.currentStyle,
      center: target.center,
      zoom: target.zoom,
      bearing: target.bearing,
      pitch: target.pitch,
      maxPitch: 85,
      attributionControl: false,
      preserveDrawingBuffer: true,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      antialias: true,
      fadeDuration: 100,
      localIdeographFontFamily: 'sans-serif',
    });
    this.map = map;
    this.attribution = this.options.attribution === 'host' ? undefined : new AttributionSync(this.maplibre, map);
    this.flushPass = new FrameCoalescer(this.scheduler, () => this.flush());
    this.viewPass = new FrameCoalescer(this.scheduler, () => {
      this.lastView = this.readView();
      this.emit('viewChanged', this.lastView);
    });
    this.hoverPass = new FrameCoalescer(this.scheduler, () => this.runHover());
    map.on('move', () => this.viewPass?.schedule());
    map.on('moveend', () => this.viewPass?.schedule());
    // No hover resolution while the map pans or zooms: every one is a queryRenderedFeatures
    // over the overlay layers, and a hover that changes restyles a feature — which a GeoJSON
    // source answers by re-indexing and re-tiling. Dragging swept the cursor across dots
    // and paid for that repeatedly, mid-gesture. Where the pointer rests is resolved at the end.
    map.on('movestart', () => {
      this.moving = true;
    });
    map.on('moveend', () => {
      this.moving = false;
      if (this.pendingHover) this.hoverPass?.schedule();
      if (this.motion.size) {
        this.chooseDue = true;
        this.scheduleMotion(0);
      }
    });
    map.on('click', (e) => this.emit('pick', this.pickAt(e.point, e.lngLat)));
    map.on('mousemove', (e) => {
      this.pendingHover = { point: e.point, lngLat: e.lngLat };
      this.hoverPass?.schedule();
    });
    map.on('mouseout', () => {
      if (this.lastHoverId !== null) {
        this.lastHoverId = null;
        this.emit('hover', null);
      }
    });
    map.on('error', (e) => this.emit('error', { message: e.error?.message ?? 'map error', fatal: false }));
    map.on('webglcontextlost', () => this.emit('error', { message: 'WebGL context lost', fatal: true }));
    map.on('style.load', () => {
      this.styleReady = true;
      this.restoreOverlays();
    });
    this.lastFrameAt = Number.NaN;
    map.on('render', () => this.countFrame());
    await new Promise<void>((resolve) => map.once('load', () => resolve()));
    this.styleReady = true;
    this.restoreOverlays();
    this.emit('ready', undefined);
  }

  unmount(): void {
    this.dispose();
  }

  suspend(): void {
    if (!this.map || this.suspended) return;
    this.suspended = true;
    this.map.stop();
    this.flushPass?.cancel();
    this.cancelMotion();
  }

  resume(): void {
    if (!this.map || !this.suspended) return;
    this.suspended = false;
    this.flushPass?.schedule();
    this.map.triggerRepaint();
    if (this.motion.size) this.scheduleMotion(0);
  }

  /**
   * Frame rate while the map is actually drawing.
   *
   * MapLibre renders on demand: an idle map draws nothing at all, and the gap before its next
   * frame is idleness, not slowness. This used to divide the frames in a window by the whole
   * wall-clock span, so a map left alone for thirty seconds that then drew once reported
   * 0.03 fps — and the performance governor, reading that as a machine on its knees, stepped
   * detail down. An idle 2D map degraded itself. Now only intervals that belong to continuous
   * rendering count, and a sample is emitted per second of *rendering*, however long that
   * takes to accumulate.
   */
  private countFrame(): void {
    const t = this.now();
    const gap = t - this.lastFrameAt;
    this.lastFrameAt = t;
    if (!Number.isFinite(gap) || gap > this.idleGapMs()) return;
    this.frames++;
    this.activeMs += gap;
    // Up to IDLE_GAP_MS; a longer gap cannot be told apart from the map having nothing to draw.
    this.longestFrameMs = Math.max(this.longestFrameMs, gap);
    if (this.activeMs >= 1000) {
      this.emit('frame', {
        fps: Math.round((this.frames * 1000) / this.activeMs),
        featureCount: this.features.size,
        maxFrameMs: Math.round(this.longestFrameMs),
        pushMaxMs: Math.round(this.longestPushMs * 10) / 10,
      });
      this.frames = 0;
      this.activeMs = 0;
      this.longestFrameMs = 0;
      this.longestPushMs = 0;
    }
  }

  /**
   * A gap between frames longer than this is the map waiting, not drawing slowly. While
   * markers move, the map draws once a step and waits for the next — every 250 ms, say, at a
   * regional zoom — and counting those waits as frames read as 4–9 fps from a map whose
   * frames took 2 ms. So while motion is stepping, a gap of most of a step is a wait.
   */
  private idleGapMs(): number {
    if (!this.motion.active.size || !Number.isFinite(this.motionStepMsNow)) return IDLE_GAP_MS;
    return Math.max(50, Math.min(IDLE_GAP_MS, this.motionStepMsNow * 0.8));
  }

  // ── features ───────────────────────────────────────────────────────────────
  update(update: FeatureUpdate): void {
    for (const id of update.remove) this.features.delete(id);
    if (update.replaceLayers)
      for (const [id, f] of this.features)
        if (update.replaceLayers.includes(f.layer) && !update.upsert.some((u) => u.id === id)) this.features.delete(id);
    for (const f of update.upsert) this.features.set(f.id, f);
    const selected = this.selectedId;
    this.sources.apply(update, selected ? (f) => (f.id === selected ? withSelected(f) : f) : undefined);
    this.trackMotion(update);
    if (!this.suspended) this.flushPass?.schedule();
  }

  /** Keep the motion model in step with an update: what has motion now, and what lost it. */
  private trackMotion(update: FeatureUpdate): void {
    let changed = false;
    for (const id of update.remove) if (this.motion.has(id)) changed = this.motion.delete(id) || true;
    for (const f of update.upsert) {
      if (f.motion && f.geometry.kind === 'point' && !this.clusterOptions.has(f.layer)) {
        this.motion.set(f);
        changed = true;
      } else if (this.motion.has(f.id)) {
        // Paused, replaying, or no longer moving: back to its layer, at its report.
        this.motion.delete(f.id);
        this.sources.release(f.id);
        changed = true;
      }
    }
    if (update.replaceLayers) for (const id of this.motion.ids()) if (!this.features.has(id)) this.motion.delete(id);
    if (changed) {
      this.chooseDue = true;
      this.scheduleMotion(0);
    }
  }

  // ── motion (motion.ts) ─────────────────────────────────────────────────────
  private scheduleMotion(ms: number): void {
    if (this.disposed || this.suspended) return;
    const due = this.now() + ms;
    if (this.motionTimer !== undefined && this.motionDueAt <= due) return;
    this.cancelMotion();
    this.motionDueAt = due;
    this.motionTimer = this.setTimer(
      () => {
        this.motionTimer = undefined;
        this.motionDueAt = Number.POSITIVE_INFINITY;
        this.stepMotion();
      },
      Math.max(0, ms),
    );
  }

  private cancelMotion(): void {
    if (this.motionTimer !== undefined) this.clearTimer(this.motionTimer);
    this.motionTimer = undefined;
    this.motionDueAt = Number.POSITIVE_INFINITY;
  }

  /**
   * One step: choose again what moves (when due, and only while the view is still — every
   * change to the set is a change to the big sources), then replace the companion sources with
   * the moving markers where they are now, and come back when the fastest of them has moved
   * half a pixel.
   */
  private stepMotion(): void {
    const map = this.map;
    if (!map || this.disposed || this.suspended || !this.styleReady) return;
    const now = this.wallNow();
    const view = this.readView();
    if (this.chooseDue && !this.moving) {
      this.chooseDue = false;
      const { enter, leave } = this.motion.choose(view.bounds, now);
      for (const id of leave) this.sources.release(id, this.motion.position(id, now));
      for (const id of enter) this.sources.hold(id);
      if (enter.length || leave.length) this.flushPass?.schedule();
    }
    this.sources.takeHeldChanges();
    const byLayer = this.motion.activeByLayer();
    for (const [layer, ids] of byLayer) {
      const features: GeoJsonFeature[] = [];
      for (const id of ids) {
        const gj = this.sources.heldFeature(id);
        const at = this.motion.position(id, now);
        if (!gj || !at || gj.geometry.type !== 'Point') continue;
        const alt = gj.geometry.coordinates[2];
        features.push({
          ...gj,
          geometry: { type: 'Point', coordinates: alt !== undefined ? [at[0], at[1], alt] : at },
        });
      }
      this.ensureMovingOverlay(map, layer);
      this.ensureIcons(map, features);
      map.getSource(overlaySourceId(movingLayerId(layer)))?.setData({ type: 'FeatureCollection', features });
      this.movingLayers.add(layer);
    }
    for (const layer of [...this.movingLayers])
      if (!byLayer.has(layer)) {
        map.getSource(overlaySourceId(movingLayerId(layer)))?.setData(EMPTY_COLLECTION);
        this.movingLayers.delete(layer);
      }
    if (byLayer.size) {
      this.motionStepMsNow = motionStepMs2d(view.zoom, view.center.latitude, this.motion.maxActiveSpeedMps());
      this.scheduleMotion(this.motionStepMsNow);
    } else this.motionStepMsNow = Number.NaN;
  }

  /** Add a layer's companion source and layers (on top of the others) if the map does not have them. */
  private ensureMovingOverlay(map: MapLike, layer: string): void {
    const companion = movingLayerId(layer);
    const sourceId = overlaySourceId(companion);
    if (map.getSource(sourceId)) return;
    const opts = {
      fontStack: this.fontStack,
      themeLayer: layer,
      ...(this.options.theme ? { theme: this.options.theme } : {}),
    };
    map.addSource(sourceId, overlaySource(companion, opts));
    for (const spec of overlayLayers(companion, opts)) map.addLayer(spec);
  }

  clear(layer?: string): void {
    if (layer) {
      for (const [id, f] of this.features)
        if (f.layer === layer) {
          this.features.delete(id);
          this.motion.delete(id);
        }
    } else {
      this.features.clear();
      this.motion.clear();
    }
    this.sources.clear(layer);
    if (this.movingLayers.size) this.scheduleMotion(0);
    if (!this.suspended) this.flushPass?.schedule();
  }

  select(featureId: string | null): void {
    if (featureId === this.selectedId) return;
    const previous = this.selectedId;
    this.selectedId = featureId;
    const prevFeature = previous ? this.features.get(previous) : undefined;
    if (prevFeature) this.sources.restyle(prevFeature);
    const nextFeature = featureId ? this.features.get(featureId) : undefined;
    if (nextFeature) this.sources.restyle(withSelected(nextFeature));
    if (!this.suspended) this.flushPass?.schedule();
    // A moving marker's new look is drawn by the next step: bring it forward.
    if (this.motion.active.size) this.scheduleMotion(0);
  }

  feature(id: string): RenderFeature | undefined {
    return this.features.get(id);
  }
  get featureCount(): number {
    return this.features.size;
  }

  /**
   * Push dirty layers to their GeoJSON sources, at most once per layer per frame.
   *
   * A layer the map already holds gets a diff (`updateData`): MapLibre answers `setData` by
   * re-indexing every feature of the source in its worker, so one moving aircraft used to
   * re-tile all of them. `setData` is kept for a layer's first push, for a layer that was
   * cleared or replaced, for a diff larger than half the layer (a full push is then no
   * dearer), for clustered sources, and for any source that ever refuses a diff.
   */
  private flush(): number {
    const map = this.map;
    if (!map || !this.styleReady || this.suspended) return 0;
    const started = this.now();
    try {
      return this.pushChanges(map);
    } finally {
      this.longestPushMs = Math.max(this.longestPushMs, this.now() - started);
    }
  }

  private pushChanges(map: MapLike): number {
    let n = 0;
    for (const change of this.sources.takeChanges()) {
      const { layer } = change;
      const created = this.ensureOverlay(map, layer);
      const source = map.getSource(overlaySourceId(layer));
      if (!source) continue;
      const diffable =
        !created &&
        !change.full &&
        typeof source.updateData === 'function' &&
        !this.clusterOptions.has(layer) &&
        !this.fullPushOnly.has(layer) &&
        change.remove.length + change.add.length <= Math.max(1, change.size / 2);
      if (diffable) {
        this.ensureIcons(map, change.add);
        this.pushDiff(source, layer, change.remove, change.add);
      } else {
        const collection = this.sources.collection(layer);
        this.ensureIcons(map, collection.features);
        source.setData(collection);
      }
      n++;
    }
    return n;
  }

  private ensureIcons(map: MapLike, features: readonly GeoJsonFeature[]): void {
    for (const f of features) {
      const icon = f.properties.icon ? parseIconImageId(f.properties.icon) : undefined;
      if (icon) this.icons.ensure(map, icon.icon, icon.colorCss);
    }
  }

  /**
   * Apply a diff, and if MapLibre refuses it — synchronously or through its promise — fall
   * back to replacing the layer and stop diffing it. A source that rejects diffs once will
   * again, and a layer that silently stopped updating would be worse than a slow one.
   */
  private pushDiff(source: GeoJSONSourceLike, layer: string, remove: string[], add: GeoJsonFeature[]): void {
    const fallBack = (error: unknown) => {
      if (this.fullPushOnly.has(layer)) return;
      this.fullPushOnly.add(layer);
      this.emit('error', {
        message: `2D layer ${layer}: incremental update refused (${error instanceof Error ? error.message : String(error)}); replacing it whole from now on`,
        fatal: false,
      });
      source.setData(this.sources.collection(layer));
    };
    try {
      const result = source.updateData!({ remove, add });
      if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(fallBack);
    } catch (error) {
      fallBack(error);
    }
  }

  /** Add the source and its layers if the map does not have them yet; true when it did not. */
  private ensureOverlay(map: MapLike, layer: string): boolean {
    const sourceId = overlaySourceId(layer);
    if (map.getSource(sourceId)) return false;
    const cluster = this.clusterOptions.get(layer);
    const opts = {
      fontStack: this.fontStack,
      ...(cluster ? { cluster } : {}),
      ...(this.options.theme ? { theme: this.options.theme } : {}),
    };
    map.addSource(sourceId, overlaySource(layer, opts));
    // Watch zones are areas under what is in them: added after the objects' layers (a zone is
    // usually drawn after the map has filled), they would otherwise tint every dot inside.
    const before = UNDERLAY_LAYERS.has(layer) ? this.firstOverlayLayerId(map, layer) : undefined;
    for (const spec of overlayLayers(layer, opts)) map.addLayer(spec, before);
    return true;
  }

  // ── reference layer (borders and names) ───────────────────────────────────
  setReference(data: ReferenceData | null, options: ReferenceOptions): void {
    this.reference = { data, options };
    if (this.map && this.styleReady) this.applyReference(this.map);
  }

  /** (Re)build the reference sources and layers, beneath the first of the world's own layers. */
  private applyReference(map: MapLike): void {
    for (const id of REFERENCE_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
    const ref = this.reference;
    const wanted = Boolean(ref?.data && (ref.options.borders || ref.options.labels));
    const sourcesPresent = Boolean(map.getSource(REFERENCE_LINES_SOURCE));
    if (sourcesPresent && (!wanted || this.referenceSourceData !== ref?.data)) {
      map.removeSource(REFERENCE_LINES_SOURCE);
      map.removeSource(REFERENCE_LABELS_SOURCE);
      this.referenceSourceData = null;
    }
    if (!wanted || !ref?.data) return;
    if (!map.getSource(REFERENCE_LINES_SOURCE)) {
      for (const [id, spec] of Object.entries(referenceSources(ref.data))) map.addSource(id, spec);
      this.referenceSourceData = ref.data;
    }
    const before = this.firstOverlayLayerId(map);
    for (const spec of referenceLayers(ref.options, this.fontStack)) map.addLayer(spec, before);
  }

  // ── raster overlays (ADR-008) ───────────────────────────────────────────────
  setOverlays(overlays: readonly RasterOverlay[]): void {
    this.rasterOverlays = overlays;
    const byTile = overlays.filter(wmtsNeedsTileUrls);
    setWmtsProtocolOverlays(byTile);
    if (byTile.length) ensureWmtsProtocol(this.maplibre);
    if (this.map && this.styleReady) this.applyRasterOverlays(this.map);
  }

  /**
   * Make the map's raster overlay sources/layers equal the list: remove what left, add
   * what arrived beneath the reference borders (or, without those, beneath the first of
   * the world's layers), and keep the list's order by removing and re-adding on reorder.
   */
  private applyRasterOverlays(map: MapLike): void {
    const wanted = this.rasterOverlays.map((o) => o.id);
    const unchanged =
      this.rasterOverlayIds.length === wanted.length && this.rasterOverlayIds.every((id, i) => id === wanted[i]);
    if (unchanged && wanted.every((id) => map.getLayer(`${RASTER_OVERLAY_PREFIX}${id}:layer`))) return;
    for (const id of this.rasterOverlayIds) {
      const layerId = `${RASTER_OVERLAY_PREFIX}${id}:layer`;
      const sourceId = `${RASTER_OVERLAY_PREFIX}${id}`;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
    this.rasterOverlayIds = [];
    const before = this.firstReferenceLayerId(map) ?? this.firstOverlayLayerId(map);
    for (const o of this.rasterOverlays) {
      const spec = rasterOverlaySpec(o);
      if ('unsupported' in spec) {
        this.emit('error', { message: `overlay: ${spec.unsupported}; not drawn in 2D`, fatal: false });
        continue;
      }
      if (map.getSource(spec.sourceId)) continue;
      map.addSource(spec.sourceId, spec.source);
      map.addLayer(spec.layer, before);
      this.rasterOverlayIds.push(o.id);
    }
  }

  private firstReferenceLayerId(map: MapLike): string | undefined {
    for (const id of REFERENCE_LAYER_IDS) if (map.getLayer(id)) return id;
    return undefined;
  }

  private firstOverlayLayerId(map: MapLike, except?: string): string | undefined {
    for (const layer of this.sources.layerIds()) {
      if (layer === except) continue;
      for (const id of overlayLayerIds(layer)) if (map.getLayer(id)) return id;
    }
    return undefined;
  }

  /** After a style change every source/layer/image is gone: re-add them with current data. */
  private restoreOverlays(): void {
    const map = this.map;
    if (!map) return;
    this.icons.reapply(map);
    // A new style has none of the reference sources: forget the old ones, then draw beneath.
    this.referenceSourceData = null;
    this.applyReference(map);
    // Nor any of the raster overlays: add them again, beneath the reference.
    this.rasterOverlayIds = [];
    this.applyRasterOverlays(map);
    for (const layer of this.sources.layerIds()) {
      this.ensureOverlay(map, layer);
      map.getSource(overlaySourceId(layer))?.setData(this.sources.collection(layer));
    }
    this.sources.takeDirty();
    // The companion sources went with the old style; the next step adds them again.
    this.movingLayers.clear();
    if (this.motion.active.size) this.scheduleMotion(0);
  }

  // ── view ───────────────────────────────────────────────────────────────────
  private readView(): ViewState {
    const map = this.map;
    if (!map) return this.lastView;
    const c = map.getCenter();
    const b = map.getBounds();
    return mapToViewState({
      lng: c.lng,
      lat: c.lat,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      bounds: { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
      ...(this.viewportPx() ? { viewportPx: this.viewportPx()! } : {}),
    });
  }

  /** The map's larger dimension in CSS pixels, when it has been laid out. */
  private viewportPx(): number | undefined {
    const canvas = this.map?.getCanvas();
    const px = canvas ? Math.max(canvas.clientWidth, canvas.clientHeight) : 0;
    return px > 0 ? px : undefined;
  }

  getView(): ViewState {
    return this.map ? this.readView() : this.lastView;
  }

  setView(view: Partial<ViewState>, opts: { animate?: boolean; durationMs?: number } = {}): void {
    const target = viewStateToMap(view, this.getView(), this.viewportPx());
    this.lastView = { ...this.lastView, ...view };
    if (!this.map) return;
    if (opts.animate) this.map.easeTo({ ...target, duration: opts.durationMs ?? 600 });
    else this.map.jumpTo(target);
  }

  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts: { durationMs?: number } = {},
  ): Promise<void> {
    const dest = resolveMapFlyTarget(target, this.getView(), this.viewportPx());
    const map = this.map;
    if (!map) {
      this.lastView = {
        ...this.lastView,
        center: target.position,
        ...(dest.kind === 'center' ? { zoom: dest.zoom } : {}),
      };
      return Promise.resolve();
    }
    const duration = opts.durationMs ?? 1200;
    return new Promise((resolve) => {
      map.once('moveend', () => resolve());
      if (dest.kind === 'bounds') map.fitBounds(dest.bounds, { padding: 48, duration, maxZoom: 16 });
      else map.flyTo({ center: dest.center, zoom: dest.zoom, duration, essential: true });
    });
  }

  // ── picking ────────────────────────────────────────────────────────────────
  private interactiveLayers(): string[] {
    const map = this.map;
    if (!map) return [];
    return this.sources
      .layerIds()
      .flatMap((l) => [...interactiveLayerIds(l), ...interactiveLayerIds(movingLayerId(l))])
      .filter((id) => map.getLayer(id));
  }

  private pickAt(point: { x: number; y: number }, lngLat: { lng: number; lat: number }): PickResult | null {
    const map = this.map;
    if (!map) return null;
    const layers = this.interactiveLayers();
    if (!layers.length) return null;
    return toPickResult(map.queryRenderedFeatures(point, { layers }), { x: point.x, y: point.y }, lngLat);
  }

  private runHover(): void {
    const p = this.pendingHover;
    if (!p || this.moving) return;
    this.pendingHover = undefined;
    const result = this.pickAt(p.point, p.lngLat);
    const id = result?.featureId ?? null;
    if (id === this.lastHoverId) return;
    this.lastHoverId = id;
    this.emit('hover', result);
  }

  // ── basemap / attribution ──────────────────────────────────────────────────
  async setBasemap(basemap: BasemapDescriptor): Promise<void> {
    if (basemap.kind === 'pmtiles') {
      if (!this.options.pmtiles) throw new Error('pmtiles basemap requested but the pmtiles module was not provided');
      ensurePmtilesProtocol(this.maplibre, this.options.pmtiles);
    }
    if (basemap.kind === 'cesium-natural-earth' || basemap.kind === 'cesium-ion')
      this.emit('error', {
        message: `basemap: ${basemap.kind} is a globe-only stack; showing the plain canvas`,
        fatal: false,
      });
    const style = styleForBasemap(basemap, this.options.style ?? {});
    this.currentStyle = style;
    this.currentBasemap = basemap;
    const map = this.map;
    if (!map) return;
    this.styleReady = false;
    // Bounded, because this promise used to be able to never settle.
    //
    // `style.load` does not fire if the style cannot be built — a pmtiles basemap whose
    // pack is not installed is the ordinary way to reach that, and it is the DEFAULT 2D
    // basemap on a fresh installation. The host awaits setBasemap before pushing features
    // into the renderer, so one absent decoration silently took the world's data with it:
    // the 2D map came up empty, no basemap and no objects, with nothing logged and the
    // mode indicator reading correctly. A basemap that will not load must cost you the
    // basemap and nothing else.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        resolve();
      };
      const timer = this.setTimer(() => {
        if (settled) return;
        this.emit('error', {
          message: `basemap: ${basemap.id} did not finish loading within ${this.styleLoadTimeoutMs} ms; the map is drawn without it`,
          fatal: false,
        });
        finish();
      }, this.styleLoadTimeoutMs);
      map.once('style.load', finish);
      map.setStyle(style);
    });
  }

  get basemap(): BasemapDescriptor | undefined {
    return this.currentBasemap;
  }
  get style(): MapStyle | string {
    return this.currentStyle;
  }

  setAttribution(entries: AttributionEntry[]): void {
    this.attribution?.apply(entries);
  }

  // ── export ─────────────────────────────────────────────────────────────────
  async screenshot(): Promise<Uint8Array> {
    const map = this.map;
    if (!map) throw new Error('renderer not mounted');
    map.redraw();
    const blob = await new Promise<Blob | null>((resolve) => map.getCanvas().toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob returned no data (preserveDrawingBuffer required)');
    return new Uint8Array(await blob.arrayBuffer());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flushPass?.cancel();
    this.viewPass?.cancel();
    this.hoverPass?.cancel();
    this.cancelMotion();
    this.attribution?.dispose();
    this.map?.remove();
    this.map = undefined;
    this.features.clear();
  }
}

function withSelected(f: RenderFeature): RenderFeature {
  return f.style.selected ? f : { ...f, style: { ...f.style, selected: true } };
}
