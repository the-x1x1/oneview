import type { GeoJsonFeature, GeoJsonFeatureCollection } from './geojson.js';
import type { LayerSpec, MapStyle, SourceSpec } from './styles/spec.js';

/**
 * The slice of MapLibre GL JS this adapter uses, as structural interfaces so the
 * adapter can run in Node against `testing/fake-maplibre.ts`. The real module is
 * adapted (and type-checked) in `maplibre-module.ts`. Method-style members keep
 * MapLibre's richer signatures assignable (bivariant parameter checks).
 */
export interface LngLatLike {
  lng: number;
  lat: number;
}
export interface LngLatBoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}
export interface PointLike {
  x: number;
  y: number;
}

export interface MapMouseEventLike {
  point: PointLike;
  lngLat: LngLatLike;
}
export interface MapErrorEventLike {
  error: Error;
  /** The source whose tile or data failed, when the error is one. */
  sourceId?: string;
}
export interface MapEventMap {
  load: unknown;
  'style.load': unknown;
  styledata: unknown;
  idle: unknown;
  render: unknown;
  movestart: unknown;
  move: unknown;
  moveend: unknown;
  error: MapErrorEventLike;
  click: MapMouseEventLike;
  mousemove: MapMouseEventLike;
  mouseout: unknown;
  webglcontextlost: unknown;
  /** A symbol layer asked for an image the style does not have (yet): `id` names it. */
  styleimagemissing: { id: string };
  /** The operator's own input, which ends an orbit (renderer.ts). */
  mousedown: unknown;
  touchstart: unknown;
  wheel: unknown;
  /** A pan begun by the operator, which ends a follow. */
  dragstart: unknown;
  /** A source's data changed; with `tile`, one of its tiles arrived. */
  sourcedata: { sourceId?: string; tile?: unknown };
}

export interface GeoJSONSourceDiffLike {
  remove?: Array<string | number>;
  add?: GeoJsonFeature[];
}

export interface GeoJSONSourceLike {
  setData(data: GeoJsonFeatureCollection): unknown;
  /** maplibre-gl 3+: apply a diff instead of replacing the source. Requires feature ids. */
  updateData?(diff: GeoJSONSourceDiffLike): unknown;
}

export interface QueriedFeatureLike {
  properties: { [name: string]: unknown };
  layer: { id: string };
  source: string;
  geometry: { type: string; coordinates: unknown };
}

export interface StyleImageLike {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Opaque control handle: the renderer only adds/removes controls; MapLibre calls the hooks. */
export interface ControlLike {
  onAdd(map: never): HTMLElement;
  onRemove(map: never): void;
}

export interface MapLike {
  on<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): unknown;
  off<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): unknown;
  once<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): unknown;
  addSource(id: string, source: SourceSpec): unknown;
  getSource(id: string): GeoJSONSourceLike | undefined;
  removeSource(id: string): unknown;
  addLayer(layer: LayerSpec, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  getLayer(id: string): { id: string } | undefined;
  /** Change one paint property of a layer in place (MapLibre `Map.setPaintProperty`). */
  setPaintProperty(layerId: string, name: string, value: unknown): unknown;
  addImage(id: string, image: StyleImageLike, options?: { pixelRatio?: number; sdf?: boolean }): unknown;
  hasImage(id: string): boolean;
  removeImage(id: string): void;
  queryRenderedFeatures(point: PointLike, options?: { layers?: string[] }): QueriedFeatureLike[];
  setStyle(style: MapStyle | string): unknown;
  isStyleLoaded(): boolean;
  /** Every tile in view loaded, for every source (MapLibre `Map.areTilesLoaded`). */
  areTilesLoaded?(): boolean;
  getCenter(): LngLatLike;
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getBounds(): LngLatBoundsLike;
  jumpTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): unknown;
  easeTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    /** Progress over time, 0–1 to 0–1 (default ease-in-out). */
    easing?: (t: number) => number;
    /** Run even when the system asks for reduced motion (MapLibre otherwise jumps). */
    essential?: boolean;
  }): unknown;
  flyTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    essential?: boolean;
  }): unknown;
  fitBounds(
    bounds: [number, number, number, number],
    options?: { padding?: number; duration?: number; maxZoom?: number },
  ): unknown;
  stop(): unknown;
  resize(): unknown;
  redraw(): unknown;
  triggerRepaint(): void;
  getCanvas(): HTMLCanvasElement;
  /** A longitude and latitude to CSS pixels on the canvas (MapLibre `Map.project`). */
  project(lngLat: [number, number]): { x: number; y: number };
  addControl(control: ControlLike, position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'): unknown;
  removeControl(control: ControlLike): unknown;
  /** Change the canvas pixel density without rebuilding the map (MapLibre ≥ 2). */
  setPixelRatio?(pixelRatio: number): void;
  remove(): void;
}

export interface MapOptionsLike {
  container: HTMLElement;
  style: MapStyle | string;
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  maxPitch?: number;
  attributionControl?: false;
  /** MapLibre 4 option name; MapLibre 5 reads the same flag from `canvasContextAttributes`. */
  preserveDrawingBuffer?: boolean;
  canvasContextAttributes?: { preserveDrawingBuffer?: boolean; antialias?: boolean };
  antialias?: boolean;
  fadeDuration?: number;
  localIdeographFontFamily?: string | false;
  /** Canvas pixel density; defaults to the display's. */
  pixelRatio?: number;
}

export interface AttributionControlOptionsLike {
  compact?: boolean;
  customAttribution?: string | string[];
}

/**
 * What MapLibre hands a protocol loader. `type` is MapLibre's own narrow union, not a
 * free string: declaring it wider made pmtiles' real `Protocol#tile` unassignable here,
 * which is how the mismatch surfaced once the real packages were installed.
 */
export interface ProtocolLoadRequest {
  url: string;
  type?: 'string' | 'image' | 'json' | 'arrayBuffer';
}
export type ProtocolLoader = (
  request: ProtocolLoadRequest,
  abortController: AbortController,
) => Promise<{ data: unknown; cacheControl?: string | null; expires?: string | null }>;

export interface MapLibreLike {
  Map: new (options: MapOptionsLike) => MapLike;
  AttributionControl: new (options?: AttributionControlOptionsLike) => ControlLike;
  addProtocol(name: string, loader: ProtocolLoader): void;
  removeProtocol(name: string): void;
}

/** The pmtiles package surface: `new Protocol()` and its MapLibre-compatible `tile` loader. */
export interface PmtilesLike {
  Protocol: new (options?: { metadata?: boolean; errorOnMissingTile?: boolean }) => { tile: ProtocolLoader };
}
