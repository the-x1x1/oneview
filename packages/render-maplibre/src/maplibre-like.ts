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
  addImage(id: string, image: StyleImageLike, options?: { pixelRatio?: number; sdf?: boolean }): unknown;
  hasImage(id: string): boolean;
  removeImage(id: string): void;
  queryRenderedFeatures(point: PointLike, options?: { layers?: string[] }): QueriedFeatureLike[];
  setStyle(style: MapStyle | string): unknown;
  isStyleLoaded(): boolean;
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
  addControl(control: ControlLike, position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'): unknown;
  removeControl(control: ControlLike): unknown;
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
