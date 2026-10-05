import type {
  AttributionEntry,
  BasemapDescriptor,
  CameraModeState,
  FeatureUpdate,
  FlyToOptions,
  GraphicsProfile,
  ImagerySplit,
  PickResult,
  ReferenceData,
  ReferenceOptions,
  RenderFeature,
  RendererCapabilities,
  RendererEvents,
  RenderingRule,
  ScreenPoint,
  Theme,
  ViewState,
  VisualStyleId,
  WorldRenderer,
} from '@worldview/render-core';
import {
  createFrameScheduler,
  DAY_NIGHT_REFRESH_MS,
  DEFAULT_RULES,
  fadeOpacity,
  FrameCoalescer,
  pixelRatioFor,
  type FrameScheduler,
} from '@worldview/render-core';
import { type GeoBounds, type WmtsOverlay, type GeoPosition, type RasterOverlay } from '@worldview/world-model';
import type { GeoJSONSourceLike, MapLibreLike, MapLike, PmtilesLike } from './maplibre-like.js';
import { EMPTY_COLLECTION, type GeoJsonFeature, type GeoJsonFeatureCollection } from './geojson.js';
import { MotionModel2D, motionStepMs2d } from './motion.js';
import { SourceModel, clusterOptionsFromRules, type ClusterOptions } from './sources.js';
import { interactiveLayerIds, overlayLayerIds, overlayLayers, overlaySource, overlaySourceId } from './layers.js';
import { toPickResult } from './picking.js';
import {
  mapToViewState,
  normalizeBearing,
  pitchDegreesToMapLibre,
  resolveMapFlyTarget,
  viewStateToMap,
} from './view.js';
import { NIGHT_LAYER_IDS, NIGHT_SOURCE, nightCollection, nightLayers, nightSource } from './night.js';
import { VisualStyle2D, type StyleDocument, type StyleElement } from './visual-styles.js';
import { AttributionSync } from './attribution.js';
import {
  FRAME_HANDOVER_CHECK_MS,
  FRAME_HANDOVER_MAX_MS,
  FRAME_HANDOVER_MS,
  RASTER_OVERLAY_PREFIX,
  heldRasterOverlay,
  planRasterOverlays,
  rasterOverlayLayerId,
  rasterOverlaySourceId,
  rasterOverlaySpec,
  type HeldRasterOverlay,
  usesWmtsProtocol,
} from './raster-overlays.js';
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

/** Orbit: one turn in 90 s (the globe's pace, render-cesium camera-modes.ts), a quarter turn per ease. */
const ORBIT_QUARTER_MS = 22_500;
const linear = (t: number): number => t;

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

/** MapLibre's error for a style layer whose source layer the tiles do not have. */
const MISSING_SOURCE_LAYER = /^Source layer "[^"]*" does not exist on source "[^"]*"/;

/** How long after a raster overlay's first failed tile it is judged: failing if it has delivered none. */
export const TILE_FAILURE_CHECK_MS = 15_000;

export class MapLibreWorldRenderer implements WorldRenderer {
  private readonly missingLayers = new Set<string>();
  /** Raster overlay sources that have had a tile fail (logged once each). */
  private readonly rasterFailing = new Set<string>();
  /** Raster overlay sources that have delivered at least one tile. */
  private readonly rasterTilesOk = new Set<string>();
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
  private graphics: GraphicsProfile | undefined;
  private attribution: AttributionSync | undefined;
  private flushPass: FrameCoalescer | undefined;
  private viewPass: FrameCoalescer | undefined;
  private hoverPass: FrameCoalescer | undefined;
  private pendingHover: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } } | undefined;
  private lastHoverId: string | null = null;
  /** Where the pointer is over the map (`pointer` event, the HUD's readout); `null` once it left. */
  private pointerAt: { x: number; y: number } | null = null;
  private pointerPass: FrameCoalescer | undefined;
  private pointerOnMap = false;
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
  private imagerySplit: ImagerySplit | null = null;
  /** The overlays currently drawn as sources/layers, in draw order. */
  private rasterHeld: HeldRasterOverlay[] = [];
  /** Earlier frames left under their successors for the handover, by overlay id, with their timers. */
  private readonly rasterRetiring = new Map<string, unknown>();
  /** Overlays already reported as not drawable in 2D, so a report is made once, not on every change. */
  private rasterReported = new Set<string>();
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
  private container: HTMLElement | undefined;
  private visualStyleId: VisualStyleId = 'standard';
  private visualStyle: VisualStyle2D | undefined;
  private dayNightOn = false;
  private nightTimer: unknown;
  private orbitOn = false;
  private orbitFrame: number | undefined;
  private followId: string | null = null;
  /** The flight to the followed object is over: each step now keeps it centred. */
  private followEngaged = false;
  /** A jump made by follow itself, whose moveend is not the view changing under the operator. */
  private followJumping = false;

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
      // Antialiasing is fixed with the WebGL context, so it follows the profile in force when
      // the map is built; the pixel density can change later (setGraphics).
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: (this.graphics?.msaaSamples ?? 4) > 1 },
      antialias: (this.graphics?.msaaSamples ?? 4) > 1,
      fadeDuration: 100,
      localIdeographFontFamily: 'sans-serif',
      ...(this.graphics ? { pixelRatio: pixelRatioFor(this.graphics, displayPixelRatio()) } : {}),
    });
    this.map = map;
    this.container = container;
    this.attribution = this.options.attribution === 'host' ? undefined : new AttributionSync(this.maplibre, map);
    // Visual styles are the browser's to draw (visual-styles.ts), so they need the page's DOM;
    // without one (Node tests) the id is kept and nothing is drawn.
    const doc = container.ownerDocument as unknown as StyleDocument | undefined;
    const canvas = map.getCanvas() as unknown as StyleElement;
    if (doc && typeof doc.createElementNS === 'function' && canvas?.style) {
      this.visualStyle = new VisualStyle2D(doc, container as unknown as StyleElement, canvas);
      this.visualStyle.set(this.visualStyleId);
    }
    this.flushPass = new FrameCoalescer(this.scheduler, () => this.flush());
    this.viewPass = new FrameCoalescer(this.scheduler, () => {
      this.lastView = this.readView();
      this.emit('viewChanged', this.lastView);
    });
    this.hoverPass = new FrameCoalescer(this.scheduler, () => this.runHover());
    this.pointerPass = new FrameCoalescer(this.scheduler, () => this.runPointer());
    map.on('move', () => {
      this.viewPass?.schedule();
      // The ground under a pointer held still changes as the map moves under it.
      if (this.pointerAt) this.pointerPass?.schedule();
    });
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
      // Follow's own re-centring on a motion step: the step it came from carries on by itself.
      if (this.followJumping) return;
      if (this.motion.size) {
        this.chooseDue = true;
        this.scheduleMotion(0);
      }
    });
    map.on('click', (e) => {
      this.emit('click', {
        position: { latitude: e.lngLat.lat, longitude: wrapLongitude(e.lngLat.lng) },
        screen: { x: e.point.x, y: e.point.y },
      });
      this.emit('pick', this.pickAt(e.point, e.lngLat));
    });
    map.on('mousemove', (e) => {
      this.pendingHover = { point: e.point, lngLat: e.lngLat };
      this.hoverPass?.schedule();
      this.pointerAt = { x: e.point.x, y: e.point.y };
      this.pointerPass?.schedule();
    });
    map.on('mouseout', () => {
      this.pointerAt = null;
      this.pointerPass?.schedule();
      if (this.lastHoverId !== null) {
        this.lastHoverId = null;
        this.emit('hover', null);
      }
    });
    map.on('error', (e) => {
      const message = e.error?.message ?? 'map error';
      // A basemap style reads layers a pack's extract may not carry (a regional cut without
      // buildings or land use): MapLibre reports each as an error, and each was a toast. The
      // layer simply draws nothing; it is logged once, not shown.
      if (MISSING_SOURCE_LAYER.test(message)) {
        if (!this.missingLayers.has(message)) {
          this.missingLayers.add(message);
          console.warn('[render-maplibre] %s', message);
        }
        return;
      }
      // A raster overlay's failed tile (a NASA frame still being built answers 404 for the odd
      // one while the rest draw) is logged; it is said on screen only if the overlay has
      // delivered no tile at all by `TILE_FAILURE_CHECK_MS` later (as on the globe).
      const sourceId = e.sourceId;
      if (sourceId?.startsWith(RASTER_OVERLAY_PREFIX)) {
        if (this.rasterFailing.has(sourceId)) return;
        this.rasterFailing.add(sourceId);
        console.warn('[render-maplibre] overlay %s: a tile failed (%s)', sourceId, message);
        this.setTimer(() => {
          if (this.map !== map) return;
          if (!this.rasterTilesOk.has(sourceId) && map.getSource(sourceId))
            this.emit('error', {
              message: `overlay: ${sourceId.slice(RASTER_OVERLAY_PREFIX.length)}: tiles are failing (${message})`,
              fatal: false,
            });
        }, TILE_FAILURE_CHECK_MS);
        return;
      }
      this.emit('error', { message, fatal: false });
    });
    map.on('sourcedata', (e) => {
      if (e?.tile && e.sourceId?.startsWith(RASTER_OVERLAY_PREFIX)) this.rasterTilesOk.add(e.sourceId);
    });
    // An icon asked for before it is (re-)registered — the frame after a basemap switch, whose
    // new style starts without the icons — is drawn here, not reported missing (a tornado
    // warning's icon was, once, on the reference laptop).
    // MapLibre 6 asks a resolver first and fires the event (with a console warning) only for
    // what is still missing after it, too late for the tile that asked: the resolver draws it
    // in time; the event stays for versions without one.
    const drawMissingIcon = (id: unknown) => {
      const icon = typeof id === 'string' ? parseIconImageId(id) : undefined;
      if (icon) this.icons.ensure(map, icon.icon, icon.colorCss);
    };
    map.setMissingStyleImageResolver?.((id) => drawMissingIcon(id));
    map.on('styleimagemissing', (e) => drawMissingIcon(e?.id));
    map.on('webglcontextlost', () =>
      this.emit('error', { message: 'WebGL context lost', fatal: false, contextLost: true }),
    );
    // The operator's own hand on the map ends an orbit; a pan ends a follow (a follow keeps the
    // object centred, so a pan and a follow would fight). Zooming and turning keep following.
    const takeHold = () => {
      if (this.orbitOn) {
        this.stopOrbit();
        this.emitCameraMode();
      }
    };
    map.on('mousedown', takeHold);
    map.on('touchstart', takeHold);
    map.on('wheel', takeHold);
    map.on('dragstart', () => {
      if (this.followId !== null) {
        this.endFollow();
        this.emitCameraMode();
      }
    });
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
    this.cancelCameraModes();
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
    const followed = this.followId;
    if (followed !== null) this.followChanged(update.upsert.some((f) => f.id === followed));
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
    // A followed marker that moved this step takes the view with it, in the same step.
    if (this.followId !== null && this.followEngaged && this.motion.active.has(this.followId)) this.recentre(map, now);
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
    this.followChanged(false);
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
    const byTile = overlays.filter((o): o is WmtsOverlay => usesWmtsProtocol(o));
    setWmtsProtocolOverlays(byTile);
    if (byTile.length) ensureWmtsProtocol(this.maplibre);
    if (this.map && this.styleReady) this.applyRasterOverlays(this.map);
  }

  /**
   * The imagery comparison in 2D (render-core imagery-split.ts). MapLibre composes every
   * raster layer into one canvas and cannot draw a layer on part of the screen only, so the
   * divider cross-fades here instead: the right source is as opaque as the share of the map
   * right of the divider, the left source the share left of it. Documented as a limitation.
   */
  setImagerySplit(split: ImagerySplit | null): void {
    this.imagerySplit = split;
    if (this.map && this.styleReady) this.applySplitFade(this.map);
  }

  private applySplitFade(map: MapLike): void {
    for (const o of this.rasterOverlays) {
      const id = rasterOverlayLayerId(o.id);
      if (map.getLayer(id))
        map.setPaintProperty(id, 'raster-opacity', fadeOpacity(this.imagerySplit, o.providerId, o.opacity ?? 1));
    }
    map.triggerRepaint();
  }

  /**
   * Make the map's raster overlay sources/layers equal the list, keeping what did not change
   * (`planRasterOverlays`): an overlay that stays keeps its source, layer and loaded tiles, and
   * a new frame of a radar or satellite layer is added right above the frame it replaces, which
   * leaves after `FRAME_HANDOVER_MS`. Rebuilding every overlay whenever one changed made the
   * whole stack blink each time the radar advanced a frame. New ones go beneath the next
   * overlay in the list, the last beneath the night shading, the reference borders or the
   * world's first layer.
   */
  private applyRasterOverlays(map: MapLike): void {
    const drawable: RasterOverlay[] = [];
    const reported = new Set<string>();
    for (const o of this.rasterOverlays) {
      const spec = rasterOverlaySpec(o);
      if ('unsupported' in spec) {
        if (!this.rasterReported.has(o.id))
          this.emit('error', { message: `overlay: ${spec.unsupported}; not drawn in 2D`, fatal: false });
        reported.add(o.id);
        continue;
      }
      drawable.push(o);
    }
    this.rasterReported = reported;
    const present = this.rasterHeld.filter((h) => map.getLayer(rasterOverlayLayerId(h.id)));
    const plan = planRasterOverlays(present, drawable);
    if (plan.add.length === 0 && plan.remove.length === 0 && plan.retire.length === 0) {
      this.rasterHeld = present;
      return;
    }
    for (const id of plan.remove) this.removeRasterOverlay(map, id);
    for (const id of plan.retire) this.retireRasterOverlay(map, id, FRAME_HANDOVER_MS, FRAME_HANDOVER_MS);
    const base = this.firstNightLayerId(map) ?? this.firstReferenceLayerId(map) ?? this.firstOverlayLayerId(map);
    for (const { overlay, before } of [...plan.add].reverse()) {
      const spec = rasterOverlaySpec(overlay);
      if ('unsupported' in spec) continue;
      // The same id coming back while its earlier layer is still retiring: that one goes now.
      this.removeRasterOverlay(map, overlay.id);
      map.addSource(spec.sourceId, spec.source);
      map.addLayer(spec.layer, before !== undefined ? rasterOverlayLayerId(before) : base);
    }
    this.rasterHeld = drawable.map(heldRasterOverlay);
    if (this.imagerySplit) this.applySplitFade(map);
  }

  /** Take a replaced frame off once the map has its successor's tiles (FRAME_HANDOVER_MS). */
  private retireRasterOverlay(map: MapLike, id: string, wait: number, waited: number): void {
    const timer = this.setTimer(() => {
      if (this.rasterRetiring.get(id) !== timer) return;
      this.rasterRetiring.delete(id);
      if (this.map !== map) return;
      if (map.areTilesLoaded?.() === false && waited < FRAME_HANDOVER_MAX_MS) {
        this.retireRasterOverlay(map, id, FRAME_HANDOVER_CHECK_MS, waited + FRAME_HANDOVER_CHECK_MS);
        return;
      }
      this.removeRasterOverlay(map, id);
    }, wait);
    this.rasterRetiring.set(id, timer);
  }

  /** Take one overlay's layer and source off the map, and forget a handover timer it had. */
  private removeRasterOverlay(map: MapLike, id: string): void {
    const timer = this.rasterRetiring.get(id);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.rasterRetiring.delete(id);
    }
    if (map.getLayer(rasterOverlayLayerId(id))) map.removeLayer(rasterOverlayLayerId(id));
    if (map.getSource(rasterOverlaySourceId(id))) map.removeSource(rasterOverlaySourceId(id));
    this.rasterFailing.delete(rasterOverlaySourceId(id));
    this.rasterTilesOk.delete(rasterOverlaySourceId(id));
  }

  /** Forget every handover under way (the style changed, or the renderer is disposed). */
  private cancelRasterHandovers(): void {
    for (const timer of this.rasterRetiring.values()) this.clearTimer(timer);
    this.rasterRetiring.clear();
  }

  // ── day and night (night.ts) ─────────────────────────────────────────────────
  setDayNight(on: boolean): void {
    if (on === this.dayNightOn) return;
    this.dayNightOn = on;
    if (this.nightTimer !== undefined) this.clearTimer(this.nightTimer);
    this.nightTimer = undefined;
    if (on) this.scheduleNight();
    if (this.map && this.styleReady) this.applyNight(this.map);
  }

  /** Re-draw the night side once a minute while it is shown. */
  private scheduleNight(): void {
    this.nightTimer = this.setTimer(() => {
      this.nightTimer = undefined;
      if (!this.dayNightOn || this.disposed) return;
      const source = this.map?.getSource(NIGHT_SOURCE);
      source?.setData(nightCollection(this.wallNow()) as unknown as GeoJsonFeatureCollection);
      this.scheduleNight();
    }, DAY_NIGHT_REFRESH_MS);
  }

  /** Add or remove the night layers to match the switch: above the basemap and overlays, below the reference. */
  private applyNight(map: MapLike): void {
    for (const id of NIGHT_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(NIGHT_SOURCE)) map.removeSource(NIGHT_SOURCE);
    if (!this.dayNightOn) return;
    map.addSource(NIGHT_SOURCE, nightSource(this.wallNow()));
    const before = this.firstReferenceLayerId(map) ?? this.firstOverlayLayerId(map);
    for (const spec of nightLayers()) map.addLayer(spec, before);
  }

  private firstNightLayerId(map: MapLike): string | undefined {
    for (const id of NIGHT_LAYER_IDS) if (map.getLayer(id)) return id;
    return undefined;
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
    // Nor the night shading: beneath the reference, above what follows.
    this.applyNight(map);
    // Nor any of the raster overlays: add them again, beneath the reference.
    this.cancelRasterHandovers();
    this.rasterHeld = [];
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

  /**
   * Canvas pixels for each position (WorldRenderer.project). The map repeats the world side
   * by side and its centre longitude is unwrapped once dragged across the antimeridian, so
   * a camera at 179.9° seen from a centre of −179.9° + 360 must be projected on the copy
   * next to the view, not a whole world away: each longitude is moved by whole turns to the
   * one nearest the centre first. A point off the canvas is `null`.
   */
  project(positions: readonly GeoPosition[]): Array<ScreenPoint | null> {
    const map = this.map;
    if (!map || this.suspended) return positions.map(() => null);
    const canvas = map.getCanvas();
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const centreLon = map.getCenter().lng;
    return positions.map((p) => {
      const lon = p.longitude + 360 * Math.round((centreLon - p.longitude) / 360);
      const s = map.project([lon, p.latitude]);
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
      return s.x >= 0 && s.y >= 0 && s.x <= width && s.y <= height ? { x: s.x, y: s.y } : null;
    });
  }

  setView(view: Partial<ViewState>, opts: { animate?: boolean; durationMs?: number } = {}): void {
    const target = viewStateToMap(view, this.getView(), this.viewportPx());
    this.lastView = { ...this.lastView, ...view };
    if (!this.map) return;
    this.cancelCameraModes();
    if (opts.animate) this.map.easeTo({ ...target, duration: opts.durationMs ?? 600 });
    else this.map.jumpTo(target);
  }

  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts: FlyToOptions = {},
  ): Promise<void> {
    const dest = resolveMapFlyTarget(target, this.getView(), this.viewportPx());
    const map = this.map;
    this.cancelCameraModes();
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
      else
        map.flyTo({
          center: dest.center,
          zoom: dest.zoom,
          duration,
          essential: true,
          ...(opts.pitchDegrees !== undefined && Number.isFinite(opts.pitchDegrees)
            ? { pitch: pitchDegreesToMapLibre(opts.pitchDegrees) }
            : {}),
          ...(opts.headingDegrees !== undefined && Number.isFinite(opts.headingDegrees)
            ? { bearing: normalizeBearing(opts.headingDegrees) }
            : {}),
        });
    });
  }

  // ── looks and camera modes ─────────────────────────────────────────────────
  setVisualStyle(id: VisualStyleId): void {
    this.visualStyleId = id;
    this.visualStyle?.set(id);
  }

  get visualStyleShown(): VisualStyleId {
    return this.visualStyleId;
  }

  get cameraMode(): CameraModeState {
    return { orbit: this.orbitOn, follow: this.followId };
  }

  /**
   * Orbit in 2D: the map turns round its centre, a quarter turn per linear `easeTo` — MapLibre
   * draws the frames of its own animation and nothing more, and the next quarter is started
   * a frame after the last ends (never from inside its `moveend`, which a jump — system
   * reduced motion — would turn into a loop).
   */
  setOrbit(on: boolean): void {
    if (on === this.orbitOn || this.suspended) return;
    if (!on) {
      this.stopOrbit();
      return;
    }
    const wasFollowing = this.followId !== null;
    this.endFollow();
    this.orbitOn = true;
    this.orbitQuarter();
    if (wasFollowing) this.emitCameraMode();
  }

  private orbitQuarter(): void {
    const map = this.map;
    if (!map || !this.orbitOn) return;
    // Anything still animating ends here, so the moveend heard below is this ease's own.
    map.stop();
    map.once('moveend', () => {
      if (!this.orbitOn) return;
      this.orbitFrame = this.scheduler.request(() => {
        this.orbitFrame = undefined;
        this.orbitQuarter();
      });
    });
    map.easeTo({ bearing: map.getBearing() + 90, duration: ORBIT_QUARTER_MS, easing: linear, essential: true });
  }

  private stopOrbit(): void {
    if (!this.orbitOn) return;
    this.orbitOn = false;
    if (this.orbitFrame !== undefined) this.scheduler.cancel(this.orbitFrame);
    this.orbitFrame = undefined;
    this.map?.stop();
  }

  follow(featureId: string | null, opts: { durationMs?: number } = {}): void {
    if (featureId === this.followId) return;
    if (featureId === null) {
      this.endFollow();
      return;
    }
    const map = this.map;
    const at = this.followPosition(featureId);
    if (!map || !at) {
      this.endFollow();
      this.emitCameraMode();
      return;
    }
    const wasOrbiting = this.orbitOn;
    this.stopOrbit();
    this.followId = featureId;
    this.followEngaged = false;
    map.stop();
    map.once('moveend', () => {
      if (this.followId === featureId) this.followEngaged = true;
    });
    map.flyTo({
      center: at,
      zoom: Math.max(map.getZoom(), 8),
      duration: opts.durationMs ?? 1000,
      essential: true,
    });
    if (wasOrbiting) this.emitCameraMode();
  }

  /** Where the followed feature is drawn now: along its motion, or at its report. */
  private followPosition(id: string, nowMs = this.wallNow()): [number, number] | undefined {
    const moving = this.motion.position(id, nowMs);
    if (moving) return moving;
    const f = this.features.get(id);
    return f?.geometry.kind === 'point' ? [f.geometry.position.longitude, f.geometry.position.latitude] : undefined;
  }

  private recentre(map: MapLike, nowMs: number): void {
    const at = this.followPosition(this.followId!, nowMs);
    if (!at) return;
    this.followJumping = true;
    try {
      map.jumpTo({ center: at });
    } finally {
      this.followJumping = false;
    }
  }

  /** After an update: the followed feature gone ends the follow; a new report of a still one re-centres. */
  private followChanged(reported: boolean): void {
    if (this.followId === null) return;
    if (!this.features.has(this.followId)) {
      this.endFollow();
      this.emitCameraMode();
      return;
    }
    if (reported && this.followEngaged && !this.motion.active.has(this.followId) && this.map)
      this.recentre(this.map, this.wallNow());
  }

  private endFollow(): void {
    this.followId = null;
    this.followEngaged = false;
  }

  /** Something else moves the camera (a flight, a new view, the renderer hidden): both modes end. */
  private cancelCameraModes(): void {
    if (!this.orbitOn && this.followId === null) return;
    this.stopOrbit();
    this.endFollow();
    this.emitCameraMode();
  }

  private emitCameraMode(): void {
    this.emit('cameraMode', this.cameraMode);
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

  /** The point on the map under the pointer, once a frame; `null` once the pointer has left. */
  private runPointer(): void {
    const map = this.map;
    const p = this.pointerAt;
    if (!map) return;
    const lngLat = p ? map.unproject([p.x, p.y]) : undefined;
    if (!p || !lngLat || !Number.isFinite(lngLat.lat) || !Number.isFinite(lngLat.lng)) {
      if (this.pointerOnMap) {
        this.pointerOnMap = false;
        this.emit('pointer', null);
      }
      return;
    }
    this.pointerOnMap = true;
    this.emit('pointer', {
      position: { latitude: lngLat.lat, longitude: wrapLongitude(lngLat.lng) },
      screen: { x: p.x, y: p.y },
    });
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

  setGraphics(profile: GraphicsProfile): void {
    this.graphics = profile;
    this.map?.setPixelRatio?.(pixelRatioFor(profile, displayPixelRatio()));
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
    this.pointerPass?.cancel();
    this.cancelMotion();
    if (this.nightTimer !== undefined) this.clearTimer(this.nightTimer);
    this.nightTimer = undefined;
    this.cancelRasterHandovers();
    if (this.orbitFrame !== undefined) this.scheduler.cancel(this.orbitFrame);
    this.orbitOn = false;
    this.followId = null;
    this.visualStyle?.dispose();
    this.attribution?.dispose();
    this.map?.remove();
    this.map = undefined;
    this.features.clear();
  }
}

function withSelected(f: RenderFeature): RenderFeature {
  return f.style.selected ? f : { ...f, style: { ...f.style, selected: true } };
}

function displayPixelRatio(): number {
  return typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

/** A longitude the flat map may report past ±180° (a world copy), brought into [−180, 180). */
function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
