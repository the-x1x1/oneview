import type { GraphicsProfile } from './graphics.js';
import type { VisualStyleId } from './visual-styles.js';
import type { GeoBounds, GeoPosition, WorldGeometry, FreshnessClass, RasterOverlay } from '@worldview/world-model';
import type { ReferenceData, ReferenceOptions } from './reference.js';
import type { ImagerySplit } from './imagery-split.js';
import type { ModelKind } from './model-credits.js';

/**
 * World rendering contract (architecture-contract-v1).
 *
 * Renderers (Cesium, MapLibre, dense) consume presentation-ready RenderFeatures.
 * They never see providers, observations or raw payloads. The presentation
 * pipeline in this package turns WorldObjects/WorldEvents into RenderFeatures
 * using lens rendering rules and level-of-detail rules.
 */
export type RenderGeometry =
  | { kind: 'point'; position: GeoPosition }
  | { kind: 'line'; positions: GeoPosition[] }
  | { kind: 'polygon'; rings: GeoPosition[][] }
  | { kind: 'circle'; center: GeoPosition; radiusM: number }
  | { kind: 'cluster'; position: GeoPosition; count: number; bounds: GeoBounds }
  | { kind: 'density'; bounds: GeoBounds; count: number; intensity: number };

export interface RenderStyle {
  /** Semantic style class resolved by the renderer's theme (e.g. "aircraft", "earthquake.major"). */
  styleClass: string;
  /** Hex colour override (theme decides default). */
  color?: string;
  /** Point size in px / line width in px. */
  size?: number;
  opacity?: number;
  /** Icon id from the shared icon set (renderer maps it to a billboard/sprite). */
  icon?: string;
  /** Rotation for oriented icons (heading), degrees clockwise from north. */
  rotationDegrees?: number;
  label?: string;
  labelPriority?: number;
  /** Visual state hints. */
  selected?: boolean;
  hovered?: boolean;
  freshness?: FreshnessClass;
  /** Height reference for 3D renderers. */
  heightMode?: 'clamp' | 'absolute' | 'relative';
  /**
   * The object's real length, metres, where its source gives one (a ship's AIS dimensions): a
   * 3D model close in is drawn at that length instead of its class's.
   */
  lengthM?: number;
  /** Dashed/animated line variants. */
  lineStyle?: 'solid' | 'dashed' | 'trail';
}

export interface RenderFeature {
  id: string;
  objectId?: string;
  eventId?: string;
  geometry: RenderGeometry;
  style: RenderStyle;
  interactive: boolean;
  /** Higher renders on top / wins label collisions. */
  priority: number;
  /** Time the feature is valid for (replay/timeline). */
  validAt?: string;
  /** Layer grouping for renderer batching (one primitive collection per layer). */
  layer: string;
  /**
   * A point feature that is at `geometry.position` at `fromMs` and at `to` at `toMs`: a
   * satellite's two SGP4 propagations, or an aircraft's or ship's last report and where its
   * reported speed and track carry it (motion.ts). A renderer may move it between the two by
   * wall-clock time, and at most MOTION_MAX_T spans past `fromMs`; one that does not draws it
   * at `geometry.position`. Only set while the timeline is live.
   */
  motion?: RenderMotion;
}

export interface RenderMotion {
  to: GeoPosition;
  /** Epoch milliseconds. */
  fromMs: number;
  toMs: number;
}

/** Camera/viewport state shared between 2D and 3D renderers (directive §49). */
export interface ViewState {
  center: GeoPosition;
  /** Approximate camera altitude in metres above the ellipsoid (3D) — derived from zoom for 2D. */
  altitudeM: number;
  /** Web-Mercator zoom level (2D) — derived from altitude for 3D. */
  zoom: number;
  headingDegrees: number;
  pitchDegrees: number;
  bounds?: GeoBounds;
  /**
   * The ground at the middle of the viewport, where it is not `center`: the globe's `center`
   * is the point under the camera, and with the camera tilted the view looks at somewhere
   * else. Absent when it is the same point (the 2D map's centre) or when the middle of the
   * view is sky.
   */
  focus?: GeoPosition;
}

export type RenderMode = '2D' | '3D' | 'AUTO';

export interface RendererCapabilities {
  mode: '2D' | '3D';
  terrain: boolean;
  tilt: boolean;
  clustering: boolean;
  maxFeatures: number;
}

export interface FeatureUpdate {
  upsert: RenderFeature[];
  remove: string[];
  /** When true the renderer should replace all features in the given layers. */
  replaceLayers?: string[];
}

export interface PickResult {
  featureId: string;
  objectId?: string;
  eventId?: string;
  position: GeoPosition;
  screen: { x: number; y: number };
}

export interface AttributionEntry {
  id: string;
  text: string;
  url?: string;
  onScreen: boolean;
}

export interface RendererEvents {
  viewChanged: ViewState;
  pick: PickResult | null;
  hover: PickResult | null;
  ready: void;
  /**
   * `contextLost`: the WebGL context is gone — the GPU process crashed or the driver reset
   * (on 2026-09-29 the laptop's GPU process exited with code 34 on a switch to the globe, and
   * the map stayed a dead picture under "The renderer could not start"). Every context in
   * the window goes with it, so the host rebuilds its renderers rather than giving up.
   */
  error: { message: string; fatal: boolean; contextLost?: boolean };
  /**
   * Once a second of rendering. `maxFrameMs` is the longest gap between two frames in it:
   * a single 150 ms stall costs a second only ~8 frames, so fps alone reads 52 for a hitch
   * anyone can see. Optional because not every adapter can measure it.
   */
  /**
   * `pushMaxMs`, where a renderer hands data to its engine separately from applying an
   * update (MapLibre: GeoJSON `setData`/`updateData` once a frame), is the longest such hand
   * over in the sample — main-thread time the update's own timing does not see.
   */
  /**
   * `engineMaxMs` is the longest time the engine itself spent on one frame (Cesium: Scene
   * update and draw) — to tell a long frame spent in the map engine from one spent in the
   * page's own work or waiting on the GPU.
   */
  /**
   * `drawn` is how many frames the engine actually drew in the sample, where it can say (3D:
   * request-render mode skips a tick with nothing to draw, so `fps` is the loop's rate and
   * `drawn` the cost). A still globe draws a handful a second — one per data update — not 60.
   */
  /**
   * `models` (3D) is what the close-in model layer did at its last choice: whether it is on,
   * how many features had a model (`scanned`), how many of those were near the camera, how
   * many were given one, how many are drawn as one, and the kinds whose file failed.
   */
  frame: {
    fps: number;
    featureCount: number;
    maxFrameMs?: number;
    pushMaxMs?: number;
    engineMaxMs?: number;
    drawn?: number;
    models?: {
      enabled: boolean;
      scanned: number;
      near: number;
      assigned: number;
      drawn: number;
      instances: number;
      failed: readonly string[];
    };
  };
  /**
   * The camera's automatic modes (`setOrbit`, `follow`) as they now stand, raised when the
   * renderer ends one itself: orbit on the operator's own drag or wheel, follow when the
   * object it follows is gone. Whoever turned a mode on learns here that it is off.
   */
  cameraMode: CameraModeState;
  /**
   * The kinds of 3D model drawn now (3D, close in), each time the set changes. Their CC BY 4.0
   * credits belong on screen while they are drawn; the shell draws the credit line for both
   * modes, and the globe's own credit container is not shown, so the shell adds them
   * (render-core model-credits.ts `modelCreditText`).
   */
  modelCredits: readonly ModelKind[];
}

/** A point on the map's canvas in CSS pixels, from its top left corner ({@link WorldRenderer.project}). */
export interface ScreenPoint {
  x: number;
  y: number;
}

export interface CameraModeState {
  orbit: boolean;
  /** Feature id being kept in view, or null. */
  follow: string | null;
}

/** Options for {@link WorldRenderer.flyTo}. */
export interface FlyToOptions {
  durationMs?: number;
  /**
   * Arrive looking at the target at this pitch (−90 straight down, −35 an oblique view)
   * with the target in the middle of the view, instead of from straight above. Ignored for
   * a `bounds` target, which is framed from above.
   */
  pitchDegrees?: number;
  /**
   * Arrive facing this way (degrees clockwise from north) instead of north (from straight
   * above) or the heading the camera has (oblique). Ignored for a `bounds` target.
   */
  headingDegrees?: number;
}

/**
 * WorldRenderer — the single interface both adapters implement. Imperative; owned by
 * the render layer, driven by the presentation pipeline and the React shell.
 */
export interface WorldRenderer {
  readonly capabilities: RendererCapabilities;
  mount(container: HTMLElement): Promise<void>;
  unmount(): void;
  /** Suspend rendering while hidden (directive §49): release GPU work but keep state. */
  suspend(): void;
  resume(): void;
  update(update: FeatureUpdate): void;
  clear(layer?: string): void;
  setView(view: Partial<ViewState>, opts?: { animate?: boolean; durationMs?: number }): void;
  getView(): ViewState;
  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts?: FlyToOptions,
  ): Promise<void>;
  select(featureId: string | null): void;
  setAttribution(entries: AttributionEntry[]): void;
  setBasemap(basemap: BasemapDescriptor): Promise<void>;
  /** Terrain is a 3D-only capability: the 2D adapter simply does not implement it (`capabilities.terrain` says so). */
  setTerrain?(terrain: TerrainDescriptor): Promise<void>;
  /**
   * Borders and place names under the world's objects (reference.ts). Optional: a renderer
   * without it simply draws none. `null` data, or both options off, removes the layer.
   */
  setReference?(data: ReferenceData | null, options: ReferenceOptions): void;
  /**
   * Raster overlays (ADR-008 amendment 2026-09-23): the full list every time; the renderer
   * adds, removes and reorders its tile layers to match, between the basemap and the
   * reference borders. Optional: an adapter that cannot draw one says so through
   * `error` (not fatal) and draws the rest.
   */
  setOverlays?(overlays: readonly RasterOverlay[]): void;
  /**
   * Before/after imagery comparison (imagery-split.ts): one overlay source shown only left of
   * a vertical divider, another only right of it; `null` ends it and every overlay is drawn
   * whole again. Kept across `setOverlays`, so a new frame of a source stays on its side.
   * Static — it draws a frame when it changes, never more. Optional (additive, 2026-09-28): a
   * renderer without it draws every overlay whole.
   */
  setImagerySplit?(split: ImagerySplit | null): void;
  /**
   * How much GPU work a frame may cost (graphics.ts): multisampling, canvas pixel density,
   * tile sharpness. Optional; a renderer without it draws at its defaults.
   */
  setGraphics?(profile: GraphicsProfile): void;
  /**
   * A look for the whole map (visual-styles.ts): night vision, thermal, a CRT, noir, or
   * `standard` for none. Static — a style never makes a still view draw frames. Optional; a
   * renderer without it draws `standard`.
   */
  setVisualStyle?(id: VisualStyleId): void;
  /**
   * Shade the night side from the Sun's position now (sun.ts), kept current to the minute;
   * `false` puts the map back exactly as it was. Optional.
   */
  setDayNight?(on: boolean): void;
  /**
   * Turn slowly round the middle of the view until turned off, or until the operator drags,
   * scrolls or pinches (then `cameraMode` says so). Optional.
   */
  setOrbit?(on: boolean): void;
  /**
   * Keep a feature — usually something moving — in the middle of the view, the camera
   * moving with it while the operator can still turn round it and zoom; `null` lets go and
   * leaves the camera where it is. Ends by itself when the feature goes (`cameraMode`).
   * `durationMs` is the flight there (0 for none, as reduced motion asks). Optional.
   */
  follow?(featureId: string | null, opts?: { durationMs?: number }): void;
  /**
   * Where each position is drawn on the map's canvas right now, in CSS pixels from its top
   * left corner, or `null` for one that is not on screen (behind the globe, or the renderer
   * not mounted). For the shell's own overlays pinned to places on the map — camera preview
   * tiles — which have to follow the camera on every frame without asking React to render.
   * Cheap, synchronous and side-effect free: it never requests a frame. Optional
   * (additive, 2026-09-28); a renderer without it simply has no pinned overlays.
   */
  project?(positions: readonly GeoPosition[]): Array<ScreenPoint | null>;
  on<K extends keyof RendererEvents>(event: K, listener: (payload: RendererEvents[K]) => void): () => void;
  /** Screenshot as PNG bytes (export). */
  screenshot?(): Promise<Uint8Array>;
  dispose(): void;
}

/** Basemap/terrain descriptors — providers of map tiles are configured through the map-provider registry, never hardcoded in renderers. */
export type BasemapDescriptor =
  | { kind: 'raster-xyz'; id: string; url: string; attribution: string; maxZoom: number; tileSize?: number }
  | { kind: 'vector-style'; id: string; styleUrl: string; attribution: string }
  | { kind: 'pmtiles'; id: string; url: string; styleId: 'worldview-dark' | 'worldview-light'; attribution: string }
  | { kind: 'cesium-natural-earth'; id: string; attribution: string }
  | { kind: 'cesium-ion'; id: string; assetId: number; attribution: string }
  | { kind: 'esri-world-imagery'; id: string; attribution: string }
  | { kind: 'none'; id: string };

export type TerrainDescriptor =
  | { kind: 'ellipsoid' }
  | { kind: 'cesium-ion-world-terrain' }
  | { kind: 'quantized-mesh'; url: string; attribution: string }
  | { kind: 'local'; path: string; attribution: string };

export function positionToGeometry(p: GeoPosition): RenderGeometry {
  return { kind: 'point', position: p };
}

export function worldGeometryToRender(g: WorldGeometry): RenderGeometry | undefined {
  const toPos = (c: [number, number] | [number, number, number]): GeoPosition =>
    c.length === 3 ? { latitude: c[1], longitude: c[0], altitudeM: c[2] } : { latitude: c[1], longitude: c[0] };
  switch (g.type) {
    case 'Point':
      return { kind: 'point', position: toPos(g.coordinates) };
    case 'LineString':
      return { kind: 'line', positions: g.coordinates.map(toPos) };
    case 'Polygon':
      return { kind: 'polygon', rings: g.coordinates.map((r) => r.map(toPos)) };
    case 'MultiPoint':
      return g.coordinates.length ? { kind: 'point', position: toPos(g.coordinates[0]!) } : undefined;
    case 'MultiLineString':
      return { kind: 'line', positions: g.coordinates.flat().map(toPos) };
    case 'MultiPolygon':
      return g.coordinates.length ? { kind: 'polygon', rings: g.coordinates[0]!.map((r) => r.map(toPos)) } : undefined;
  }
}

/**
 * A geometry as the shapes a renderer draws: one per part of a multi-part geometry. A
 * `worldGeometryToRender` polygon keeps only a MultiPolygon's first part and a line runs a
 * MultiLineString's parts together — which lost the west half of a Pacific storm's cone and
 * wind field, both of which NHC splits on the antimeridian. Drawn shapes use this instead.
 */
export function worldGeometryParts(g: WorldGeometry): RenderGeometry[] {
  const toPos = (c: [number, number] | [number, number, number]): GeoPosition =>
    c.length === 3 ? { latitude: c[1], longitude: c[0], altitudeM: c[2] } : { latitude: c[1], longitude: c[0] };
  switch (g.type) {
    case 'MultiPolygon':
      return g.coordinates
        .filter((poly) => poly.length > 0)
        .map((poly) => ({ kind: 'polygon' as const, rings: poly.map((r) => r.map(toPos)) }));
    case 'MultiLineString':
      return g.coordinates
        .filter((line) => line.length >= 2)
        .map((line) => ({ kind: 'line' as const, positions: line.map(toPos) }));
    default: {
      const one = worldGeometryToRender(g);
      return one ? [one] : [];
    }
  }
}

/**
 * Zoom ↔ altitude conversion shared by both renderers: web-mercator, 256 px tiles, a 60°
 * field of view across the viewport's larger dimension (Cesium's default frustum).
 * `viewportPx` is that dimension in CSS pixels. It used to be fixed at 1024, so a 2D map in
 * a 584-pixel-wide window came up 0.8 zoom levels closer than the globe it replaced — the
 * whole globe in 3D, Hawaii to California in 2D. Both renderers now pass their own size.
 */
export function zoomToAltitudeM(zoom: number, latitude = 0, viewportPx = 1024): number {
  const metersPerPixel = (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
  // Half the viewport at 30° either side of straight ahead: altitude = half-width / tan(30°).
  return Math.max(10, (metersPerPixel * (viewportPx / 2)) / Math.tan(Math.PI / 6));
}

export function altitudeToZoom(altitudeM: number, latitude = 0, viewportPx = 1024): number {
  const metersPerPixel = (altitudeM * Math.tan(Math.PI / 6)) / (viewportPx / 2);
  const z = Math.log2((156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / metersPerPixel);
  return Math.max(0, Math.min(22, z));
}
