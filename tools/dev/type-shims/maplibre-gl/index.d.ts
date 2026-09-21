/**
 * Declaration shim for `maplibre-gl` — used ONLY when the real package is not
 * installed (tools/dev/typecheck.mjs maps it in and records that in evidence). It
 * declares the surface `packages/render-maplibre` uses, matching the documented
 * MapLibre GL JS API (≥ 4): Map options/events, addSource/addLayer, GeoJSON sources
 * with clustering, symbol/circle/line/fill/heatmap layers, addImage,
 * queryRenderedFeatures, flyTo/jumpTo/fitBounds, getBounds, AttributionControl,
 * addProtocol/removeProtocol (for PMTiles).
 *
 * Style-spec types are a realistic subset (`layout`/`paint` are typed per layer
 * kind with expression values as `ExpressionSpecification`).
 */

// ── geometry ──────────────────────────────────────────────────────────────────
export class LngLat {
  constructor(lng: number, lat: number);
  lng: number;
  lat: number;
  wrap(): LngLat;
  toArray(): [number, number];
  static convert(input: LngLatLike): LngLat;
}
export type LngLatLike = LngLat | { lng: number; lat: number } | { lon: number; lat: number } | [number, number];

export class LngLatBounds {
  constructor(sw?: LngLatLike, ne?: LngLatLike);
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
  getSouthWest(): LngLat;
  getNorthEast(): LngLat;
  getCenter(): LngLat;
  toArray(): [[number, number], [number, number]];
  static convert(input: LngLatBoundsLike): LngLatBounds;
}
export type LngLatBoundsLike = LngLatBounds | [LngLatLike, LngLatLike] | [number, number, number, number];

export class Point {
  constructor(x: number, y: number);
  x: number;
  y: number;
}
export type PointLike = Point | [number, number];

// ── GeoJSON (subset of @types/geojson shapes) ─────────────────────────────────
export type GeoJSONPosition = number[];
export interface GeoJSONPoint { type: 'Point'; coordinates: GeoJSONPosition }
export interface GeoJSONLineString { type: 'LineString'; coordinates: GeoJSONPosition[] }
export interface GeoJSONPolygon { type: 'Polygon'; coordinates: GeoJSONPosition[][] }
export interface GeoJSONMultiPoint { type: 'MultiPoint'; coordinates: GeoJSONPosition[] }
export interface GeoJSONMultiLineString { type: 'MultiLineString'; coordinates: GeoJSONPosition[][] }
export interface GeoJSONMultiPolygon { type: 'MultiPolygon'; coordinates: GeoJSONPosition[][][] }
export type GeoJSONGeometry = GeoJSONPoint | GeoJSONLineString | GeoJSONPolygon | GeoJSONMultiPoint | GeoJSONMultiLineString | GeoJSONMultiPolygon;
export interface GeoJSONFeature { type: 'Feature'; id?: string | number; geometry: GeoJSONGeometry; properties: { [name: string]: unknown } | null }
export interface GeoJSONFeatureCollection { type: 'FeatureCollection'; features: GeoJSONFeature[] }
export type GeoJSON = GeoJSONFeature | GeoJSONFeatureCollection | GeoJSONGeometry;

// ── style specification (subset) ──────────────────────────────────────────────
export type ExpressionSpecification = [string, ...unknown[]];
export type FilterSpecification = ExpressionSpecification | boolean;
export type PropertyValueSpecification<T> = T | ExpressionSpecification;
export type DataDrivenPropertyValueSpecification<T> = T | ExpressionSpecification;
export type ColorSpecification = string;

export interface VectorSourceSpecification {
  type: 'vector';
  url?: string;
  tiles?: string[];
  bounds?: [number, number, number, number];
  scheme?: 'xyz' | 'tms';
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
  promoteId?: string | Record<string, string>;
  volatile?: boolean;
}
export interface RasterSourceSpecification {
  type: 'raster';
  url?: string;
  tiles?: string[];
  bounds?: [number, number, number, number];
  minzoom?: number;
  maxzoom?: number;
  tileSize?: number;
  scheme?: 'xyz' | 'tms';
  attribution?: string;
  volatile?: boolean;
}
export interface GeoJSONSourceSpecification {
  type: 'geojson';
  data: GeoJSON | string;
  maxzoom?: number;
  attribution?: string;
  buffer?: number;
  filter?: FilterSpecification;
  tolerance?: number;
  cluster?: boolean;
  clusterRadius?: number;
  clusterMaxZoom?: number;
  clusterMinPoints?: number;
  clusterProperties?: Record<string, [ExpressionSpecification | string, ExpressionSpecification]>;
  lineMetrics?: boolean;
  generateId?: boolean;
  promoteId?: string | Record<string, string>;
}
export type SourceSpecification = VectorSourceSpecification | RasterSourceSpecification | GeoJSONSourceSpecification;

interface LayerBase {
  id: string;
  metadata?: unknown;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: FilterSpecification;
}
export interface BackgroundLayerSpecification extends LayerBase {
  type: 'background';
  layout?: { visibility?: 'visible' | 'none' };
  paint?: { 'background-color'?: PropertyValueSpecification<ColorSpecification>; 'background-opacity'?: PropertyValueSpecification<number> };
}
export interface FillLayerSpecification extends LayerBase {
  type: 'fill';
  source: string;
  layout?: { visibility?: 'visible' | 'none'; 'fill-sort-key'?: DataDrivenPropertyValueSpecification<number> };
  paint?: {
    'fill-antialias'?: PropertyValueSpecification<boolean>;
    'fill-opacity'?: DataDrivenPropertyValueSpecification<number>;
    'fill-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
    'fill-outline-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
  };
}
export interface LineLayerSpecification extends LayerBase {
  type: 'line';
  source: string;
  layout?: { visibility?: 'visible' | 'none'; 'line-cap'?: PropertyValueSpecification<'butt' | 'round' | 'square'>; 'line-join'?: DataDrivenPropertyValueSpecification<'bevel' | 'round' | 'miter'>; 'line-sort-key'?: DataDrivenPropertyValueSpecification<number> };
  paint?: {
    'line-opacity'?: DataDrivenPropertyValueSpecification<number>;
    'line-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
    'line-width'?: DataDrivenPropertyValueSpecification<number>;
    'line-dasharray'?: PropertyValueSpecification<number[]>;
    'line-blur'?: DataDrivenPropertyValueSpecification<number>;
  };
}
export interface SymbolLayerSpecification extends LayerBase {
  type: 'symbol';
  source: string;
  layout?: {
    visibility?: 'visible' | 'none';
    'symbol-placement'?: PropertyValueSpecification<'point' | 'line' | 'line-center'>;
    'symbol-sort-key'?: DataDrivenPropertyValueSpecification<number>;
    'symbol-z-order'?: PropertyValueSpecification<'auto' | 'viewport-y' | 'source'>;
    'icon-image'?: DataDrivenPropertyValueSpecification<string>;
    'icon-size'?: DataDrivenPropertyValueSpecification<number>;
    'icon-rotate'?: DataDrivenPropertyValueSpecification<number>;
    'icon-rotation-alignment'?: PropertyValueSpecification<'map' | 'viewport' | 'auto'>;
    'icon-allow-overlap'?: PropertyValueSpecification<boolean>;
    'icon-ignore-placement'?: PropertyValueSpecification<boolean>;
    'icon-anchor'?: DataDrivenPropertyValueSpecification<'center' | 'left' | 'right' | 'top' | 'bottom'>;
    'icon-optional'?: PropertyValueSpecification<boolean>;
    'text-field'?: DataDrivenPropertyValueSpecification<string>;
    'text-font'?: DataDrivenPropertyValueSpecification<string[]>;
    'text-size'?: DataDrivenPropertyValueSpecification<number>;
    'text-anchor'?: DataDrivenPropertyValueSpecification<'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'>;
    'text-offset'?: DataDrivenPropertyValueSpecification<[number, number]>;
    'text-allow-overlap'?: PropertyValueSpecification<boolean>;
    'text-ignore-placement'?: PropertyValueSpecification<boolean>;
    'text-optional'?: PropertyValueSpecification<boolean>;
    'text-max-width'?: DataDrivenPropertyValueSpecification<number>;
    'text-transform'?: DataDrivenPropertyValueSpecification<'none' | 'uppercase' | 'lowercase'>;
    'text-letter-spacing'?: DataDrivenPropertyValueSpecification<number>;
    'text-padding'?: PropertyValueSpecification<number>;
  };
  paint?: {
    'icon-opacity'?: DataDrivenPropertyValueSpecification<number>;
    'icon-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
    'text-opacity'?: DataDrivenPropertyValueSpecification<number>;
    'text-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
    'text-halo-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
    'text-halo-width'?: DataDrivenPropertyValueSpecification<number>;
    'text-halo-blur'?: DataDrivenPropertyValueSpecification<number>;
  };
}
export interface CircleLayerSpecification extends LayerBase {
  type: 'circle';
  source: string;
  layout?: { visibility?: 'visible' | 'none'; 'circle-sort-key'?: DataDrivenPropertyValueSpecification<number> };
  paint?: {
    'circle-radius'?: DataDrivenPropertyValueSpecification<number>;
    'circle-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
    'circle-blur'?: DataDrivenPropertyValueSpecification<number>;
    'circle-opacity'?: DataDrivenPropertyValueSpecification<number>;
    'circle-stroke-width'?: DataDrivenPropertyValueSpecification<number>;
    'circle-stroke-color'?: DataDrivenPropertyValueSpecification<ColorSpecification>;
    'circle-stroke-opacity'?: DataDrivenPropertyValueSpecification<number>;
    'circle-pitch-alignment'?: PropertyValueSpecification<'map' | 'viewport'>;
  };
}
export interface HeatmapLayerSpecification extends LayerBase {
  type: 'heatmap';
  source: string;
  layout?: { visibility?: 'visible' | 'none' };
  paint?: {
    'heatmap-radius'?: DataDrivenPropertyValueSpecification<number>;
    'heatmap-weight'?: DataDrivenPropertyValueSpecification<number>;
    'heatmap-intensity'?: PropertyValueSpecification<number>;
    'heatmap-color'?: ExpressionSpecification;
    'heatmap-opacity'?: PropertyValueSpecification<number>;
  };
}
export interface RasterLayerSpecification extends LayerBase {
  type: 'raster';
  source: string;
  layout?: { visibility?: 'visible' | 'none' };
  paint?: { 'raster-opacity'?: PropertyValueSpecification<number>; 'raster-saturation'?: PropertyValueSpecification<number>; 'raster-brightness-min'?: PropertyValueSpecification<number>; 'raster-brightness-max'?: PropertyValueSpecification<number>; 'raster-contrast'?: PropertyValueSpecification<number>; 'raster-fade-duration'?: PropertyValueSpecification<number> };
}
export type LayerSpecification = BackgroundLayerSpecification | FillLayerSpecification | LineLayerSpecification | SymbolLayerSpecification | CircleLayerSpecification | HeatmapLayerSpecification | RasterLayerSpecification;

export interface StyleSpecification {
  version: 8;
  name?: string;
  metadata?: unknown;
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  sprite?: string | Array<{ id: string; url: string }>;
  glyphs?: string;
  transition?: { duration?: number; delay?: number };
  sources: { [id: string]: SourceSpecification };
  layers: LayerSpecification[];
}

// ── requests / protocols ──────────────────────────────────────────────────────
export interface RequestParameters {
  url: string;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST' | 'PUT';
  body?: string;
  type?: 'string' | 'json' | 'arrayBuffer' | 'image';
  credentials?: 'same-origin' | 'include';
  collectResourceTiming?: boolean;
  cache?: RequestCache;
}
export interface GetResourceResponse<T> {
  data: T;
  cacheControl?: string | null;
  expires?: string | null;
}
export type AddProtocolAction = (requestParameters: RequestParameters, abortController: AbortController) => Promise<GetResourceResponse<unknown>>;
export function addProtocol(customProtocol: string, loadFn: AddProtocolAction): void;
export function removeProtocol(customProtocol: string): void;
export type ResourceType = 'Unknown' | 'Style' | 'Source' | 'Tile' | 'Glyphs' | 'SpriteImage' | 'SpriteJSON' | 'Image';
export type RequestTransformFunction = (url: string, resourceType?: ResourceType) => RequestParameters | undefined;
export const version: string;

// ── sources ───────────────────────────────────────────────────────────────────
export interface Source {
  readonly type: string;
  readonly id: string;
  minzoom: number;
  maxzoom: number;
}
export interface GeoJSONSourceDiff {
  removeAll?: boolean;
  remove?: Array<string | number>;
  add?: GeoJSONFeature[];
  update?: Array<{ id: string | number; newGeometry?: GeoJSONGeometry; removeAllProperties?: boolean; removeProperties?: string[]; addOrUpdateProperties?: Array<{ key: string; value: unknown }> }>;
}
export class GeoJSONSource implements Source {
  readonly type: 'geojson';
  readonly id: string;
  minzoom: number;
  maxzoom: number;
  setData(data: GeoJSON | string): this;
  updateData(diff: GeoJSONSourceDiff): this;
  setClusterOptions(options: { cluster?: boolean; clusterMaxZoom?: number; clusterRadius?: number }): this;
  getClusterExpansionZoom(clusterId: number): Promise<number>;
  getClusterChildren(clusterId: number): Promise<GeoJSONFeature[]>;
  getClusterLeaves(clusterId: number, limit: number, offset: number): Promise<GeoJSONFeature[]>;
}
export class RasterTileSource implements Source {
  readonly type: 'raster';
  readonly id: string;
  minzoom: number;
  maxzoom: number;
  setTiles(tiles: string[]): this;
}
export class VectorTileSource implements Source {
  readonly type: 'vector';
  readonly id: string;
  minzoom: number;
  maxzoom: number;
  setTiles(tiles: string[]): this;
}

// ── controls ──────────────────────────────────────────────────────────────────
export type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface IControl {
  onAdd(map: Map): HTMLElement;
  onRemove(map: Map): void;
  getDefaultPosition?(): ControlPosition;
}
export interface AttributionControlOptions {
  compact?: boolean;
  customAttribution?: string | string[];
}
export class AttributionControl implements IControl {
  constructor(options?: AttributionControlOptions);
  onAdd(map: Map): HTMLElement;
  onRemove(map: Map): void;
  getDefaultPosition(): ControlPosition;
}
export class NavigationControl implements IControl {
  constructor(options?: { showCompass?: boolean; showZoom?: boolean; visualizePitch?: boolean });
  onAdd(map: Map): HTMLElement;
  onRemove(map: Map): void;
}

// ── events ────────────────────────────────────────────────────────────────────
export interface MapLibreEvent<TOrig = unknown> {
  type: string;
  target: Map;
  originalEvent?: TOrig;
}
export interface MapMouseEvent extends MapLibreEvent<MouseEvent> {
  originalEvent: MouseEvent;
  point: Point;
  lngLat: LngLat;
  defaultPrevented: boolean;
  preventDefault(): void;
}
export interface ErrorEvent {
  type: 'error';
  error: Error;
}
export interface MapSourceDataEvent extends MapLibreEvent {
  sourceId?: string;
  isSourceLoaded?: boolean;
  dataType: 'source';
}
export interface MapEventType {
  load: MapLibreEvent;
  'style.load': MapLibreEvent;
  idle: MapLibreEvent;
  render: MapLibreEvent;
  remove: MapLibreEvent;
  resize: MapLibreEvent;
  error: ErrorEvent;
  click: MapMouseEvent;
  dblclick: MapMouseEvent;
  contextmenu: MapMouseEvent;
  mousemove: MapMouseEvent;
  mouseout: MapMouseEvent;
  move: MapLibreEvent;
  movestart: MapLibreEvent;
  moveend: MapLibreEvent;
  zoom: MapLibreEvent;
  zoomend: MapLibreEvent;
  rotate: MapLibreEvent;
  pitch: MapLibreEvent;
  styledata: MapLibreEvent;
  sourcedata: MapSourceDataEvent;
  webglcontextlost: MapLibreEvent;
  webglcontextrestored: MapLibreEvent;
}

export type Listener = (ev: unknown) => void;
export class Evented {
  on(type: string, listener: Listener): this;
  off(type: string, listener: Listener): this;
  once(type: string, listener: Listener): this;
}

// ── map ───────────────────────────────────────────────────────────────────────
export interface PaddingOptions { top: number; bottom: number; left: number; right: number }
export interface CameraOptions {
  center?: LngLatLike;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  around?: LngLatLike;
  padding?: PaddingOptions | number;
}
export interface AnimationOptions {
  duration?: number;
  easing?: (t: number) => number;
  offset?: PointLike;
  animate?: boolean;
  essential?: boolean;
  freezeElevation?: boolean;
}
export type JumpToOptions = CameraOptions;
export type EaseToOptions = CameraOptions & AnimationOptions & { delayEndEvents?: number; noMoveStart?: boolean };
export type FlyToOptions = CameraOptions & AnimationOptions & { curve?: number; minZoom?: number; speed?: number; screenSpeed?: number; maxDuration?: number };
export type FitBoundsOptions = FlyToOptions & { linear?: boolean; maxZoom?: number };

export interface QueryRenderedFeaturesOptions {
  layers?: string[];
  filter?: FilterSpecification;
  validate?: boolean;
}
export interface MapGeoJSONFeature {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJSONGeometry;
  properties: { [name: string]: unknown };
  layer: { id: string; type: string };
  source: string;
  sourceLayer?: string;
  state: { [key: string]: unknown };
}
export interface FeatureIdentifier { id?: string | number; source: string; sourceLayer?: string }

export interface StyleImageMetadata { pixelRatio?: number; sdf?: boolean; stretchX?: Array<[number, number]>; stretchY?: Array<[number, number]>; content?: [number, number, number, number] }
export type StyleImageInput = HTMLImageElement | ImageBitmap | ImageData | { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

export interface WebGLContextAttributesWithType {
  antialias?: boolean;
  preserveDrawingBuffer?: boolean;
  powerPreference?: 'default' | 'low-power' | 'high-performance';
  failIfMajorPerformanceCaveat?: boolean;
  desynchronized?: boolean;
  contextType?: 'webgl2' | 'webgl' | 'webgl2withfallback';
}

export interface MapOptions {
  container: HTMLElement | string;
  style?: StyleSpecification | string;
  center?: LngLatLike;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  minZoom?: number | null;
  maxZoom?: number | null;
  minPitch?: number | null;
  maxPitch?: number | null;
  maxBounds?: LngLatBoundsLike | null;
  attributionControl?: false | AttributionControlOptions;
  /** MapLibre 4 name; MapLibre 5 reads `canvasContextAttributes.preserveDrawingBuffer`. */
  preserveDrawingBuffer?: boolean;
  antialias?: boolean;
  canvasContextAttributes?: WebGLContextAttributesWithType;
  interactive?: boolean;
  fadeDuration?: number;
  renderWorldCopies?: boolean;
  maxTileCacheSize?: number | null;
  transformRequest?: RequestTransformFunction | null;
  localIdeographFontFamily?: string | false;
  pixelRatio?: number;
  validateStyle?: boolean;
  hash?: boolean | string;
  dragRotate?: boolean;
  touchPitch?: boolean;
  cooperativeGestures?: boolean;
  refreshExpiredTiles?: boolean;
  trackResize?: boolean;
}

export class Map extends Evented {
  constructor(options: MapOptions);
  on<T extends keyof MapEventType>(type: T, listener: (ev: MapEventType[T]) => void): this;
  on<T extends keyof MapEventType>(type: T, layerId: string, listener: (ev: MapEventType[T]) => void): this;
  on(type: string, listener: Listener): this;
  off<T extends keyof MapEventType>(type: T, listener: (ev: MapEventType[T]) => void): this;
  off<T extends keyof MapEventType>(type: T, layerId: string, listener: (ev: MapEventType[T]) => void): this;
  off(type: string, listener: Listener): this;
  once<T extends keyof MapEventType>(type: T, listener: (ev: MapEventType[T]) => void): this;
  once(type: string, listener: Listener): this;
  addSource(id: string, source: SourceSpecification): this;
  getSource<TSource extends Source = Source>(id: string): TSource | undefined;
  removeSource(id: string): this;
  isSourceLoaded(id: string): boolean;
  addLayer(layer: LayerSpecification, beforeId?: string): this;
  removeLayer(id: string): this;
  getLayer(id: string): { id: string; type: string; source?: string } | undefined;
  moveLayer(id: string, beforeId?: string): this;
  setLayoutProperty(layerId: string, name: string, value: unknown, options?: { validate?: boolean }): this;
  setPaintProperty(layerId: string, name: string, value: unknown, options?: { validate?: boolean }): this;
  setFilter(layerId: string, filter?: FilterSpecification | null, options?: { validate?: boolean }): this;
  setLayerZoomRange(layerId: string, minzoom: number, maxzoom: number): this;
  addImage(id: string, image: StyleImageInput, options?: StyleImageMetadata): this;
  hasImage(id: string): boolean;
  removeImage(id: string): void;
  listImages(): string[];
  queryRenderedFeatures(geometryOrOptions?: PointLike | [PointLike, PointLike] | QueryRenderedFeaturesOptions, options?: QueryRenderedFeaturesOptions): MapGeoJSONFeature[];
  querySourceFeatures(sourceId: string, parameters?: { sourceLayer?: string; filter?: FilterSpecification; validate?: boolean }): MapGeoJSONFeature[];
  setStyle(style: StyleSpecification | string | null, options?: { diff?: boolean; validate?: boolean }): this;
  getStyle(): StyleSpecification;
  isStyleLoaded(): boolean;
  loaded(): boolean;
  getCenter(): LngLat;
  setCenter(center: LngLatLike): this;
  getZoom(): number;
  setZoom(zoom: number): this;
  getBearing(): number;
  setBearing(bearing: number): this;
  getPitch(): number;
  setPitch(pitch: number): this;
  getBounds(): LngLatBounds;
  fitBounds(bounds: LngLatBoundsLike, options?: FitBoundsOptions): this;
  jumpTo(options: JumpToOptions): this;
  easeTo(options: EaseToOptions): this;
  flyTo(options: FlyToOptions): this;
  stop(): this;
  isMoving(): boolean;
  project(lnglat: LngLatLike): Point;
  unproject(point: PointLike): LngLat;
  resize(): this;
  getCanvas(): HTMLCanvasElement;
  getCanvasContainer(): HTMLElement;
  getContainer(): HTMLElement;
  addControl(control: IControl, position?: ControlPosition): this;
  removeControl(control: IControl): this;
  hasControl(control: IControl): boolean;
  triggerRepaint(): void;
  redraw(): this;
  remove(): void;
  setFeatureState(feature: FeatureIdentifier, state: Record<string, unknown>): this;
  removeFeatureState(feature: FeatureIdentifier, key?: string): this;
  getFeatureState(feature: FeatureIdentifier): Record<string, unknown>;
  getMaxZoom(): number;
  getMinZoom(): number;
  setMaxPitch(maxPitch?: number | null): this;
  getPixelRatio(): number;
}
