import type {
  AttributionEntry,
  BasemapDescriptor,
  CanvasFactory,
  FeatureUpdate,
  PickResult,
  RenderFeature,
  RendererCapabilities,
  RendererEvents,
  TerrainDescriptor,
  Theme,
  ViewState,
  WorldRenderer,
} from '@worldview/render-core';
import { createFrameScheduler, FrameCoalescer, type FrameScheduler } from '@worldview/render-core';
import type { GeoBounds, GeoPosition } from '@worldview/world-model';
import type {
  Cartesian3Like,
  CesiumLike,
  ScreenSpaceEventHandlerLike,
  TerrainProviderLike,
  ViewerLike,
} from './cesium-like.js';
import { createWorldViewer, installTrackpadPinchZoom } from './viewer.js';
import {
  buildCesiumStackRegistry,
  MapStackController,
  stackIdForBasemap,
  type MapStackState,
  type StackRegistryOptions,
} from './basemaps.js';
import { terrainSourceFor, type TerrainResolverOptions, type TerrainSource } from './terrain.js';
import { CreditSync, createMapCredits } from './attribution.js';
import { CesiumTheme } from './theme.js';
import { createSpriteSheet, domCanvasFactory, type SpriteSheet } from './sprites.js';
import { LayerSet } from './layers/layerSet.js';
import { pickAnchor, resolvePickedFeatureId, toPickResult } from './picking.js';
import { altitudeForBounds, cameraToViewState, resolveFlyTarget, viewStateToCamera } from './view.js';

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
  now?: () => number;
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
  private selectedId: string | null = null;
  private lastView: ViewState = DEFAULT_VIEW;
  private terrainCache = new Map<string, Promise<TerrainProviderLike>>();
  private terrainGen = 0;
  private terrainAbort = new AbortController();
  private frames = 0;
  private frameWindowStart = 0;
  private suspended = false;
  private disposed = false;
  private ownedCreditContainer: HTMLElement | undefined;
  private readonly now: () => number;
  private stackState: MapStackState | undefined;

  constructor(private readonly options: CesiumWorldRendererOptions) {
    this.cesium = options.cesium;
    this.theme = new CesiumTheme(options.cesium, options.theme);
    this.scheduler = options.scheduler ?? createFrameScheduler();
    this.now = options.now ?? (() => this.scheduler.now());
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
    });
    this.viewer = viewer;
    this.sprites = createSpriteSheet(this.options.createCanvas ?? domCanvasFactory());
    this.layers = new LayerSet(this.cesium, this.theme, this.sprites, viewer);
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
    this.removePinch = installTrackpadPinchZoom(this.cesium, viewer);
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
    );
    this.frameWindowStart = this.now();
    this.cameraUnsubs.push(
      viewer.scene.postRender.addEventListener(() => {
        this.frames++;
        const t = this.now();
        if (t - this.frameWindowStart >= 1000) {
          this.emit('frame', {
            fps: Math.round((this.frames * 1000) / (t - this.frameWindowStart)),
            featureCount: this.layers?.featureCount ?? 0,
          });
          this.frames = 0;
          this.frameWindowStart = t;
        }
      }),
    );
  }

  unmount(): void {
    this.dispose();
  }

  suspend(): void {
    if (!this.viewer || this.suspended) return;
    this.suspended = true;
    this.viewer.useDefaultRenderLoop = false;
  }

  resume(): void {
    if (!this.viewer || !this.suspended) return;
    this.suspended = false;
    this.viewer.useDefaultRenderLoop = true;
    this.viewer.scene.requestRender();
  }

  // ── features ───────────────────────────────────────────────────────────────
  update(update: FeatureUpdate): void {
    if (!this.layers) return;
    const selected = this.selectedId;
    this.layers.apply(update, selected ? (f) => (f.id === selected ? withSelected(f) : f) : undefined);
    this.declutterPass?.schedule();
    this.viewer?.scene.requestRender();
  }

  clear(layer?: string): void {
    this.layers?.clear(layer);
    this.viewer?.scene.requestRender();
  }

  select(featureId: string | null): void {
    if (featureId === this.selectedId) return;
    const previous = this.selectedId;
    this.selectedId = featureId;
    if (!this.layers) return;
    if (previous) this.layers.restyle(previous, (f) => f);
    if (featureId) this.layers.restyle(featureId, withSelected);
    this.viewer?.scene.requestRender();
  }

  feature(id: string): RenderFeature | undefined {
    return this.layers?.store.get(id);
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
    return cameraToViewState({
      longitude: c.longitude,
      latitude: c.latitude,
      height: c.height,
      heading: v.camera.heading,
      pitch: v.camera.pitch,
      ...(rect ? { rectangle: rect } : {}),
    });
  }

  getView(): ViewState {
    return this.viewer ? this.readView() : this.lastView;
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
    const target = viewStateToCamera(view, this.getView());
    this.lastView = { ...this.lastView, ...view };
    if (!this.viewer) return;
    const options = this.cameraOptions(target);
    if (opts.animate) this.viewer.camera.flyTo({ ...options, duration: (opts.durationMs ?? 800) / 1000 });
    else this.viewer.camera.setView(options);
  }

  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts: { durationMs?: number } = {},
  ): Promise<void> {
    const dest = resolveFlyTarget(target, this.getView());
    if (!this.viewer) {
      this.lastView =
        dest.kind === 'point'
          ? { ...this.lastView, center: { latitude: dest.latitude, longitude: dest.longitude }, altitudeM: dest.height }
          : { ...this.lastView, center: target.position, altitudeM: altitudeForBounds(dest.bounds) };
      return Promise.resolve();
    }
    const camera = this.viewer.camera;
    const duration = (opts.durationMs ?? 1500) / 1000;
    return new Promise((resolve) => {
      const orientation = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
      if (dest.kind === 'bounds')
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
    if (!featureId) return null;
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
    if (!p) return;
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
    this.layers.declutter(project, {
      width: v.canvas.clientWidth || v.canvas.width,
      height: v.canvas.clientHeight || v.canvas.height,
    });
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
    for (const u of this.cameraUnsubs.splice(0)) u();
    this.removePinch?.();
    this.handler?.destroy();
    this.credits?.dispose();
    this.stacks?.destroy();
    this.layers?.dispose();
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    this.ownedCreditContainer?.remove();
    this.viewer = undefined;
    this.layers = undefined;
  }
}

function withSelected(f: RenderFeature): RenderFeature {
  return f.style.selected ? f : { ...f, style: { ...f.style, selected: true } };
}
