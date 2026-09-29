import type {
  AttributionEntry,
  BasemapDescriptor,
  CameraModeState,
  CanvasFactory,
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
  ScreenPoint,
  TerrainDescriptor,
  Theme,
  ViewState,
  VisualStyleId,
  WorldRenderer,
} from '@worldview/render-core';
import { createFrameScheduler, FrameCoalescer, type FrameScheduler } from '@worldview/render-core';
import type { GeoBounds, GeoPosition, RasterOverlay } from '@worldview/world-model';
import type {
  Cartesian3Like,
  CesiumLike,
  ScreenSpaceEventHandlerLike,
  TerrainProviderLike,
  ViewerLike,
} from './cesium-like.js';
import { applyGraphics, createWorldViewer, installTrackpadPinchZoom } from './viewer.js';
import {
  buildCesiumStackRegistry,
  MapStackController,
  stackIdForBasemap,
  type MapStackState,
  type StackRegistryOptions,
} from './basemaps.js';
import { terrainSourceFor, type TerrainResolverOptions, type TerrainSource } from './terrain.js';
import { CreditSync, createMapCredits } from './attribution.js';
import { RasterOverlays3D } from './raster-overlays.js';
import { CesiumTheme } from './theme.js';
import { createSpriteSheet, domCanvasFactory, type SpriteSheet } from './sprites.js';
import { LayerSet } from './layers/layerSet.js';
import { pickAnchor, resolvePickedFeatureId, toPickResult } from './picking.js';
import { altitudeForBounds, cameraToViewState, resolveFlyTarget, viewStateToCamera } from './view.js';
import { ALWAYS_VISIBLE, cameraMoved, horizonTest, type HorizonTest, type Vec3 } from './horizon.js';
import { REFERENCE_LABEL_ID_PREFIX, ReferenceOverlay3D } from './reference-overlay.js';
import { motionStepMs } from './layers/motion.js';
import { ModelLayer } from './layers/models.js';
import { VisualStyle3D } from './visual-styles.js';
import { DayNight3D, type DayNightTimers } from './day-night.js';
import { CameraModes3D } from './camera-modes.js';

export interface CesiumWorldRendererOptions {
  cesium: CesiumLike;
  /** Canvas factory for sprite generation (defaults to the DOM). */
  createCanvas?: CanvasFactory;
  theme?: Theme;
  scheduler?: FrameScheduler;
  stacks?: StackRegistryOptions;
  terrain?: TerrainResolverOptions;
  /** Credit container; created inside the mount container when absent. */
  creditContainer?: Element;
  powerPreference?: 'default' | 'low-power' | 'high-performance';
  /** GPU cost profile to start with (render-core graphics.ts); `setGraphics` changes it later. */
  graphics?: GraphicsProfile;
  now?: () => number;
  /** Wall-clock time in epoch ms — what RenderFeature.motion is in (default Date.now). */
  wallNow?: () => number;
  /**
   * Where page visibility changes are heard (default: `document`). Injectable so the frame
   * counter's handling of a hidden window can be tested without a DOM.
   */
  visibility?: VisibilityTarget;
  /**
   * Builds the per-camera horizon test that hides markers behind the Earth (horizon.ts).
   * Injectable because the test double's coordinates are not Earth-fixed metres.
   */
  horizon?: (camera: Vec3) => HorizonTest;
  /** Interval timers for the day/night refresh (default the global ones); injectable for tests. */
  timers?: DayNightTimers;
  /**
   * Where the bundled 3D models are served, ending in `/` (the shell's `./models/`). Absent:
   * no models, whatever the graphics profile says — there is nothing to load them from.
   */
  modelBaseUrl?: string;
}

const GLOBAL_TIMERS: DayNightTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** The slice of `document` the frame counter listens to. */
export interface VisibilityTarget {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

const DEFAULT_VIEW: ViewState = {
  center: { latitude: 20, longitude: 0 },
  altitudeM: 20_000_000,
  zoom: 1.5,
  headingDegrees: 0,
  pitchDegrees: -90,
};

/**
 * CesiumWorldRenderer — the 3D adapter. Thin: every decision that does not need a
 * GPU lives in the pure modules (featureRouter, view, picking, labelDeclutter,
 * basemaps registry, theme) and this class wires them to the viewer.
 */
export class CesiumWorldRenderer implements WorldRenderer {
  readonly capabilities: RendererCapabilities = {
    mode: '3D',
    terrain: true,
    tilt: true,
    clustering: false,
    maxFeatures: 100_000,
  };
  private readonly cesium: CesiumLike;
  private readonly theme: CesiumTheme;
  private readonly scheduler: FrameScheduler;
  private readonly listeners: { [K in keyof RendererEvents]?: Set<(p: RendererEvents[K]) => void> } = {};
  private viewer: ViewerLike | undefined;
  private layers: LayerSet | undefined;
  private sprites: SpriteSheet | undefined;
  private stacks: MapStackController | undefined;
  private credits: CreditSync | undefined;
  private handler: ScreenSpaceEventHandlerLike | undefined;
  private removePinch: (() => void) | undefined;
  private cameraUnsubs: Array<() => void> = [];
  private declutterPass: FrameCoalescer | undefined;
  private hoverPass: FrameCoalescer | undefined;
  private pendingHover: { x: number; y: number } | undefined;
  private lastHoverId: string | null = null;
  private cameraMoving = false;
  private horizonCamera: Vec3 | undefined;
  private selectedId: string | null = null;
  private lastView: ViewState = DEFAULT_VIEW;
  private terrainCache = new Map<string, Promise<TerrainProviderLike>>();
  private terrainGen = 0;
  private terrainAbort = new AbortController();
  private frames = 0;
  /** Render-loop ticks this second, drawn or not (request-render mode skips idle ones). */
  private ticks = 0;
  private graphics: GraphicsProfile | undefined;
  private frameWindowStart = 0;
  private lastFrameAt = Number.NaN;
  private longestFrameMs = 0;
  /** When moving markers were last stepped (the frame clock, `now`). */
  private lastMotionStepAt = Number.NEGATIVE_INFINITY;
  /** Scene.render start (preUpdate) of the frame being drawn, and the longest render this second. */
  private renderStartedAt = Number.NaN;
  private longestRenderMs = 0;
  private suspended = false;
  private disposed = false;
  private ownedCreditContainer: HTMLElement | undefined;
  private readonly now: () => number;
  private stackState: MapStackState | undefined;
  private referenceOverlay: ReferenceOverlay3D | undefined;
  private rasterOverlays: RasterOverlays3D | undefined;
  private pendingOverlays: readonly RasterOverlay[] = [];
  private reference: { data: ReferenceData | null; options: ReferenceOptions } | undefined;
  private currentHorizon: HorizonTest = ALWAYS_VISIBLE;
  private visualStyleId: VisualStyleId = 'standard';
  private visualStyle: VisualStyle3D | undefined;
  private dayNightOn = false;
  private dayNight: DayNight3D | undefined;
  private cameraModes: CameraModes3D | undefined;
  private models: ModelLayer | undefined;
  private imagerySplit: ImagerySplit | null = null;

  constructor(private readonly options: CesiumWorldRendererOptions) {
    this.cesium = options.cesium;
    this.theme = new CesiumTheme(options.cesium, options.theme);
    this.scheduler = options.scheduler ?? createFrameScheduler();
    this.now = options.now ?? (() => this.scheduler.now());
    this.graphics = options.graphics;
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
    if (this.viewer) return;
    let creditContainer = this.options.creditContainer;
    if (!creditContainer) {
      const el = container.ownerDocument.createElement('div');
      el.className = 'worldview-credits';
      container.appendChild(el);
      this.ownedCreditContainer = el;
      creditContainer = el;
    }
    const viewer = createWorldViewer(this.cesium, {
      container,
      creditContainer,
      ...(this.options.powerPreference ? { powerPreference: this.options.powerPreference } : {}),
      ...(this.graphics ? { graphics: this.graphics } : {}),
    });
    this.viewer = viewer;
    this.sprites = createSpriteSheet(this.options.createCanvas ?? domCanvasFactory());
    this.layers = new LayerSet(this.cesium, this.theme, this.sprites, viewer, this.options.wallNow ?? Date.now);
    this.credits = new CreditSync(viewer.creditDisplay, (html, onScreen) => new this.cesium.Credit(html, onScreen));
    this.stacks = new MapStackController(viewer, {
      registry: buildCesiumStackRegistry(this.cesium, this.options.stacks ?? {}),
      createImageryLayer: (provider) => this.cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider)),
      credits: createMapCredits(viewer.creditDisplay, (html, onScreen) => new this.cesium.Credit(html, onScreen)),
      onChange: (state) => {
        this.stackState = state;
      },
      onError: (message) => this.emit('error', { message: `basemap: ${message}`, fatal: false }),
    });
    this.rasterOverlays = new RasterOverlays3D(this.cesium, viewer, (message) =>
      this.emit('error', { message, fatal: false }),
    );
    if (this.pendingOverlays.length) this.rasterOverlays.set(this.pendingOverlays);
    if (this.imagerySplit) this.rasterOverlays.setSplit(this.imagerySplit);
    if (this.options.modelBaseUrl !== undefined) {
      const layers = this.layers;
      this.models = new ModelLayer({
        cesium: this.cesium,
        scene: viewer.scene,
        creditDisplay: viewer.creditDisplay,
        baseUrl: this.options.modelBaseUrl,
        movers: layers.movers,
        features: () => this.modelCandidates(),
        hideMarker: (id, hidden) => layers.setMarkerHidden(id, hidden),
        selectedColor: new this.cesium.Color(1, 1, 1, 1),
        wallNow: this.options.wallNow ?? Date.now,
        onError: (message) => this.emit('error', { message, fatal: false }),
      });
      this.models.setEnabled(this.graphics?.models3d ?? false);
    }
    this.referenceOverlay = new ReferenceOverlay3D(this.cesium, viewer, () => this.declutterPass?.schedule());
    if (this.reference) this.referenceOverlay.set(this.reference.data, this.reference.options);
    this.removePinch = installTrackpadPinchZoom(this.cesium, viewer);
    this.visualStyle = new VisualStyle3D(this.cesium, viewer.scene);
    this.visualStyle.set(this.visualStyleId);
    this.dayNight = new DayNight3D(
      this.cesium,
      viewer,
      this.options.wallNow ?? Date.now,
      this.options.timers ?? GLOBAL_TIMERS,
    );
    this.dayNight.set(this.dayNightOn);
    this.cameraModes = new CameraModes3D({
      cesium: this.cesium,
      viewer,
      now: () => this.now(),
      wallNow: this.options.wallNow ?? Date.now,
      feature: (id) => this.layers?.store.get(id),
      changed: (state) => this.emit('cameraMode', state),
    });
    this.installInput(viewer);
    this.installCameraEvents(viewer);
    this.declutterPass = new FrameCoalescer(this.scheduler, () => this.runDeclutter());
    this.hoverPass = new FrameCoalescer(this.scheduler, () => this.runHover());
    viewer.camera.setView(this.cameraOptions(viewStateToCamera({}, this.lastView)));
    await this.stacks.setStack(this.stacks.getActiveId(), { silent: true });
    this.emit('ready', undefined);
  }

  private installInput(viewer: ViewerLike): void {
    const handler = new this.cesium.ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction((e) => {
      if (e.position) this.emit('pick', this.pickAt(e.position));
    }, this.cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e) => {
      if (e.endPosition) {
        this.pendingHover = { x: e.endPosition.x, y: e.endPosition.y };
        this.hoverPass?.schedule();
      }
    }, this.cesium.ScreenSpaceEventType.MOUSE_MOVE);
    // The operator taking hold of the camera ends an orbit (camera-modes.ts). Pointer down
    // rather than click: a drag is not a click, and the orbit must stop before the controller
    // applies the drag, so the drag pans the globe as it always does.
    const takeHold = () => this.cameraModes?.userInput();
    const types = this.cesium.ScreenSpaceEventType;
    for (const type of [types.LEFT_DOWN, types.RIGHT_DOWN, types.MIDDLE_DOWN, types.WHEEL, types.PINCH_START])
      handler.setInputAction(takeHold, type);
    // Trackpad pinch arrives as Ctrl+wheel (installTrackpadPinchZoom), a binding of its own.
    handler.setInputAction(takeHold, types.WHEEL, this.cesium.KeyboardEventModifier.CTRL);
    this.handler = handler;
  }

  private installCameraEvents(viewer: ViewerLike): void {
    viewer.camera.percentageChanged = 0.01;
    const onChanged = () => {
      this.lastView = this.readView();
      this.emit('viewChanged', this.lastView);
      this.declutterPass?.schedule();
    };
    this.cameraUnsubs.push(
      viewer.camera.changed.addEventListener(onChanged),
      viewer.camera.moveEnd.addEventListener(onChanged),
      // Hover is not resolved while the camera moves. A drag moves the pointer every frame,
      // and each hover resolution is a `scene.pick` — a second render of every primitive into
      // a pick buffer, then a synchronous read back from the GPU — so dragging the globe paid
      // for two renders a frame, and every dot that slid under the cursor restyled the map.
      // Whatever the pointer rests on is resolved once the camera settles.
      viewer.camera.moveStart.addEventListener(() => {
        this.cameraMoving = true;
      }),
      viewer.camera.moveEnd.addEventListener(() => {
        this.cameraMoving = false;
        if (this.pendingHover) this.hoverPass?.schedule();
      }),
    );
    this.restartFrameWindow();
    // Chromium stops or throttles frames for a hidden or fully covered window. The first
    // frame back then closed a "second" that had lasted as long as the window was hidden and
    // reported it as 0 or 1 fps — the operator's perf log showed exactly that, in windows
    // where nothing else was happening. That is the page being away, not the machine being
    // slow, so the measurement restarts whenever visibility changes. A freeze while visible
    // still counts, which is the case the performance governor exists for.
    const target: VisibilityTarget | undefined =
      this.options.visibility ?? (typeof document !== 'undefined' ? document : undefined);
    if (target) {
      const restart = () => this.restartFrameWindow();
      target.addEventListener('visibilitychange', restart);
      this.cameraUnsubs.push(() => target.removeEventListener('visibilitychange', restart));
    }
    // Markers are not depth-tested (layers/depth.ts); the Earth hides them here instead, on
    // every frame the camera has moved — the horizon moves with it — before it is drawn.
    const buildHorizon = this.options.horizon ?? horizonTest;
    this.cameraUnsubs.push(
      viewer.scene.preRender.addEventListener(() => {
        const layers = this.layers;
        if (!layers) return;
        const c = viewer.camera.positionWC;
        if (!cameraMoved(this.horizonCamera, c)) return;
        this.horizonCamera = { x: c.x, y: c.y, z: c.z };
        this.currentHorizon = buildHorizon(this.horizonCamera);
        layers.setHorizon(this.currentHorizon);
        this.referenceOverlay?.update(this.lastView.zoom, this.currentHorizon);
      }),
    );
    // Close in, the nearest aircraft and ships are drawn as 3D models (layers/models.ts),
    // chosen again before a frame when the camera or the features have moved. It asks for no
    // frame of its own; the models move with the markers' step below.
    this.cameraUnsubs.push(
      viewer.scene.preRender.addEventListener(() => {
        this.models?.update(viewer.camera.positionCartographic);
      }),
    );
    // Markers with motion (satellites between two propagations, aircraft and ships dead
    // reckoned) are stepped before the frame is drawn, as often as the zoom and the fastest of
    // them make a step visible (layers/motion.ts): every two seconds with the whole globe in
    // view, up to 30 times a second close in.
    this.cameraUnsubs.push(
      viewer.scene.preRender.addEventListener(() => {
        const layers = this.layers;
        if (!layers || !layers.movers.size) return;
        const t = this.now();
        const canvasPx = viewer.canvas?.clientHeight || 600;
        // Metres per pixel at the point below the camera: its height across the default 60° view.
        const mpp = (this.lastView.altitudeM * 2 * Math.tan(Math.PI / 6)) / canvasPx;
        if (t - this.lastMotionStepAt < motionStepMs(mpp, layers.movers.maxSpeedMps)) return;
        this.lastMotionStepAt = t;
        layers.animate();
      }),
    );
    // A followed object is kept in the middle of the view in the frame its marker moved in
    // (camera-modes.ts); after the step above, so both use the same position.
    this.cameraUnsubs.push(viewer.scene.preRender.addEventListener(() => this.cameraModes?.beforeRender()));
    // preUpdate runs on every tick of the render loop, drawn or not: in request-render mode
    // (viewer.ts) an idle tick ends right after it. So the frame clock lives here.
    //
    // The rate reported is the loop's, not the drawn frames'. A still view draws almost
    // nothing on purpose; counting only drawn frames would tell the performance governor the
    // machine is failing when it is resting. A machine that cannot keep up still shows here:
    // the loop only ticks again once the last frame is done, so a slow frame is a long gap
    // between two ticks (maxFrameMs) and fewer ticks in the second.
    //
    // It is also where the frames moving markers need are asked for — at the step rate
    // motion.ts allows for the zoom, not on every vsync.
    this.cameraUnsubs.push(
      viewer.scene.preUpdate.addEventListener(() => {
        // An orbit turns the camera and asks for this frame; nothing else here draws.
        this.cameraModes?.tick();
        const t = this.now();
        this.ticks++;
        if (Number.isFinite(this.lastFrameAt))
          this.longestFrameMs = Math.max(this.longestFrameMs, t - this.lastFrameAt);
        this.lastFrameAt = t;
        // How long Cesium itself takes over a frame — the primitives' update and the draw —
        // so a long frame can be told apart from the page's own work and a late GPU.
        this.renderStartedAt = t;
        if (t - this.frameWindowStart >= 1000) {
          this.emit('frame', {
            fps: Math.round((this.ticks * 1000) / (t - this.frameWindowStart)),
            featureCount: this.layers?.featureCount ?? 0,
            maxFrameMs: Math.round(this.longestFrameMs),
            engineMaxMs: Math.round(this.longestRenderMs * 10) / 10,
          });
          this.frames = 0;
          this.ticks = 0;
          this.frameWindowStart = t;
          this.longestFrameMs = 0;
          this.longestRenderMs = 0;
        }
        const layers = this.layers;
        if (!layers || !layers.movers.size) return;
        const canvasPx = viewer.canvas?.clientHeight || 600;
        const mpp = (this.lastView.altitudeM * 2 * Math.tan(Math.PI / 6)) / canvasPx;
        if (t - this.lastMotionStepAt >= motionStepMs(mpp, layers.movers.maxSpeedMps)) viewer.scene.requestRender();
      }),
    );
    this.cameraUnsubs.push(
      viewer.scene.postRender.addEventListener(() => {
        this.frames++;
        if (Number.isFinite(this.renderStartedAt)) {
          this.longestRenderMs = Math.max(this.longestRenderMs, this.now() - this.renderStartedAt);
          this.renderStartedAt = Number.NaN;
        }
      }),
    );
  }

  /** Measurement starts over: after the window was hidden, or the render loop was stopped. */
  private restartFrameWindow(): void {
    this.frames = 0;
    this.ticks = 0;
    this.frameWindowStart = this.now();
    this.lastFrameAt = Number.NaN;
    this.longestFrameMs = 0;
    this.longestRenderMs = 0;
    this.renderStartedAt = Number.NaN;
  }

  unmount(): void {
    this.dispose();
  }

  suspend(): void {
    if (!this.viewer || this.suspended) return;
    this.suspended = true;
    // A hidden globe does not keep turning, nor keep a lock on an object nobody sees.
    this.cameraModes?.cancelAll();
    this.viewer.useDefaultRenderLoop = false;
  }

  resume(): void {
    if (!this.viewer || !this.suspended) return;
    this.suspended = false;
    // The time spent suspended (the 2D map was showing) is not a frame this machine was slow
    // to draw; without this the first second back reported itself as 0 or 1 fps.
    this.restartFrameWindow();
    this.viewer.useDefaultRenderLoop = true;
    this.viewer.scene.requestRender();
  }

  // ── features ───────────────────────────────────────────────────────────────
  update(update: FeatureUpdate): void {
    if (!this.layers) return;
    const selected = this.selectedId;
    this.layers.apply(update, selected ? (f) => (f.id === selected ? withSelected(f) : f) : undefined);
    this.models?.featuresChanged();
    this.declutterPass?.schedule();
    this.viewer?.scene.requestRender();
    this.cameraModes?.featuresChanged();
  }

  clear(layer?: string): void {
    this.layers?.clear(layer);
    this.models?.featuresChanged();
    this.viewer?.scene.requestRender();
    this.cameraModes?.featuresChanged();
  }

  select(featureId: string | null): void {
    if (featureId === this.selectedId) return;
    const previous = this.selectedId;
    this.selectedId = featureId;
    if (!this.layers) return;
    if (previous) this.layers.restyle(previous, (f) => f);
    if (featureId) this.layers.restyle(featureId, withSelected);
    this.models?.featuresChanged();
    this.viewer?.scene.requestRender();
  }

  feature(id: string): RenderFeature | undefined {
    return this.layers?.store.get(id);
  }

  /** Every held feature as it is drawn (the selected one marked), for the models to choose from. */
  private *modelCandidates(): Iterable<RenderFeature> {
    const layers = this.layers;
    if (!layers) return;
    const selected = this.selectedId;
    for (const { feature } of layers.store.values()) yield feature.id === selected ? withSelected(feature) : feature;
  }

  /** The 3D models now: objects drawn as one, objects given one (ready or not), instances alive. */
  get modelState(): { drawn: string[]; assigned: string[]; instances: number; enabled: boolean } {
    const m = this.models;
    return m
      ? { drawn: m.drawn, assigned: m.assigned, instances: m.instances, enabled: m.isEnabled }
      : { drawn: [], assigned: [], instances: 0, enabled: false };
  }
  get featureCount(): number {
    return this.layers?.featureCount ?? 0;
  }

  // ── view ───────────────────────────────────────────────────────────────────
  private readView(): ViewState {
    const v = this.viewer;
    if (!v) return this.lastView;
    const c = v.camera.positionCartographic;
    const rect = v.camera.computeViewRectangle();
    const focus = this.focusPoint();
    const view = cameraToViewState({
      longitude: c.longitude,
      latitude: c.latitude,
      height: c.height,
      heading: v.camera.heading,
      pitch: v.camera.pitch,
      ...(rect ? { rectangle: rect } : {}),
      ...(this.viewportPx() ? { viewportPx: this.viewportPx()! } : {}),
    });
    if (focus) view.focus = focus;
    return view;
  }

  /** The ground at the middle of the canvas (undefined when the middle is sky). */
  private focusPoint(): GeoPosition | undefined {
    const v = this.viewer;
    const canvas = v?.scene.canvas;
    if (!v || !canvas) return undefined;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (!w || !h) return undefined;
    const hit = v.camera.pickEllipsoid(new this.cesium.Cartesian2(w / 2, h / 2));
    const carto = hit ? this.cesium.Cartographic.fromCartesian(hit) : undefined;
    if (!carto) return undefined;
    return {
      latitude: this.cesium.Math.toDegrees(carto.latitude),
      longitude: this.cesium.Math.toDegrees(carto.longitude),
    };
  }

  /** The canvas's larger dimension in CSS pixels, when it has been laid out. */
  private viewportPx(): number | undefined {
    const canvas = this.viewer?.scene.canvas;
    const px = canvas ? Math.max(canvas.clientWidth, canvas.clientHeight) : 0;
    return px > 0 ? px : undefined;
  }

  getView(): ViewState {
    return this.viewer ? this.readView() : this.lastView;
  }

  /**
   * Canvas pixels for each position (WorldRenderer.project). `worldToWindowCoordinates`
   * happily answers for a point on the far side of the planet — it is in front of the camera,
   * only the Earth is in the way — so the same horizon test that hides markers there
   * (horizon.ts) is made first, against the camera where it is now rather than where the
   * last frame left it: this is called while the camera moves. A point off the canvas is
   * `null`. Nothing here requests a frame.
   */
  project(positions: readonly GeoPosition[]): Array<ScreenPoint | null> {
    const v = this.viewer;
    if (!v || this.suspended) return positions.map(() => null);
    const scene = v.scene;
    const c = v.camera.positionWC;
    const visible = (this.options.horizon ?? horizonTest)({ x: c.x, y: c.y, z: c.z });
    const width = v.canvas.clientWidth || v.canvas.width;
    const height = v.canvas.clientHeight || v.canvas.height;
    return positions.map((p) => {
      const world = this.cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.altitudeM ?? 0);
      if (!visible(world)) return null;
      const s = this.cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
      return s.x >= 0 && s.y >= 0 && s.x <= width && s.y <= height ? { x: s.x, y: s.y } : null;
    });
  }

  private cameraOptions(t: ReturnType<typeof viewStateToCamera>): {
    destination: Cartesian3Like;
    orientation: { heading: number; pitch: number; roll: number };
  } {
    return {
      destination: this.cesium.Cartesian3.fromDegrees(t.longitude, t.latitude, t.height),
      orientation: { heading: t.heading, pitch: t.pitch, roll: t.roll },
    };
  }

  setView(view: Partial<ViewState>, opts: { animate?: boolean; durationMs?: number } = {}): void {
    const target = viewStateToCamera(view, this.getView(), this.viewportPx());
    this.lastView = { ...this.lastView, ...view };
    if (!this.viewer) return;
    this.cameraModes?.cancelAll();
    const options = this.cameraOptions(target);
    if (opts.animate) this.viewer.camera.flyTo({ ...options, duration: (opts.durationMs ?? 800) / 1000 });
    else this.viewer.camera.setView(options);
  }

  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts: FlyToOptions = {},
  ): Promise<void> {
    const dest = resolveFlyTarget(target, this.getView(), this.viewportPx());
    if (!this.viewer) {
      this.lastView =
        dest.kind === 'point'
          ? { ...this.lastView, center: { latitude: dest.latitude, longitude: dest.longitude }, altitudeM: dest.height }
          : { ...this.lastView, center: target.position, altitudeM: altitudeForBounds(dest.bounds) };
      return Promise.resolve();
    }
    this.cameraModes?.cancelAll();
    const camera = this.viewer.camera;
    const duration = (opts.durationMs ?? 1500) / 1000;
    const pitch = opts.pitchDegrees;
    return new Promise((resolve) => {
      const orientation = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
      if (dest.kind === 'point' && pitch !== undefined && Number.isFinite(pitch) && pitch > -89) {
        // Oblique: the target in the middle of the view, seen from `pitch` at the distance a
        // top-down flight would have put the camera above it — keeping the heading the camera
        // has, so the world does not spin on the way.
        const center = this.cesium.Cartesian3.fromDegrees(
          dest.longitude,
          dest.latitude,
          target.position.altitudeM ?? 0,
        );
        camera.flyToBoundingSphere(this.cesium.createBoundingSphere(center, 0), {
          offset: new this.cesium.HeadingPitchRange(
            camera.heading,
            Math.max(-89, Math.min(-5, pitch)) * (Math.PI / 180),
            dest.height,
          ),
          duration,
          complete: resolve,
          cancel: resolve,
        });
      } else if (dest.kind === 'bounds')
        camera.flyTo({
          destination: this.cesium.Rectangle.fromDegrees(
            dest.bounds.west,
            dest.bounds.south,
            dest.bounds.east,
            dest.bounds.north,
          ),
          orientation,
          duration,
          complete: resolve,
          cancel: resolve,
        });
      else
        camera.flyTo({
          destination: this.cesium.Cartesian3.fromDegrees(dest.longitude, dest.latitude, dest.height),
          orientation,
          duration,
          complete: resolve,
          cancel: resolve,
        });
    });
  }

  // ── picking ────────────────────────────────────────────────────────────────
  private pickAt(screen: { x: number; y: number }): PickResult | null {
    const v = this.viewer;
    if (!v || !this.layers) return null;
    const windowPosition = new this.cesium.Cartesian2(screen.x, screen.y);
    const featureId = resolvePickedFeatureId(v.scene.pick(windowPosition));
    // A place name (reference-overlay.ts) is scenery, not something to select.
    if (!featureId || featureId.startsWith(REFERENCE_LABEL_ID_PREFIX)) return null;
    const feature = this.layers.store.get(featureId);
    if (feature && !feature.interactive) return null;
    const surface = this.surfacePosition(windowPosition);
    const position = pickAnchor(feature, surface);
    if (!position) return null;
    return toPickResult(featureId, feature, position, { x: screen.x, y: screen.y });
  }

  private surfacePosition(windowPosition: { x: number; y: number }): GeoPosition | undefined {
    const v = this.viewer!;
    const cartesian =
      (v.scene.pickPositionSupported ? v.scene.pickPosition(windowPosition) : undefined) ??
      v.camera.pickEllipsoid(windowPosition);
    if (!cartesian) return undefined;
    const carto = this.cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return undefined;
    return {
      latitude: this.cesium.Math.toDegrees(carto.latitude),
      longitude: this.cesium.Math.toDegrees(carto.longitude),
      altitudeM: carto.height,
    };
  }

  private runHover(): void {
    const p = this.pendingHover;
    if (!p || this.cameraMoving) return;
    this.pendingHover = undefined;
    const result = this.pickAt(p);
    const id = result?.featureId ?? null;
    if (id === this.lastHoverId) return;
    this.lastHoverId = id;
    this.emit('hover', result);
  }

  private runDeclutter(): void {
    const v = this.viewer;
    if (!v || !this.layers || this.suspended) return;
    const scene = v.scene;
    const project = (position: Cartesian3Like) => this.cesium.SceneTransforms.worldToWindowCoordinates(scene, position);
    const viewport = {
      width: v.canvas.clientWidth || v.canvas.width,
      height: v.canvas.clientHeight || v.canvas.height,
    };
    this.layers.declutter(project, viewport);
    this.referenceOverlay?.declutter(project, viewport);
    scene.requestRender();
  }

  // ── basemap / terrain / attribution ────────────────────────────────────────
  async setBasemap(basemap: BasemapDescriptor): Promise<void> {
    if (!this.stacks) throw new Error('renderer not mounted');
    const target = stackIdForBasemap(this.stacks, this.cesium, basemap);
    if ('unsupported' in target) {
      this.emit('error', { message: `basemap: ${target.unsupported}`, fatal: false });
      return;
    }
    const state = await this.stacks.setStack(target.stackId);
    if (state.status === 'error' && state.lastError) throw new Error(state.lastError);
  }

  get basemapState(): MapStackState | undefined {
    return this.stackState ?? this.stacks?.getState();
  }

  setOverlays(overlays: readonly RasterOverlay[]): void {
    this.pendingOverlays = overlays;
    this.rasterOverlays?.set(overlays);
  }

  setImagerySplit(split: ImagerySplit | null): void {
    this.imagerySplit = split;
    this.rasterOverlays?.setSplit(split);
  }

  setReference(data: ReferenceData | null, options: ReferenceOptions): void {
    this.reference = { data, options };
    if (!this.referenceOverlay) return;
    this.referenceOverlay.set(data, options);
    this.referenceOverlay.update(this.lastView.zoom, this.currentHorizon);
  }

  async setTerrain(terrain: TerrainDescriptor): Promise<void> {
    const v = this.viewer;
    if (!v) throw new Error('renderer not mounted');
    const source: TerrainSource = terrainSourceFor(this.cesium, terrain, this.options.terrain ?? {});
    const gen = ++this.terrainGen;
    let promise = this.terrainCache.get(source.id);
    if (!promise) {
      promise = source.create({ signal: this.terrainAbort.signal }).catch((err: unknown) => {
        this.terrainCache.delete(source.id);
        throw err;
      });
      this.terrainCache.set(source.id, promise);
    }
    const provider = await promise;
    if (gen !== this.terrainGen || this.disposed) return;
    v.scene.terrainProvider = provider;
    v.scene.globe.depthTestAgainstTerrain = terrain.kind !== 'ellipsoid';
    v.scene.requestRender();
  }

  setAttribution(entries: AttributionEntry[]): void {
    this.credits?.apply(entries);
  }

  setGraphics(profile: GraphicsProfile): void {
    this.graphics = profile;
    if (this.viewer) applyGraphics(this.viewer, profile, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    this.models?.setEnabled(profile.models3d);
  }

  // ── looks and camera modes ─────────────────────────────────────────────────
  setVisualStyle(id: VisualStyleId): void {
    this.visualStyleId = id;
    this.visualStyle?.set(id);
  }

  get visualStyleShown(): VisualStyleId {
    return this.visualStyle?.id ?? this.visualStyleId;
  }

  setDayNight(on: boolean): void {
    this.dayNightOn = on;
    this.dayNight?.set(on);
  }

  setOrbit(on: boolean): void {
    if (this.suspended) return;
    this.cameraModes?.setOrbit(on);
  }

  follow(featureId: string | null, opts?: { durationMs?: number }): void {
    const modes = this.cameraModes;
    if (!modes) return;
    // Nothing to follow (not drawn, or not a point): say so, so whoever asked lets go too.
    if (!modes.follow(featureId, opts)) this.emit('cameraMode', modes.state);
  }

  get cameraMode(): CameraModeState {
    return this.cameraModes?.state ?? { orbit: false, follow: null };
  }

  // ── export ─────────────────────────────────────────────────────────────────
  async screenshot(): Promise<Uint8Array> {
    const v = this.viewer;
    if (!v) throw new Error('renderer not mounted');
    v.render();
    const blob = await new Promise<Blob | null>((resolve) => v.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob returned no data (preserveDrawingBuffer required)');
    return new Uint8Array(await blob.arrayBuffer());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terrainAbort.abort();
    this.declutterPass?.cancel();
    this.hoverPass?.cancel();
    this.cameraModes?.dispose();
    this.dayNight?.dispose();
    this.visualStyle?.dispose();
    for (const u of this.cameraUnsubs.splice(0)) u();
    this.removePinch?.();
    this.handler?.destroy();
    this.credits?.dispose();
    this.stacks?.destroy();
    this.models?.dispose();
    this.models = undefined;
    this.layers?.dispose();
    this.referenceOverlay?.dispose();
    this.referenceOverlay = undefined;
    this.rasterOverlays?.dispose();
    this.rasterOverlays = undefined;
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    this.ownedCreditContainer?.remove();
    this.viewer = undefined;
    this.layers = undefined;
  }
}

function withSelected(f: RenderFeature): RenderFeature {
  return f.style.selected ? f : { ...f, style: { ...f.style, selected: true } };
}
