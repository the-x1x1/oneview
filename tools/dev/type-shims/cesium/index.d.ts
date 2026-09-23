/**
 * Declaration shim for `cesium` — used ONLY when the real package is not installed
 * (tools/dev/typecheck.mjs maps it in and records that in evidence). It declares
 * the surface `packages/render-cesium` uses, matching the documented CesiumJS API
 * (≥ 1.120): Viewer options, ImageryLayer.fromProviderAsync, TileMapService /
 * UrlTemplate / ArcGisMapServer / OpenStreetMap / Ion imagery providers,
 * CesiumTerrainProvider.fromUrl, EllipsoidTerrainProvider, PointPrimitive /
 * Billboard / Label / Polyline collections, GroundPrimitive + RectangleGeometry,
 * CustomDataSource entities, scene.pick, Camera.flyTo / setView /
 * computeViewRectangle, SceneTransforms.worldToWindowCoordinates,
 *
 * Where this shim and the real package disagreed, the real package won: running the
 * typecheck on a machine with Cesium installed reported every mismatch, and those
 * signatures were copied back here. A shim that is laxer than reality is worse than no
 * shim, because it reports a pass the real build does not earn.
 * ScreenSpaceEventHandler, CreditDisplay, buildModuleUrl, Ion,
 * createGooglePhotorealistic3DTileset.
 *
 * When the real package is installed this file is not used; the adapter's
 * `CesiumLike` interface is then checked against Cesium's own declarations.
 */

// ── core math ──────────────────────────────────────────────────────────────────
export class Cartesian2 {
  constructor(x?: number, y?: number);
  x: number;
  y: number;
  static readonly ZERO: Cartesian2;
  static clone(cartesian: Cartesian2, result?: Cartesian2): Cartesian2;
}

export class Cartesian3 {
  constructor(x?: number, y?: number, z?: number);
  x: number;
  y: number;
  z: number;
  static readonly ZERO: Cartesian3;
  static readonly UNIT_Z: Cartesian3;
  static fromDegrees(
    longitude: number,
    latitude: number,
    height?: number,
    ellipsoid?: Ellipsoid,
    result?: Cartesian3,
  ): Cartesian3;
  static fromRadians(
    longitude: number,
    latitude: number,
    height?: number,
    ellipsoid?: Ellipsoid,
    result?: Cartesian3,
  ): Cartesian3;
  static fromDegreesArray(coordinates: number[], ellipsoid?: Ellipsoid, result?: Cartesian3[]): Cartesian3[];
  static fromDegreesArrayHeights(coordinates: number[], ellipsoid?: Ellipsoid, result?: Cartesian3[]): Cartesian3[];
  static distance(left: Cartesian3, right: Cartesian3): number;
  static clone(cartesian: Cartesian3, result?: Cartesian3): Cartesian3;
  static equals(left?: Cartesian3, right?: Cartesian3): boolean;
}

export class Cartographic {
  constructor(longitude?: number, latitude?: number, height?: number);
  /** Radians. */
  longitude: number;
  /** Radians. */
  latitude: number;
  /** Metres above the ellipsoid. */
  height: number;
  static fromCartesian(cartesian: Cartesian3, ellipsoid?: Ellipsoid, result?: Cartographic): Cartographic | undefined;
  static fromDegrees(longitude: number, latitude: number, height?: number, result?: Cartographic): Cartographic;
  static fromRadians(longitude: number, latitude: number, height?: number, result?: Cartographic): Cartographic;
  static toCartesian(cartographic: Cartographic, ellipsoid?: Ellipsoid, result?: Cartesian3): Cartesian3;
}

export class Ellipsoid {
  static readonly WGS84: Ellipsoid;
  cartesianToCartographic(cartesian: Cartesian3, result?: Cartographic): Cartographic | undefined;
  cartographicToCartesian(cartographic: Cartographic, result?: Cartesian3): Cartesian3;
  readonly maximumRadius: number;
}

export class Rectangle {
  constructor(west?: number, south?: number, east?: number, north?: number);
  /** Radians. */
  west: number;
  south: number;
  east: number;
  north: number;
  static readonly MAX_VALUE: Rectangle;
  static fromDegrees(west: number, south: number, east: number, north: number, result?: Rectangle): Rectangle;
  static fromRadians(west: number, south: number, east: number, north: number, result?: Rectangle): Rectangle;
  static center(rectangle: Rectangle, result?: Cartographic): Cartographic;
  static computeWidth(rectangle: Rectangle): number;
  static computeHeight(rectangle: Rectangle): number;
}

export class BoundingRectangle {
  constructor(x?: number, y?: number, width?: number, height?: number);
  x: number;
  y: number;
  width: number;
  height: number;
}

export class HeadingPitchRoll {
  constructor(heading?: number, pitch?: number, roll?: number);
  heading: number;
  pitch: number;
  roll: number;
}

export class HeadingPitchRange {
  constructor(heading?: number, pitch?: number, range?: number);
  heading: number;
  pitch: number;
  range: number;
}

export class Matrix4 {
  static readonly IDENTITY: Matrix4;
}

export class Ray {
  origin: Cartesian3;
  direction: Cartesian3;
}

export class NearFarScalar {
  constructor(near?: number, nearValue?: number, far?: number, farValue?: number);
  near: number;
  nearValue: number;
  far: number;
  farValue: number;
}

export class DistanceDisplayCondition {
  constructor(near?: number, far?: number);
  near: number;
  far: number;
}

export class JulianDate {
  static now(result?: JulianDate): JulianDate;
}

export namespace Math {
  function toRadians(degrees: number): number;
  function toDegrees(radians: number): number;
  function clamp(value: number, min: number, max: number): number;
  const PI_OVER_TWO: number;
  const TWO_PI: number;
  const EPSILON7: number;
}

export class Color {
  constructor(red?: number, green?: number, blue?: number, alpha?: number);
  red: number;
  green: number;
  blue: number;
  alpha: number;
  withAlpha(alpha: number, result?: Color): Color;
  toCssColorString(): string;
  static fromCssColorString(color: string, result?: Color): Color;
  static fromBytes(red?: number, green?: number, blue?: number, alpha?: number, result?: Color): Color;
  static fromAlpha(color: Color, alpha: number, result?: Color): Color;
  static readonly WHITE: Color;
  static readonly BLACK: Color;
  static readonly TRANSPARENT: Color;
  static readonly YELLOW: Color;
}

export function defined<T>(value: T): value is NonNullable<T>;
export function createGuid(): string;
export function buildModuleUrl(relativeUrl: string): string;
export const VERSION: string;

// ── events ────────────────────────────────────────────────────────────────────
export class Event<Args extends unknown[] = []> {
  readonly numberOfListeners: number;
  addEventListener(listener: (...args: Args) => void, scope?: object): Event.RemoveCallback;
  removeEventListener(listener: (...args: Args) => void, scope?: object): boolean;
  raiseEvent(...args: Args): void;
}
export namespace Event {
  type RemoveCallback = () => void;
}

// ── credits ───────────────────────────────────────────────────────────────────
export class Credit {
  constructor(html: string, showOnScreen?: boolean);
  readonly html: string;
  readonly showOnScreen: boolean;
  readonly element: HTMLElement;
  static equals(left?: Credit, right?: Credit): boolean;
}

export class CreditDisplay {
  constructor(container: HTMLElement, delimiter?: string, viewport?: HTMLElement);
  container: HTMLElement;
  addStaticCredit(credit: Credit): void;
  removeStaticCredit(credit: Credit): void;
  addCreditToNextFrame(credit: Credit): void;
  showLightbox(): void;
  hideLightbox(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

// ── resources / ion ───────────────────────────────────────────────────────────
export class Resource {
  constructor(options: string | Resource.ConstructorOptions);
  url: string;
  headers: Record<string, string>;
}
export namespace Resource {
  interface ConstructorOptions {
    url: string;
    queryParameters?: Record<string, string>;
    headers?: Record<string, string>;
    retryAttempts?: number;
  }
}

export class IonResource extends Resource {
  static fromAssetId(
    assetId: number,
    options?: { accessToken?: string; server?: string | Resource },
  ): Promise<IonResource>;
}

export namespace Ion {
  let defaultAccessToken: string;
  let defaultServer: string | Resource;
}

export enum IonWorldImageryStyle {
  AERIAL = 2,
  AERIAL_WITH_LABELS = 3,
  ROAD = 4,
}

// ── imagery ───────────────────────────────────────────────────────────────────
export class TileProviderError {
  readonly message: string;
  readonly timesRetried: number;
  retry: boolean;
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly error: Error | undefined;
}

export class GeographicTilingScheme {
  constructor(options?: { numberOfLevelZeroTilesX?: number; numberOfLevelZeroTilesY?: number });
  readonly rectangle: Rectangle;
}
export class DiscardEmptyTileImagePolicy {
  constructor();
  static readonly EMPTY_IMAGE: HTMLImageElement;
}
export class ImageryProvider {
  readonly errorEvent: Event<[TileProviderError]>;
  readonly credit: Credit | undefined;
  readonly maximumLevel: number | undefined;
  readonly minimumLevel: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly hasAlphaChannel: boolean;
  readonly rectangle: Rectangle;
}

export class UrlTemplateImageryProvider extends ImageryProvider {
  constructor(options: UrlTemplateImageryProvider.ConstructorOptions);
  readonly url: string;
}
export namespace UrlTemplateImageryProvider {
  interface ConstructorOptions {
    url: Resource | string;
    pickFeaturesUrl?: Resource | string;
    urlSchemeZeroPadding?: Record<string, string>;
    subdomains?: string | string[];
    credit?: Credit | string;
    minimumLevel?: number;
    maximumLevel?: number;
    rectangle?: Rectangle;
    tilingScheme?: TilingScheme;
    ellipsoid?: Ellipsoid;
    tileWidth?: number;
    tileHeight?: number;
    hasAlphaChannel?: boolean;
    enablePickFeatures?: boolean;
    customTags?: Record<
      string,
      (imageryProvider: UrlTemplateImageryProvider, x: number, y: number, level: number) => string
    >;
  }
}

export class TileMapServiceImageryProvider extends UrlTemplateImageryProvider {
  static fromUrl(
    url: Resource | string,
    options?: TileMapServiceImageryProvider.ConstructorOptions,
  ): Promise<TileMapServiceImageryProvider>;
}
export namespace TileMapServiceImageryProvider {
  interface ConstructorOptions {
    fileExtension?: string;
    credit?: Credit | string;
    minimumLevel?: number;
    maximumLevel?: number;
    rectangle?: Rectangle;
    tilingScheme?: TilingScheme;
    ellipsoid?: Ellipsoid;
    tileWidth?: number;
    tileHeight?: number;
    flipXY?: boolean;
  }
}

export class OpenStreetMapImageryProvider extends UrlTemplateImageryProvider {
  constructor(options: OpenStreetMapImageryProvider.ConstructorOptions);
}
export namespace OpenStreetMapImageryProvider {
  interface ConstructorOptions {
    url?: string;
    fileExtension?: string;
    retinaTiles?: boolean;
    rectangle?: Rectangle;
    minimumLevel?: number;
    maximumLevel?: number;
    ellipsoid?: Ellipsoid;
    credit?: Credit | string;
  }
}

export class ArcGisMapServerImageryProvider extends ImageryProvider {
  static fromUrl(
    url: Resource | string,
    options?: ArcGisMapServerImageryProvider.ConstructorOptions,
  ): Promise<ArcGisMapServerImageryProvider>;
  readonly url: string;
  enablePickFeatures: boolean;
}
export namespace ArcGisMapServerImageryProvider {
  interface ConstructorOptions {
    tileDiscardPolicy?: unknown;
    usePreCachedTilesIfAvailable?: boolean;
    layers?: string;
    enablePickFeatures?: boolean;
    rectangle?: Rectangle;
    tilingScheme?: TilingScheme;
    ellipsoid?: Ellipsoid;
    credit?: Credit | string;
    tileWidth?: number;
    tileHeight?: number;
    maximumLevel?: number;
  }
}

export class IonImageryProvider extends ImageryProvider {
  static fromAssetId(assetId: number, options?: IonImageryProvider.ConstructorOptions): Promise<IonImageryProvider>;
}
export namespace IonImageryProvider {
  interface ConstructorOptions {
    accessToken?: string;
    server?: string | Resource;
  }
}

export class TilingScheme {}

export class ImageryLayer {
  constructor(imageryProvider?: ImageryProvider, options?: ImageryLayer.ConstructorOptions);
  static fromProviderAsync(
    imageryProviderPromise: Promise<ImageryProvider>,
    options?: ImageryLayer.ConstructorOptions,
  ): ImageryLayer;
  show: boolean;
  alpha: number;
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  readonly imageryProvider: ImageryProvider;
  readonly ready: boolean;
  readonly readyEvent: Event<[ImageryProvider]>;
  readonly errorEvent: Event<[Error]>;
  destroy(): void;
  isDestroyed(): boolean;
}
export namespace ImageryLayer {
  interface ConstructorOptions {
    rectangle?: Rectangle;
    alpha?: number;
    brightness?: number;
    contrast?: number;
    saturation?: number;
    gamma?: number;
    show?: boolean;
    minimumTerrainLevel?: number;
    maximumTerrainLevel?: number;
  }
}

export class ImageryLayerCollection {
  readonly length: number;
  add(layer: ImageryLayer, index?: number): void;
  addImageryProvider(imageryProvider: ImageryProvider, index?: number): ImageryLayer;
  remove(layer: ImageryLayer, destroy?: boolean): boolean;
  removeAll(destroy?: boolean): void;
  contains(layer: ImageryLayer): boolean;
  get(index: number): ImageryLayer;
  raiseToTop(layer: ImageryLayer): void;
  lowerToBottom(layer: ImageryLayer): void;
}

// ── terrain ───────────────────────────────────────────────────────────────────
export class TerrainProvider {
  readonly errorEvent: Event<[TileProviderError]>;
  readonly credit: Credit | undefined;
  readonly hasWaterMask: boolean;
  readonly hasVertexNormals: boolean;
}

export class EllipsoidTerrainProvider extends TerrainProvider {
  constructor(options?: { tilingScheme?: TilingScheme; ellipsoid?: Ellipsoid });
}

export class CesiumTerrainProvider extends TerrainProvider {
  static fromUrl(
    url: Resource | string | Promise<Resource> | Promise<string>,
    options?: CesiumTerrainProvider.ConstructorOptions,
  ): Promise<CesiumTerrainProvider>;
}
export namespace CesiumTerrainProvider {
  interface ConstructorOptions {
    requestVertexNormals?: boolean;
    requestWaterMask?: boolean;
    requestMetadata?: boolean;
    ellipsoid?: Ellipsoid;
    credit?: Credit | string;
  }
}

export function createWorldTerrainAsync(options?: {
  requestVertexNormals?: boolean;
  requestWaterMask?: boolean;
}): Promise<CesiumTerrainProvider>;

export class Terrain {
  constructor(terrainProviderPromise: Promise<TerrainProvider>);
  static fromWorldTerrain(options?: { requestVertexNormals?: boolean; requestWaterMask?: boolean }): Terrain;
  readonly ready: boolean;
  readonly provider: TerrainProvider;
  readonly readyEvent: Event<[TerrainProvider]>;
  readonly errorEvent: Event<[Error]>;
}

// ── 3D tiles ──────────────────────────────────────────────────────────────────
export class Cesium3DTileset {
  static fromUrl(
    url: Resource | string | IonResource,
    options?: Cesium3DTileset.ConstructorOptions,
  ): Promise<Cesium3DTileset>;
  static fromIonAssetId(assetId: number, options?: Cesium3DTileset.ConstructorOptions): Promise<Cesium3DTileset>;
  show: boolean;
  maximumScreenSpaceError: number;
  cacheBytes: number;
  maximumCacheOverflowBytes: number;
  readonly ready: boolean;
  destroy(): void;
  isDestroyed(): boolean;
}
export namespace Cesium3DTileset {
  interface ConstructorOptions {
    show?: boolean;
    maximumScreenSpaceError?: number;
    cacheBytes?: number;
    maximumCacheOverflowBytes?: number;
    enableCollision?: boolean;
    showCreditsOnScreen?: boolean;
  }
}

export function createGooglePhotorealistic3DTileset(
  options?: { key?: string; onlyUsingWithGoogleGeocoder?: true } & Cesium3DTileset.ConstructorOptions,
): Promise<Cesium3DTileset>;

// ── scene / camera / viewer ───────────────────────────────────────────────────
export enum SceneMode {
  MORPHING = 0,
  COLUMBUS_VIEW = 1,
  SCENE2D = 2,
  SCENE3D = 3,
}

export enum CameraEventType {
  LEFT_DRAG = 0,
  RIGHT_DRAG = 1,
  MIDDLE_DRAG = 2,
  WHEEL = 3,
  PINCH = 4,
}

export enum KeyboardEventModifier {
  SHIFT = 0,
  CTRL = 1,
  ALT = 2,
}

export interface CameraEventBinding {
  eventType: CameraEventType;
  modifier: KeyboardEventModifier;
}

export class ScreenSpaceCameraController {
  enableInputs: boolean;
  enableZoom: boolean;
  enableRotate: boolean;
  enableTilt: boolean;
  enableTranslate: boolean;
  enableLook: boolean;
  enableCollisionDetection: boolean;
  minimumZoomDistance: number;
  maximumZoomDistance: number;
  zoomEventTypes: CameraEventType | CameraEventBinding | Array<CameraEventType | CameraEventBinding> | undefined;
  tiltEventTypes: CameraEventType | CameraEventBinding | Array<CameraEventType | CameraEventBinding> | undefined;
}

export interface CameraOrientation {
  heading?: number;
  pitch?: number;
  roll?: number;
}

export class Camera {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  readonly positionCartographic: Cartographic;
  readonly positionWC: Cartesian3;
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
  percentageChanged: number;
  readonly changed: Event<[number]>;
  readonly moveStart: Event<[]>;
  readonly moveEnd: Event<[]>;
  setView(options: {
    destination?: Cartesian3 | Rectangle;
    orientation?: CameraOrientation | HeadingPitchRoll;
    endTransform?: Matrix4;
    convert?: boolean;
  }): void;
  flyTo(options: {
    destination: Cartesian3 | Rectangle;
    orientation?: CameraOrientation | HeadingPitchRoll;
    duration?: number;
    complete?: Camera.FlightCompleteCallback;
    cancel?: Camera.FlightCancelledCallback;
    endTransform?: Matrix4;
    maximumHeight?: number;
    pitchAdjustHeight?: number;
    flyOverLongitude?: number;
    flyOverLongitudeWeight?: number;
    convert?: boolean;
    easingFunction?: (time: number) => number;
  }): void;
  flyToBoundingSphere(
    boundingSphere: unknown,
    options?: {
      duration?: number;
      offset?: HeadingPitchRange;
      complete?: Camera.FlightCompleteCallback;
      cancel?: Camera.FlightCancelledCallback;
    },
  ): void;
  cancelFlight(): void;
  computeViewRectangle(ellipsoid?: Ellipsoid, result?: Rectangle): Rectangle | undefined;
  pickEllipsoid(windowPosition: Cartesian2, ellipsoid?: Ellipsoid, result?: Cartesian3): Cartesian3 | undefined;
  getPickRay(windowPosition: Cartesian2, result?: Ray): Ray | undefined;
  lookAtTransform(transform: Matrix4, offset?: Cartesian3 | HeadingPitchRange): void;
}
export namespace Camera {
  type FlightCompleteCallback = () => void;
  type FlightCancelledCallback = () => void;
}

export class Globe {
  show: boolean;
  depthTestAgainstTerrain: boolean;
  enableLighting: boolean;
  showGroundAtmosphere: boolean;
  /** @cesium/engine 26.3.0 Globe.js: default 100. */
  tileCacheSize: number;
  /** @cesium/engine 26.3.0 Globe.js: default false. */
  preloadSiblings: boolean;
  baseColor: Color;
  maximumScreenSpaceError: number;
  terrainProvider: TerrainProvider;
  readonly tilesLoaded: boolean;
  getHeight(cartographic: Cartographic): number | undefined;
}

export class SkyAtmosphere {
  show: boolean;
  atmosphereLightIntensity: number;
  saturationShift: number;
  brightnessShift: number;
  hueShift: number;
}

export class SkyBox {
  show: boolean;
}

export class Fog {
  enabled: boolean;
  density: number;
}

export interface PickedObject {
  id?: unknown;
  primitive?: unknown;
}

export class PrimitiveCollection {
  constructor(options?: { show?: boolean; destroyPrimitives?: boolean });
  show: boolean;
  destroyPrimitives: boolean;
  readonly length: number;
  add<T>(primitive: T, index?: number): T;
  remove(primitive: unknown): boolean;
  removeAll(): void;
  contains(primitive: unknown): boolean;
  get(index: number): unknown;
  destroy(): void;
  isDestroyed(): boolean;
}

export class Scene {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  globe: Globe;
  skyAtmosphere: SkyAtmosphere | undefined;
  skyBox: SkyBox;
  fog: Fog;
  backgroundColor: Color;
  readonly primitives: PrimitiveCollection;
  readonly groundPrimitives: PrimitiveCollection;
  readonly imageryLayers: ImageryLayerCollection;
  terrainProvider: TerrainProvider;
  readonly screenSpaceCameraController: ScreenSpaceCameraController;
  requestRenderMode: boolean;
  maximumRenderTimeChange: number;
  mode: SceneMode;
  msaaSamples: number;
  highDynamicRange: boolean;
  debugShowFramesPerSecond: boolean;
  useDepthPicking: boolean;
  readonly pickPositionSupported: boolean;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly postRender: Event<[Scene, JulianDate]>;
  readonly preRender: Event<[Scene, JulianDate]>;
  readonly preUpdate: Event<[Scene, JulianDate]>;
  readonly renderError: Event<[Scene, Error]>;
  setTerrain(terrain: Terrain): Terrain;
  requestRender(): void;
  pick(windowPosition: Cartesian2, width?: number, height?: number): PickedObject | undefined;
  drillPick(windowPosition: Cartesian2, limit?: number, width?: number, height?: number): PickedObject[];
  pickPosition(windowPosition: Cartesian2, result?: Cartesian3): Cartesian3 | undefined;
}

export namespace SceneTransforms {
  function worldToWindowCoordinates(scene: Scene, position: Cartesian3, result?: Cartesian2): Cartesian2 | undefined;
  function worldToDrawingBufferCoordinates(
    scene: Scene,
    position: Cartesian3,
    result?: Cartesian2,
  ): Cartesian2 | undefined;
}

export interface WebGLOptions {
  alpha?: boolean;
  depth?: boolean;
  stencil?: boolean;
  antialias?: boolean;
  premultipliedAlpha?: boolean;
  preserveDrawingBuffer?: boolean;
  powerPreference?: 'default' | 'low-power' | 'high-performance';
  failIfMajorPerformanceCaveat?: boolean;
}

export interface ContextOptions {
  allowTextureFilterAnisotropic?: boolean;
  requestWebgl1?: boolean;
  webgl?: WebGLOptions;
}

export class Clock {
  currentTime: JulianDate;
  shouldAnimate: boolean;
}

export class CesiumWidget {
  constructor(container: Element | string, options?: CesiumWidget.ConstructorOptions);
  readonly container: Element;
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly imageryLayers: ImageryLayerCollection;
  readonly dataSources: DataSourceCollection;
  readonly entities: EntityCollection;
  readonly creditDisplay: CreditDisplay;
  readonly screenSpaceEventHandler: ScreenSpaceEventHandler;
  readonly clock: Clock;
  terrainProvider: TerrainProvider;
  targetFrameRate: number;
  useDefaultRenderLoop: boolean;
  resolutionScale: number;
  useBrowserRecommendedResolution: boolean;
  render(): void;
  resize(): void;
  destroy(): void;
  isDestroyed(): boolean;
}
export namespace CesiumWidget {
  interface ConstructorOptions {
    baseLayer?: ImageryLayer | false;
    creditContainer?: Element | string;
    creditViewport?: Element | string;
    contextOptions?: ContextOptions;
    msaaSamples?: number;
    requestRenderMode?: boolean;
    targetFrameRate?: number;
    useDefaultRenderLoop?: boolean;
    globe?: Globe | false;
    skyAtmosphere?: SkyAtmosphere | false;
    terrainProvider?: TerrainProvider;
    sceneMode?: SceneMode;
  }
}

export class Viewer {
  constructor(container: Element | string, options?: Viewer.ConstructorOptions);
  readonly container: Element;
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly imageryLayers: ImageryLayerCollection;
  terrainProvider: TerrainProvider;
  readonly dataSources: DataSourceCollection;
  readonly entities: EntityCollection;
  readonly creditDisplay: CreditDisplay;
  readonly screenSpaceEventHandler: ScreenSpaceEventHandler;
  readonly clock: Clock;
  readonly cesiumWidget: CesiumWidget;
  targetFrameRate: number;
  useDefaultRenderLoop: boolean;
  resolutionScale: number;
  useBrowserRecommendedResolution: boolean;
  render(): void;
  resize(): void;
  forceResize(): void;
  destroy(): void;
  isDestroyed(): boolean;
}
export namespace Viewer {
  interface ConstructorOptions {
    animation?: boolean;
    baseLayerPicker?: boolean;
    fullscreenButton?: boolean;
    vrButton?: boolean;
    geocoder?: boolean;
    homeButton?: boolean;
    infoBox?: boolean;
    sceneModePicker?: boolean;
    selectionIndicator?: boolean;
    timeline?: boolean;
    navigationHelpButton?: boolean;
    navigationInstructionsInitiallyVisible?: boolean;
    scene3DOnly?: boolean;
    shouldAnimate?: boolean;
    baseLayer?: ImageryLayer | false;
    ellipsoid?: Ellipsoid;
    terrainProvider?: TerrainProvider;
    terrain?: Terrain;
    skyBox?: SkyBox | false;
    skyAtmosphere?: SkyAtmosphere | false;
    fullscreenElement?: Element | string;
    useDefaultRenderLoop?: boolean;
    targetFrameRate?: number;
    showRenderLoopErrors?: boolean;
    useBrowserRecommendedResolution?: boolean;
    automaticallyTrackDataSourceClocks?: boolean;
    contextOptions?: ContextOptions;
    sceneMode?: SceneMode;
    globe?: Globe | false;
    orderIndependentTranslucency?: boolean;
    creditContainer?: Element | string;
    creditViewport?: Element | string;
    dataSources?: DataSourceCollection;
    shadows?: boolean;
    projectionPicker?: boolean;
    blurActiveElementOnCanvasFocus?: boolean;
    requestRenderMode?: boolean;
    maximumRenderTimeChange?: number;
    depthPlaneEllipsoidOffset?: number;
    msaaSamples?: number;
  }
}

// ── input ─────────────────────────────────────────────────────────────────────
export enum ScreenSpaceEventType {
  LEFT_DOWN = 0,
  LEFT_UP = 1,
  LEFT_CLICK = 2,
  LEFT_DOUBLE_CLICK = 3,
  RIGHT_DOWN = 5,
  RIGHT_UP = 6,
  RIGHT_CLICK = 7,
  MIDDLE_DOWN = 10,
  MIDDLE_UP = 11,
  MIDDLE_CLICK = 12,
  MOUSE_MOVE = 15,
  WHEEL = 16,
  PINCH_START = 17,
  PINCH_END = 18,
  PINCH_MOVE = 19,
}

export class ScreenSpaceEventHandler {
  constructor(element?: HTMLCanvasElement);
  setInputAction(
    action:
      | ScreenSpaceEventHandler.PositionedEventCallback
      | ScreenSpaceEventHandler.MotionEventCallback
      | ScreenSpaceEventHandler.WheelEventCallback,
    type: ScreenSpaceEventType,
    modifier?: KeyboardEventModifier,
  ): void;
  removeInputAction(type: ScreenSpaceEventType, modifier?: KeyboardEventModifier): void;
  destroy(): void;
  isDestroyed(): boolean;
}
export namespace ScreenSpaceEventHandler {
  interface PositionedEvent {
    position: Cartesian2;
  }
  interface MotionEvent {
    startPosition: Cartesian2;
    endPosition: Cartesian2;
  }
  type PositionedEventCallback = (event: PositionedEvent) => void;
  type MotionEventCallback = (event: MotionEvent) => void;
  type WheelEventCallback = (delta: number) => void;
}

// ── primitives ────────────────────────────────────────────────────────────────
export enum HeightReference {
  NONE = 0,
  CLAMP_TO_GROUND = 1,
  RELATIVE_TO_GROUND = 2,
  CLAMP_TO_TERRAIN = 3,
  RELATIVE_TO_TERRAIN = 4,
  CLAMP_TO_3D_TILE = 5,
  RELATIVE_TO_3D_TILE = 6,
}

export enum VerticalOrigin {
  CENTER = 0,
  BOTTOM = 1,
  BASELINE = 2,
  TOP = -1,
}

export enum HorizontalOrigin {
  CENTER = 0,
  LEFT = 1,
  RIGHT = -1,
}

export enum LabelStyle {
  FILL = 0,
  OUTLINE = 1,
  FILL_AND_OUTLINE = 2,
}

export enum ClassificationType {
  TERRAIN = 0,
  CESIUM_3D_TILE = 1,
  BOTH = 2,
}

export enum BlendOption {
  OPAQUE = 0,
  TRANSLUCENT = 1,
  OPAQUE_AND_TRANSLUCENT = 2,
}

export class PointPrimitive {
  show: boolean;
  position: Cartesian3;
  pixelSize: number;
  color: Color;
  outlineColor: Color;
  outlineWidth: number;
  id: unknown;
  disableDepthTestDistance: number | undefined;
  scaleByDistance: NearFarScalar | undefined;
  translucencyByDistance: NearFarScalar | undefined;
  distanceDisplayCondition: DistanceDisplayCondition | undefined;
}
export namespace PointPrimitive {
  interface ConstructorOptions {
    show?: boolean;
    position?: Cartesian3;
    pixelSize?: number;
    color?: Color;
    outlineColor?: Color;
    outlineWidth?: number;
    id?: unknown;
    disableDepthTestDistance?: number;
    scaleByDistance?: NearFarScalar;
    translucencyByDistance?: NearFarScalar;
    distanceDisplayCondition?: DistanceDisplayCondition;
  }
}

export class PointPrimitiveCollection {
  constructor(options?: {
    show?: boolean;
    modelMatrix?: Matrix4;
    blendOption?: BlendOption;
    debugShowBoundingVolume?: boolean;
  });
  show: boolean;
  readonly length: number;
  add(options?: PointPrimitive.ConstructorOptions): PointPrimitive;
  remove(pointPrimitive: PointPrimitive): boolean;
  removeAll(): void;
  contains(pointPrimitive: PointPrimitive): boolean;
  get(index: number): PointPrimitive;
  destroy(): void;
  isDestroyed(): boolean;
}

export class Billboard {
  show: boolean;
  position: Cartesian3;
  image: string | HTMLImageElement | HTMLCanvasElement | undefined;
  scale: number;
  /** Radians, counter-clockwise from `alignedAxis`. */
  rotation: number;
  alignedAxis: Cartesian3;
  color: Color;
  id: unknown;
  width: number | undefined;
  height: number | undefined;
  verticalOrigin: VerticalOrigin;
  horizontalOrigin: HorizontalOrigin;
  pixelOffset: Cartesian2;
  eyeOffset: Cartesian3;
  heightReference: HeightReference;
  disableDepthTestDistance: number | undefined;
  sizeInMeters: boolean;
  scaleByDistance: NearFarScalar | undefined;
  translucencyByDistance: NearFarScalar | undefined;
  distanceDisplayCondition: DistanceDisplayCondition | undefined;
  readonly ready: boolean;
  setImage(id: string, image: HTMLImageElement | HTMLCanvasElement | string | Resource): void;
  setImageSubRegion(id: string, subRegion: BoundingRectangle): void;
}
export namespace Billboard {
  interface ConstructorOptions {
    show?: boolean;
    position?: Cartesian3;
    image?: string | HTMLImageElement | HTMLCanvasElement;
    scale?: number;
    rotation?: number;
    alignedAxis?: Cartesian3;
    color?: Color;
    id?: unknown;
    width?: number;
    height?: number;
    verticalOrigin?: VerticalOrigin;
    horizontalOrigin?: HorizontalOrigin;
    pixelOffset?: Cartesian2;
    eyeOffset?: Cartesian3;
    heightReference?: HeightReference;
    disableDepthTestDistance?: number;
    sizeInMeters?: boolean;
    scaleByDistance?: NearFarScalar;
    translucencyByDistance?: NearFarScalar;
    distanceDisplayCondition?: DistanceDisplayCondition;
    imageSubRegion?: BoundingRectangle;
  }
}

export class BillboardCollection {
  constructor(options?: {
    modelMatrix?: Matrix4;
    debugShowBoundingVolume?: boolean;
    scene?: Scene;
    blendOption?: BlendOption;
    show?: boolean;
  });
  show: boolean;
  readonly length: number;
  add(options?: Billboard.ConstructorOptions): Billboard;
  remove(billboard: Billboard): boolean;
  removeAll(): void;
  contains(billboard: Billboard): boolean;
  get(index: number): Billboard;
  destroy(): void;
  isDestroyed(): boolean;
}

export class Label {
  show: boolean;
  position: Cartesian3;
  text: string;
  font: string;
  fillColor: Color;
  outlineColor: Color;
  outlineWidth: number;
  style: LabelStyle;
  pixelOffset: Cartesian2;
  horizontalOrigin: HorizontalOrigin;
  verticalOrigin: VerticalOrigin;
  scale: number;
  id: unknown;
  heightReference: HeightReference;
  disableDepthTestDistance: number | undefined;
  showBackground: boolean;
  backgroundColor: Color;
  backgroundPadding: Cartesian2;
  scaleByDistance: NearFarScalar | undefined;
  translucencyByDistance: NearFarScalar | undefined;
  distanceDisplayCondition: DistanceDisplayCondition | undefined;
}
export namespace Label {
  interface ConstructorOptions {
    show?: boolean;
    position?: Cartesian3;
    text?: string;
    font?: string;
    fillColor?: Color;
    outlineColor?: Color;
    outlineWidth?: number;
    style?: LabelStyle;
    pixelOffset?: Cartesian2;
    horizontalOrigin?: HorizontalOrigin;
    verticalOrigin?: VerticalOrigin;
    scale?: number;
    id?: unknown;
    heightReference?: HeightReference;
    disableDepthTestDistance?: number;
    showBackground?: boolean;
    backgroundColor?: Color;
    backgroundPadding?: Cartesian2;
    scaleByDistance?: NearFarScalar;
    translucencyByDistance?: NearFarScalar;
    distanceDisplayCondition?: DistanceDisplayCondition;
  }
}

export class LabelCollection {
  constructor(options?: {
    modelMatrix?: Matrix4;
    debugShowBoundingVolume?: boolean;
    scene?: Scene;
    blendOption?: BlendOption;
    show?: boolean;
  });
  show: boolean;
  readonly length: number;
  add(options?: Label.ConstructorOptions): Label;
  remove(label: Label): boolean;
  removeAll(): void;
  contains(label: Label): boolean;
  get(index: number): Label;
  destroy(): void;
  isDestroyed(): boolean;
}

export class Material {
  static fromType(type: string, uniforms?: Record<string, unknown>): Material;
  static readonly ColorType: string;
  static readonly PolylineDashType: string;
  static readonly PolylineGlowType: string;
  static readonly PolylineArrowType: string;
  readonly type: string;
  uniforms: Record<string, unknown>;
  destroy(): void;
  isDestroyed(): boolean;
}

export class Polyline {
  show: boolean;
  positions: Cartesian3[];
  width: number;
  material: Material;
  id: unknown;
  loop: boolean;
  distanceDisplayCondition: DistanceDisplayCondition | undefined;
}
export namespace Polyline {
  interface ConstructorOptions {
    show?: boolean;
    positions?: Cartesian3[];
    width?: number;
    material?: Material;
    id?: unknown;
    loop?: boolean;
    distanceDisplayCondition?: DistanceDisplayCondition;
  }
}

export class PolylineCollection {
  constructor(options?: { modelMatrix?: Matrix4; debugShowBoundingVolume?: boolean; show?: boolean });
  show: boolean;
  readonly length: number;
  add(options?: Polyline.ConstructorOptions): Polyline;
  remove(polyline: Polyline): boolean;
  removeAll(): void;
  contains(polyline: Polyline): boolean;
  get(index: number): Polyline;
  destroy(): void;
  isDestroyed(): boolean;
}

export class Geometry {}

export class VertexFormat {
  static readonly POSITION_ONLY: VertexFormat;
  static readonly POSITION_AND_COLOR: VertexFormat;
}

export class RectangleGeometry extends Geometry {
  constructor(options: {
    rectangle: Rectangle;
    vertexFormat?: VertexFormat;
    ellipsoid?: Ellipsoid;
    granularity?: number;
    height?: number;
    rotation?: number;
    stRotation?: number;
    extrudedHeight?: number;
  });
}

export class PolygonGeometry extends Geometry {
  constructor(options: {
    polygonHierarchy: PolygonHierarchy;
    height?: number;
    extrudedHeight?: number;
    vertexFormat?: VertexFormat;
    ellipsoid?: Ellipsoid;
    granularity?: number;
    perPositionHeight?: boolean;
  });
}

export interface GeometryInstanceAttribute {
  componentsPerAttribute: number;
  normalize: boolean;
  value: Uint8Array | Float32Array | number[];
}

export class ColorGeometryInstanceAttribute implements GeometryInstanceAttribute {
  constructor(red?: number, green?: number, blue?: number, alpha?: number);
  componentsPerAttribute: number;
  normalize: boolean;
  value: Uint8Array;
  static fromColor(color: Color): ColorGeometryInstanceAttribute;
}

export class GeometryInstance {
  constructor(options: {
    geometry: Geometry;
    modelMatrix?: Matrix4;
    id?: unknown;
    attributes?: Record<string, GeometryInstanceAttribute>;
  });
  id: unknown;
}

export class Appearance {}

export class PerInstanceColorAppearance extends Appearance {
  constructor(options?: { flat?: boolean; faceForward?: boolean; translucent?: boolean; closed?: boolean });
  static readonly VERTEX_FORMAT: VertexFormat;
  static readonly FLAT_VERTEX_FORMAT: VertexFormat;
}

export class GroundPrimitive {
  constructor(options?: {
    geometryInstances?: GeometryInstance | GeometryInstance[];
    appearance?: Appearance;
    show?: boolean;
    vertexCacheOptimize?: boolean;
    interleave?: boolean;
    compressVertices?: boolean;
    releaseGeometryInstances?: boolean;
    allowPicking?: boolean;
    asynchronous?: boolean;
    classificationType?: ClassificationType;
  });
  show: boolean;
  readonly ready: boolean;
  classificationType: ClassificationType;
  static isSupported(scene: Scene): boolean;
  destroy(): void;
  isDestroyed(): boolean;
}

// ── entities ──────────────────────────────────────────────────────────────────
export class Property {}
export class PositionProperty extends Property {}
export class MaterialProperty extends Property {}
export class ConstantProperty extends Property {
  constructor(value?: unknown);
}
export class ColorMaterialProperty extends MaterialProperty {
  constructor(color?: Property | Color);
}
export class PolylineDashMaterialProperty extends MaterialProperty {
  constructor(options?: {
    color?: Property | Color;
    gapColor?: Property | Color;
    dashLength?: Property | number;
    dashPattern?: Property | number;
  });
}
export class PropertyBag {}

export class PolygonHierarchy {
  constructor(positions?: Cartesian3[], holes?: PolygonHierarchy[]);
  positions: Cartesian3[];
  holes: PolygonHierarchy[];
}

export class PolygonGraphics {
  constructor(options?: PolygonGraphics.ConstructorOptions);
}
export namespace PolygonGraphics {
  interface ConstructorOptions {
    show?: Property | boolean;
    hierarchy?: Property | PolygonHierarchy | Cartesian3[];
    height?: Property | number;
    heightReference?: Property | HeightReference;
    extrudedHeight?: Property | number;
    fill?: Property | boolean;
    material?: MaterialProperty | Color;
    outline?: Property | boolean;
    outlineColor?: Property | Color;
    outlineWidth?: Property | number;
    perPositionHeight?: Property | boolean;
    classificationType?: Property | ClassificationType;
    zIndex?: Property | number;
  }
}

export class EllipseGraphics {
  constructor(options?: EllipseGraphics.ConstructorOptions);
}
export namespace EllipseGraphics {
  interface ConstructorOptions {
    show?: Property | boolean;
    semiMajorAxis?: Property | number;
    semiMinorAxis?: Property | number;
    height?: Property | number;
    heightReference?: Property | HeightReference;
    fill?: Property | boolean;
    material?: MaterialProperty | Color;
    outline?: Property | boolean;
    outlineColor?: Property | Color;
    outlineWidth?: Property | number;
    rotation?: Property | number;
    classificationType?: Property | ClassificationType;
    zIndex?: Property | number;
  }
}

export class PolylineGraphics {
  constructor(options?: PolylineGraphics.ConstructorOptions);
}
export namespace PolylineGraphics {
  interface ConstructorOptions {
    show?: Property | boolean;
    positions?: Property | Cartesian3[];
    width?: Property | number;
    material?: MaterialProperty | Color;
    clampToGround?: Property | boolean;
    classificationType?: Property | ClassificationType;
    zIndex?: Property | number;
  }
}

export class RectangleGraphics {
  constructor(options?: RectangleGraphics.ConstructorOptions);
}
export namespace RectangleGraphics {
  interface ConstructorOptions {
    show?: Property | boolean;
    coordinates?: Property | Rectangle;
    height?: Property | number;
    heightReference?: Property | HeightReference;
    extrudedHeight?: Property | number;
    fill?: Property | boolean;
    material?: MaterialProperty | Color;
    outline?: Property | boolean;
    outlineColor?: Property | Color;
    outlineWidth?: Property | number;
    classificationType?: Property | ClassificationType;
    zIndex?: Property | number;
  }
}

export class Entity {
  constructor(options?: Entity.ConstructorOptions);
  readonly id: string;
  name: string | undefined;
  show: boolean;
  position: PositionProperty | undefined;
  polygon: PolygonGraphics | undefined;
  polyline: PolylineGraphics | undefined;
  ellipse: EllipseGraphics | undefined;
  rectangle: RectangleGraphics | undefined;
  properties: PropertyBag | undefined;
}
export namespace Entity {
  interface ConstructorOptions {
    id?: string;
    name?: string;
    show?: boolean;
    description?: Property | string;
    position?: Cartesian3 | PositionProperty;
    polygon?: PolygonGraphics | PolygonGraphics.ConstructorOptions;
    polyline?: PolylineGraphics | PolylineGraphics.ConstructorOptions;
    ellipse?: EllipseGraphics | EllipseGraphics.ConstructorOptions;
    rectangle?: RectangleGraphics | RectangleGraphics.ConstructorOptions;
    properties?: PropertyBag | Record<string, unknown>;
  }
}

export class EntityCollection {
  readonly values: Entity[];
  readonly collectionChanged: Event<[EntityCollection, Entity[], Entity[], Entity[]]>;
  add(entity: Entity | Entity.ConstructorOptions): Entity;
  remove(entity: Entity): boolean;
  removeById(id: string): boolean;
  removeAll(): void;
  getById(id: string): Entity | undefined;
  contains(entity: Entity): boolean;
  suspendEvents(): void;
  resumeEvents(): void;
}

export class EntityCluster {
  enabled: boolean;
  pixelRange: number;
  minimumClusterSize: number;
}

export class DataSource {
  name: string;
  show: boolean;
  readonly entities: EntityCollection;
}

export class CustomDataSource extends DataSource {
  constructor(name?: string);
  clustering: EntityCluster;
}

export class DataSourceCollection {
  readonly length: number;
  add(dataSource: DataSource | Promise<DataSource>): Promise<DataSource>;
  remove(dataSource: DataSource, destroy?: boolean): boolean;
  removeAll(destroy?: boolean): void;
  contains(dataSource: DataSource): boolean;
  get(index: number): DataSource;
  destroy(): void;
}
