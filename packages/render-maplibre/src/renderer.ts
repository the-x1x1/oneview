import type {
  AttributionEntry,
  BasemapDescriptor,
  FeatureUpdate,
  PickResult,
  RenderFeature,
  RendererCapabilities,
  RendererEvents,
  RenderingRule,
  Theme,
  ViewState,
  WorldRenderer,
} from '@worldview/render-core';
import { createFrameScheduler, DEFAULT_RULES, FrameCoalescer, type FrameScheduler } from '@worldview/render-core';
import type { GeoBounds, GeoPosition } from '@worldview/world-model';
import type { MapLibreLike, MapLike, PmtilesLike } from './maplibre-like.js';
import { SourceModel, clusterOptionsFromRules, type ClusterOptions } from './sources.js';
import { interactiveLayerIds, overlayLayers, overlaySource, overlaySourceId } from './layers.js';
import { toPickResult } from './picking.js';
import { mapToViewState, resolveMapFlyTarget, viewStateToMap } from './view.js';
import { AttributionSync } from './attribution.js';
import { ensurePmtilesProtocol } from './pmtiles.js';
import { IconRegistry, domImageCanvasFactory, type ImageCanvasFactory } from './images.js';
import {
  buildEmptyStyle,
  DEFAULT_FONT_STACK,
  styleForBasemap,
  type StyleBuildOptions,
} from './styles/worldview-dark.js';
import type { MapStyle } from './styles/spec.js';
import { parseIconImageId } from './images.js';

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
}

const DEFAULT_VIEW: ViewState = {
  center: { latitude: 20, longitude: 0 },
  altitudeM: 20_000_000,
  zoom: 1.5,
  headingDegrees: 0,
  pitchDegrees: -90,
};

/**
 * MapLibreWorldRenderer — the 2D adapter. GeoJSON source per layer, MapLibre
 * clustering for clusterable layers, symbol/circle/line/fill layers driven by
 * feature properties, PMTiles basemaps for worldpacks. Thin over the pure
 * modules (sources, layers, view, picking, styles).
 */
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
  private readonly icons: IconRegistry;
  private readonly fontStack: string[];
  private map: MapLike | undefined;
  private attribution: AttributionSync | undefined;
  private flushPass: FrameCoalescer | undefined;
  private viewPass: FrameCoalescer | undefined;
  private hoverPass: FrameCoalescer | undefined;
  private pendingHover: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } } | undefined;
  private lastHoverId: string | null = null;
  private selectedId: string | null = null;
  private lastView: ViewState = DEFAULT_VIEW;
  private currentStyle: MapStyle | string;
  private currentBasemap: BasemapDescriptor | undefined;
  private styleReady = false;
  private suspended = false;
  private disposed = false;
  private frames = 0;
  private frameWindowStart = 0;
  private readonly now: () => number;

  constructor(private readonly options: MapLibreWorldRendererOptions) {
    this.maplibre = options.maplibre;
    this.scheduler = options.scheduler ?? createFrameScheduler();
    this.now = options.now ?? (() => this.scheduler.now());
    this.sources = new SourceModel(options.theme);
    this.clusterOptions = clusterOptionsFromRules(options.rules ?? DEFAULT_RULES);
    this.icons = new IconRegistry(options.createCanvas ?? domImageCanvasFactory());
    this.fontStack = options.style?.fontStack ?? DEFAULT_FONT_STACK;
    this.currentStyle = buildEmptyStyle(options.style?.variant ?? 'dark');
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
    this.attribution = new AttributionSync(this.maplibre, map);
    this.flushPass = new FrameCoalescer(this.scheduler, () => this.flush());
    this.viewPass = new FrameCoalescer(this.scheduler, () => {
      this.lastView = this.readView();
      this.emit('viewChanged', this.lastView);
    });
    this.hoverPass = new FrameCoalescer(this.scheduler, () => this.runHover());
    map.on('move', () => this.viewPass?.schedule());
    map.on('moveend', () => this.viewPass?.schedule());
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
    this.frameWindowStart = this.now();
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
  }

  resume(): void {
    if (!this.map || !this.suspended) return;
    this.suspended = false;
    this.flushPass?.schedule();
    this.map.triggerRepaint();
  }

  private countFrame(): void {
    this.frames++;
    const t = this.now();
    if (t - this.frameWindowStart >= 1000) {
      this.emit('frame', {
        fps: Math.round((this.frames * 1000) / (t - this.frameWindowStart)),
        featureCount: this.features.size,
      });
      this.frames = 0;
      this.frameWindowStart = t;
    }
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
    if (!this.suspended) this.flushPass?.schedule();
  }

  clear(layer?: string): void {
    if (layer) {
      for (const [id, f] of this.features) if (f.layer === layer) this.features.delete(id);
    } else this.features.clear();
    this.sources.clear(layer);
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
  }

  feature(id: string): RenderFeature | undefined {
    return this.features.get(id);
  }
  get featureCount(): number {
    return this.features.size;
  }

  /** Push dirty layers to their GeoJSON sources (one setData per layer per frame). */
  private flush(): number {
    const map = this.map;
    if (!map || !this.styleReady || this.suspended) return 0;
    let n = 0;
    for (const layer of this.sources.takeDirty()) {
      this.ensureOverlay(map, layer);
      const collection = this.sources.collection(layer);
      for (const f of collection.features) {
        const icon = f.properties.icon ? parseIconImageId(f.properties.icon) : undefined;
        if (icon) this.icons.ensure(map, icon.icon, icon.colorCss);
      }
      map.getSource(overlaySourceId(layer))?.setData(collection);
      n++;
    }
    return n;
  }

  private ensureOverlay(map: MapLike, layer: string): void {
    const sourceId = overlaySourceId(layer);
    if (map.getSource(sourceId)) return;
    const cluster = this.clusterOptions.get(layer);
    const opts = {
      fontStack: this.fontStack,
      ...(cluster ? { cluster } : {}),
      ...(this.options.theme ? { theme: this.options.theme } : {}),
    };
    map.addSource(sourceId, overlaySource(layer, opts));
    for (const spec of overlayLayers(layer, opts)) map.addLayer(spec);
  }

  /** After a style change every source/layer/image is gone: re-add them with current data. */
  private restoreOverlays(): void {
    const map = this.map;
    if (!map) return;
    this.icons.reapply(map);
    for (const layer of this.sources.layerIds()) {
      this.ensureOverlay(map, layer);
      map.getSource(overlaySourceId(layer))?.setData(this.sources.collection(layer));
    }
    this.sources.takeDirty();
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
    });
  }

  getView(): ViewState {
    return this.map ? this.readView() : this.lastView;
  }

  setView(view: Partial<ViewState>, opts: { animate?: boolean; durationMs?: number } = {}): void {
    const target = viewStateToMap(view, this.getView());
    this.lastView = { ...this.lastView, ...view };
    if (!this.map) return;
    if (opts.animate) this.map.easeTo({ ...target, duration: opts.durationMs ?? 600 });
    else this.map.jumpTo(target);
  }

  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts: { durationMs?: number } = {},
  ): Promise<void> {
    const dest = resolveMapFlyTarget(target, this.getView());
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
      .flatMap((l) => interactiveLayerIds(l))
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
    if (!p) return;
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
    await new Promise<void>((resolve) => {
      map.once('style.load', () => resolve());
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
    this.attribution?.dispose();
    this.map?.remove();
    this.map = undefined;
    this.features.clear();
  }
}

function withSelected(f: RenderFeature): RenderFeature {
  return f.style.selected ? f : { ...f, style: { ...f.style, selected: true } };
}
