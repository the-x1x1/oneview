/**
 * The slice of the CesiumJS module this adapter uses, as structural interfaces.
 * Every Cesium call site takes a `CesiumLike` (or one of the narrower *Like
 * interfaces) so the adapter can be exercised in Node with a fake module and the
 * real module is adapted (and type-checked) in `cesium-module.ts`.
 *
 * Method-style members are used deliberately: TypeScript compares them
 * bivariantly, which lets Cesium's richer signatures satisfy these subsets.
 */
export interface Cartesian2Like {
  x: number;
  y: number;
}
export interface Cartesian3Like {
  x: number;
  y: number;
  z: number;
}
export interface CartographicLike {
  longitude: number;
  latitude: number;
  height: number;
}
export interface RectangleLike {
  west: number;
  south: number;
  east: number;
  north: number;
}
export interface ColorLike {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}
export interface BoundingRectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Heading and pitch (radians) and range (metres) of a camera round a target, in the target's local frame. */
export interface HeadingPitchRangeLike {
  heading: number;
  pitch: number;
  range: number;
}
export interface BoundingSphereLike {
  center: Cartesian3Like;
  radius: number;
}
/** A 4×4 transform, only ever handed back to Cesium (`Matrix4.IDENTITY` for "no transform"). */
export interface Matrix4Like {
  readonly length: number;
}
/** A time on Cesium's clock. */
export interface JulianDateLike {
  dayNumber: number;
  secondsOfDay: number;
}
export interface ClockLike {
  /** The simulation time the scene is drawn at, which is what the sun's direction is computed from. */
  currentTime: JulianDateLike;
}
export interface NearFarScalarLike {
  near: number;
  nearValue: number;
  far: number;
  farValue: number;
}

export interface EventLike<T = void> {
  addEventListener(listener: (arg: T) => void): () => void;
  removeEventListener(listener: (arg: T) => void): boolean;
}

export interface CreditLike {
  readonly html: string;
  readonly showOnScreen: boolean;
}
export interface CreditDisplayLike {
  addStaticCredit(credit: CreditLike): void;
  removeStaticCredit(credit: CreditLike): void;
}

export interface TileProviderErrorLike {
  timesRetried?: number;
  message?: string;
  level?: number;
  /** What the request failed with (an Error, a RequestErrorEvent with a statusCode, …). */
  error?: unknown;
}
export interface ImageryProviderLike {
  readonly errorEvent?: EventLike<TileProviderErrorLike>;
  destroy?(): void;
  isDestroyed?(): boolean;
}
export interface ImageryLayerLike {
  show: boolean;
  alpha: number;
  /**
   * Which side of `scene.splitPosition` the layer is drawn on (`SplitDirection`): the imagery
   * comparison (raster-overlays.ts). Optional here because only overlays are ever split.
   */
  splitDirection?: number;
  destroy(): void;
  isDestroyed(): boolean;
}
export interface ImageryLayerCollectionLike {
  readonly length: number;
  add(layer: ImageryLayerLike, index?: number): void;
  remove(layer: ImageryLayerLike, destroy?: boolean): boolean;
  removeAll(destroy?: boolean): void;
}

export interface TerrainProviderLike {
  readonly hasWaterMask: boolean;
  readonly hasVertexNormals: boolean;
  destroy?(): void;
  isDestroyed?(): boolean;
}

export interface TilesetLike {
  show: boolean;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface PrimitiveCollectionLike {
  add<T>(primitive: T, index?: number): T;
  remove(primitive: unknown): boolean;
  removeAll(): void;
  contains(primitive: unknown): boolean;
  readonly length: number;
}
/** A `PrimitiveCollection` of WORLDVIEW's own, added to the scene's: one switch and one teardown for a group. */
export interface PrimitiveGroupLike extends PrimitiveCollectionLike {
  show: boolean;
  destroy(): void;
  isDestroyed(): boolean;
}

/**
 * A glTF model placed by a transform (layers/models.ts). `modelMatrix` is read by Cesium on
 * every update and compared with the last one it used, so writing new values into it and
 * assigning it back moves the model without allocating.
 */
export interface ModelLike {
  show: boolean;
  modelMatrix: Matrix4Like;
  id: unknown;
  /** `HeightReference`: NONE for a height above the ellipsoid, RELATIVE_TO_GROUND for one above the terrain. */
  heightReference: number;
  silhouetteSize: number;
  silhouetteColor: ColorLike;
  /** True once the model's resources are loaded and it can be drawn. */
  readonly ready: boolean;
  readonly readyEvent: EventLike<unknown>;
  readonly errorEvent: EventLike<unknown>;
  destroy(): void;
  isDestroyed(): boolean;
}
export interface ModelOptionsLike {
  url: string;
  /** Needed for a height reference other than NONE. */
  scene: SceneLike;
  show?: boolean;
  /** The smallest the model is drawn on screen, in pixels, however far it is. */
  minimumPixelSize?: number;
  /** The most `minimumPixelSize` may enlarge it. */
  maximumScale?: number;
  id?: unknown;
  heightReference?: number;
}

export interface PointPrimitiveLike {
  show: boolean;
  position: Cartesian3Like;
  pixelSize: number;
  color: ColorLike;
  outlineColor: ColorLike;
  outlineWidth: number;
  id: unknown;
  disableDepthTestDistance: number | undefined;
}
export interface PointPrimitiveOptions {
  show?: boolean;
  position?: Cartesian3Like;
  pixelSize?: number;
  color?: ColorLike;
  outlineColor?: ColorLike;
  outlineWidth?: number;
  id?: unknown;
  disableDepthTestDistance?: number;
  scaleByDistance?: NearFarScalarLike;
}
export interface PointCollectionLike {
  show: boolean;
  readonly length: number;
  add(options?: PointPrimitiveOptions): PointPrimitiveLike;
  remove(point: PointPrimitiveLike): boolean;
  removeAll(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface BillboardLike {
  show: boolean;
  position: Cartesian3Like;
  image: string | HTMLImageElement | HTMLCanvasElement | undefined;
  scale: number;
  rotation: number;
  color: ColorLike;
  id: unknown;
  width: number | undefined;
  height: number | undefined;
  heightReference: number;
  disableDepthTestDistance: number | undefined;
}
export interface BillboardOptions {
  show?: boolean;
  position?: Cartesian3Like;
  image?: string | HTMLImageElement | HTMLCanvasElement;
  scale?: number;
  rotation?: number;
  alignedAxis?: Cartesian3Like;
  color?: ColorLike;
  id?: unknown;
  width?: number;
  height?: number;
  verticalOrigin?: number;
  horizontalOrigin?: number;
  heightReference?: number;
  disableDepthTestDistance?: number;
  scaleByDistance?: NearFarScalarLike;
}
export interface BillboardCollectionLike {
  show: boolean;
  readonly length: number;
  add(options?: BillboardOptions): BillboardLike;
  remove(billboard: BillboardLike): boolean;
  removeAll(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface LabelLike {
  show: boolean;
  position: Cartesian3Like;
  text: string;
  font: string;
  fillColor: ColorLike;
  outlineColor: ColorLike;
  outlineWidth: number;
  pixelOffset: Cartesian2Like;
  id: unknown;
  heightReference: number;
  disableDepthTestDistance: number | undefined;
}
export interface LabelOptions {
  show?: boolean;
  position?: Cartesian3Like;
  text?: string;
  font?: string;
  fillColor?: ColorLike;
  outlineColor?: ColorLike;
  outlineWidth?: number;
  style?: number;
  pixelOffset?: Cartesian2Like;
  horizontalOrigin?: number;
  verticalOrigin?: number;
  id?: unknown;
  heightReference?: number;
  disableDepthTestDistance?: number;
  scaleByDistance?: NearFarScalarLike;
}
export interface LabelCollectionLike {
  show: boolean;
  readonly length: number;
  add(options?: LabelOptions): LabelLike;
  remove(label: LabelLike): boolean;
  removeAll(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface MaterialLike {
  readonly type: string;
  uniforms: Record<string, unknown>;
}
export interface PolylineLike {
  show: boolean;
  positions: Cartesian3Like[];
  width: number;
  material: MaterialLike;
  id: unknown;
}
export interface PolylineOptions {
  show?: boolean;
  positions?: Cartesian3Like[];
  width?: number;
  material?: MaterialLike;
  id?: unknown;
  loop?: boolean;
}
export interface PolylineCollectionLike {
  show: boolean;
  readonly length: number;
  add(options?: PolylineOptions): PolylineLike;
  remove(polyline: PolylineLike): boolean;
  removeAll(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

/** One density cell for `createGroundRectangles`. */
export interface GroundRectangleCell {
  id: string;
  rectangle: RectangleLike;
  color: ColorLike;
}
export interface GroundPrimitiveLike {
  show: boolean;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface PolygonHierarchyLike {
  positions: Cartesian3Like[];
  holes: PolygonHierarchyLike[];
}
/** Cesium wraps entity values in `Property` objects; inputs accept either the raw value or a property. */
export interface PropertyLike {
  getValue?(time?: unknown, result?: unknown): unknown;
}
export type EntityValue<T> = T | PropertyLike | undefined;
export interface PolygonOptionsLike {
  hierarchy?: EntityValue<PolygonHierarchyLike | Cartesian3Like[]>;
  material?: EntityValue<ColorLike>;
  outline?: EntityValue<boolean>;
  outlineColor?: EntityValue<ColorLike>;
  outlineWidth?: EntityValue<number>;
  height?: EntityValue<number>;
  classificationType?: EntityValue<number>;
  heightReference?: EntityValue<number>;
}
export interface EllipseOptionsLike {
  semiMajorAxis?: EntityValue<number>;
  semiMinorAxis?: EntityValue<number>;
  material?: EntityValue<ColorLike>;
  outline?: EntityValue<boolean>;
  outlineColor?: EntityValue<ColorLike>;
  outlineWidth?: EntityValue<number>;
  height?: EntityValue<number>;
  classificationType?: EntityValue<number>;
  heightReference?: EntityValue<number>;
}
export interface PolylineOptionsLike {
  positions?: EntityValue<Cartesian3Like[]>;
  width?: EntityValue<number>;
  material?: EntityValue<ColorLike>;
  clampToGround?: EntityValue<boolean>;
}
export interface RectangleOptionsLike {
  coordinates?: EntityValue<RectangleLike>;
  material?: EntityValue<ColorLike>;
  outline?: EntityValue<boolean>;
  height?: EntityValue<number>;
  classificationType?: EntityValue<number>;
}
export interface EntityOptions {
  id?: string;
  name?: string | undefined;
  show?: boolean;
  position?: EntityValue<Cartesian3Like>;
  polygon?: PolygonOptionsLike | undefined;
  ellipse?: EllipseOptionsLike | undefined;
  polyline?: PolylineOptionsLike | undefined;
  rectangle?: RectangleOptionsLike | undefined;
}
export interface EntityLike {
  readonly id: string;
  show: boolean;
}
export interface EntityCollectionLike {
  add(entity: EntityOptions): EntityLike;
  remove(entity: EntityLike): boolean;
  removeById(id: string): boolean;
  removeAll(): void;
  getById(id: string): EntityLike | undefined;
  suspendEvents(): void;
  resumeEvents(): void;
}
export interface DataSourceLike {
  name: string;
  show: boolean;
  readonly entities: EntityCollectionLike;
}
export interface DataSourceCollectionLike {
  add(dataSource: DataSourceLike | Promise<DataSourceLike>): Promise<DataSourceLike>;
  remove(dataSource: DataSourceLike, destroy?: boolean): boolean;
}

/** Heading/pitch/roll in radians, or Cesium's direction/up form. */
export interface CameraOrientationLike {
  heading?: number;
  pitch?: number;
  roll?: number;
  direction?: Cartesian3Like;
  up?: Cartesian3Like;
}
export interface CameraLike {
  readonly positionCartographic: CartographicLike;
  /** Earth-fixed position in metres, what horizon culling tests against. */
  readonly positionWC: Cartesian3Like;
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
  /** Position in the camera's reference frame: the local frame of a `lookAt` target while one is set. */
  readonly position: Cartesian3Like;
  percentageChanged: number;
  readonly changed: EventLike<number>;
  readonly moveEnd: EventLike<void>;
  readonly moveStart: EventLike<void>;
  setView(options: { destination?: Cartesian3Like | RectangleLike; orientation?: CameraOrientationLike }): void;
  flyTo(options: {
    destination: Cartesian3Like | RectangleLike;
    orientation?: CameraOrientationLike;
    duration?: number;
    complete?: () => void;
    cancel?: () => void;
  }): void;
  /**
   * Fly so that a sphere is in the middle of the view, seen from `offset` (heading, pitch and
   * range in the sphere centre's local east-north-up frame).
   */
  flyToBoundingSphere(
    boundingSphere: BoundingSphereLike,
    options?: { duration?: number; offset?: HeadingPitchRangeLike; complete?: () => void; cancel?: () => void },
  ): void;
  /**
   * Put the camera at `offset` from `target` (a Cartesian in the target's east-north-up
   * frame, or heading/pitch/range) and fix its reference frame there: the camera controller
   * then turns round the target instead of the Earth's centre.
   */
  lookAt(target: Cartesian3Like, offset: Cartesian3Like | HeadingPitchRangeLike): void;
  /** Set the reference frame; `Matrix4.IDENTITY` returns the camera to the Earth-fixed frame where it is. */
  lookAtTransform(transform: Matrix4Like, offset?: Cartesian3Like | HeadingPitchRangeLike): void;
  cancelFlight(): void;
  computeViewRectangle(): RectangleLike | undefined;
  pickEllipsoid(windowPosition: Cartesian2Like): Cartesian3Like | undefined;
}

export interface GlobeLike {
  show: boolean;
  depthTestAgainstTerrain: boolean;
  baseColor: ColorLike;
  enableLighting: boolean;
  showGroundAtmosphere: boolean;
  /** Tiles kept resident beyond those in view. Cesium's default is 100. */
  tileCacheSize: number;
  /** Load the siblings of rendered tiles, so a pan reveals tiles already fetched. */
  preloadSiblings: boolean;
  /** Pixels of error a tile may show before a finer one is fetched (Cesium default 2). */
  maximumScreenSpaceError: number;
  /**
   * Camera distance from the Earth's centre (m) inside which lighting is faded out entirely,
   * and beyond which it is at full strength. Cesium's defaults (π/2 and π Earth radii) leave
   * everything below ~3,600 km altitude lit, day side and night side alike.
   */
  lightingFadeOutDistance: number;
  lightingFadeInDistance: number;
}
export interface SkyAtmosphereLike {
  show: boolean;
  atmosphereLightIntensity: number;
  saturationShift: number;
  brightnessShift: number;
}
export interface CameraEventBindingLike {
  eventType: number;
  modifier: number;
}
export interface ScreenSpaceCameraControllerLike {
  zoomEventTypes: number | CameraEventBindingLike | Array<number | CameraEventBindingLike> | undefined;
  enableCollisionDetection: boolean;
  minimumZoomDistance: number;
  maximumZoomDistance: number;
}
export interface PickedLike {
  id?: unknown;
  primitive?: unknown;
}
export interface SceneLike {
  readonly canvas: HTMLCanvasElement;
  readonly camera: CameraLike;
  globe: GlobeLike;
  /**
   * Where the imagery comparison's divider is, as the fraction of the canvas width left of it:
   * layers with a `splitDirection` are drawn only on their side of it.
   */
  splitPosition: number;
  /** Absent when the viewer was constructed with `skyAtmosphere: false`; Cesium types it optional. */
  skyAtmosphere: SkyAtmosphereLike | undefined;
  backgroundColor: ColorLike;
  readonly primitives: PrimitiveCollectionLike;
  readonly groundPrimitives: PrimitiveCollectionLike;
  terrainProvider: TerrainProviderLike;
  readonly screenSpaceCameraController: ScreenSpaceCameraControllerLike;
  requestRenderMode: boolean;
  /**
   * In request-render mode, the most simulation time (seconds) that may pass before a frame is
   * drawn anyway. Cesium's default, 0, redraws on every clock tick — i.e. every frame — which
   * would make request-render mode render continuously.
   */
  maximumRenderTimeChange: number;
  /** MSAA samples; changeable after construction. */
  msaaSamples: number;
  readonly postProcessStages: PostProcessStageCollectionLike;
  readonly pickPositionSupported: boolean;
  readonly postRender: EventLike<unknown>;
  readonly preRender: EventLike<unknown>;
  /** Raised as Scene.render starts, before the primitives update. */
  readonly preUpdate: EventLike<unknown>;
  requestRender(): void;
  pick(windowPosition: Cartesian2Like, width?: number, height?: number): PickedLike | undefined;
  pickPosition(windowPosition: Cartesian2Like): Cartesian3Like | undefined;
}

export interface PostProcessStageLike {
  enabled: boolean;
}
export interface PostProcessStageCollectionLike {
  readonly fxaa: PostProcessStageLike;
  /** Add a stage after the others; it runs on the whole frame, after the scene and before FXAA. */
  add(stage: PostProcessStageLike): unknown;
  /** Remove (and destroy) a stage. */
  remove(stage: PostProcessStageLike): boolean;
}
/** `new PostProcessStage({...})`: a full-screen fragment shader over the rendered frame. */
export interface PostProcessStageOptionsLike {
  fragmentShader: string;
  uniforms?: Record<string, unknown>;
  name?: string;
}

export interface ScreenSpaceEventHandlerLike {
  setInputAction(
    action: (event: { position?: Cartesian2Like; endPosition?: Cartesian2Like }) => void,
    type: number,
    modifier?: number,
  ): void;
  removeInputAction(type: number, modifier?: number): void;
  destroy(): void;
}

export interface ViewerLike {
  readonly container: Element;
  readonly canvas: HTMLCanvasElement;
  readonly scene: SceneLike;
  readonly camera: CameraLike;
  readonly imageryLayers: ImageryLayerCollectionLike;
  readonly dataSources: DataSourceCollectionLike;
  readonly creditDisplay: CreditDisplayLike;
  readonly clock: ClockLike;
  targetFrameRate: number;
  useDefaultRenderLoop: boolean;
  resolutionScale: number;
  /** When true (Cesium's default) the canvas is drawn at CSS pixels, not device pixels. */
  useBrowserRecommendedResolution: boolean;
  render(): void;
  resize(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

/**
 * The CesiumWidget constructor options WORLDVIEW sets.
 *
 * The widget-chrome flags (timeline, animation, baseLayerPicker, geocoder, homeButton,
 * sceneModePicker, navigationHelpButton, fullscreenButton, vrButton, selectionIndicator,
 * infoBox) used to be listed here because the adapter built a `Viewer`. It no longer
 * does — see cesium-module.ts — and CesiumWidget has no chrome to switch off, so naming
 * those flags would describe options nothing reads.
 */
export interface ViewerOptionsLike {
  /** `false` keeps the widget from installing its own default base layer; WORLDVIEW picks the stack. */
  baseLayer?: false;
  creditContainer?: Element;
  msaaSamples?: number;
  requestRenderMode?: boolean;
  contextOptions?: {
    webgl?: { preserveDrawingBuffer?: boolean; powerPreference?: 'default' | 'low-power' | 'high-performance' };
  };
}

/** Enumerations are consumed as plain numbers. */
export interface ResourceLike {
  readonly url: string;
}

/**
 * Module surface. Members that Cesium exposes as classes taking primitive inputs
 * are passed through as constructors; the few whose constructors take Cesium
 * class instances (Scene, Geometry, Resource) are exposed as factory methods,
 * because construct signatures are checked contravariantly and cannot be
 * satisfied by narrow interfaces. `cesium-module.ts` adapts the real module.
 * Enumerations are consumed as plain numbers.
 */
export interface CesiumLike {
  /**
   * Builds the globe widget. A factory rather than a constructor because the real
   * implementation is `CesiumWidget` from @cesium/engine, whose option names are its
   * own; the adapter maps ViewerOptionsLike onto them.
   */
  createViewer(container: Element, options: ViewerOptionsLike): ViewerLike;
  Cartesian2: new (x: number, y: number) => Cartesian2Like;
  Cartesian3: {
    readonly UNIT_Z: Cartesian3Like;
    clone(cartesian: Cartesian3Like): Cartesian3Like;
    distance(left: Cartesian3Like, right: Cartesian3Like): number;
    fromDegrees(longitude: number, latitude: number, height?: number): Cartesian3Like;
    fromDegreesArray(coordinates: number[]): Cartesian3Like[];
    fromDegreesArrayHeights(coordinates: number[]): Cartesian3Like[];
  };
  Cartographic: { fromCartesian(cartesian: Cartesian3Like): CartographicLike | undefined };
  Rectangle: { fromDegrees(west: number, south: number, east: number, north: number): RectangleLike };
  Color: new (red: number, green: number, blue: number, alpha: number) => ColorLike;
  Credit: new (html: string, showOnScreen?: boolean) => CreditLike;
  NearFarScalar: new (near: number, nearValue: number, far: number, farValue: number) => NearFarScalarLike;
  Math: { toRadians(degrees: number): number; toDegrees(radians: number): number };
  HeadingPitchRange: new (heading: number, pitch: number, range: number) => HeadingPitchRangeLike;
  /** `new BoundingSphere(center, radius)`: a factory, since the constructor takes a Cesium Cartesian3. */
  createBoundingSphere(center: Cartesian3Like, radius: number): BoundingSphereLike;
  Matrix4: {
    readonly IDENTITY: Matrix4Like;
    /** Sixteen column-major values into `result` (a model's own matrix, rewritten in place). */
    fromArray(array: number[], startingIndex?: number, result?: Matrix4Like): Matrix4Like;
  };
  /**
   * `Model.fromGltfAsync` with WORLDVIEW's axis convention: glTF +Y up, and *no* +Z-forward
   * correction, so the file's own axes arrive unturned in the model frame (x, −z, y) and the
   * transform layers/models.ts computes decides the heading. Shadows off.
   */
  loadModel(options: ModelOptionsLike): Promise<ModelLike>;
  /** `new PrimitiveCollection()`. */
  createPrimitiveCollection(): PrimitiveGroupLike;
  /** Which side of `scene.splitPosition` a layer is drawn on. */
  SplitDirection: { LEFT: number; NONE: number; RIGHT: number };
  JulianDate: { fromDate(date: Date): JulianDateLike };
  PostProcessStage: new (options: PostProcessStageOptionsLike) => PostProcessStageLike;
  buildModuleUrl(relativeUrl: string): string;
  ImageryLayer: { fromProviderAsync(provider: Promise<ImageryProviderLike>): ImageryLayerLike };
  TileMapServiceImageryProvider: {
    fromUrl(
      url: string,
      options?: { credit?: string; fileExtension?: string; maximumLevel?: number },
    ): Promise<ImageryProviderLike>;
  };
  UrlTemplateImageryProvider: new (options: {
    url: string;
    credit?: string;
    maximumLevel?: number;
    minimumLevel?: number;
    tileWidth?: number;
    tileHeight?: number;
    subdomains?: string[];
    hasAlphaChannel?: boolean;
  }) => ImageryProviderLike;
  ArcGisMapServerImageryProvider: {
    fromUrl(url: string, options?: { credit?: string; enablePickFeatures?: boolean }): Promise<ImageryProviderLike>;
  };
  /** WMS GetMap tiles (raster overlays, ADR-008). A factory: the engine's option types are wider than this surface. */
  createWmsImageryProvider(options: {
    url: string;
    layers: string;
    parameters?: Record<string, string>;
    credit?: string;
    minimumLevel?: number;
    maximumLevel?: number;
    tileWidth?: number;
    tileHeight?: number;
    rectangle?: RectangleLike;
    enablePickFeatures?: boolean;
  }): ImageryProviderLike;
  /** WMTS tiles, RESTful (`{TileMatrix}` … in the url) or KVP (raster overlays, ADR-008). */
  createWmtsImageryProvider(options: {
    url: string;
    layer: string;
    style: string;
    format?: string;
    tileMatrixSetID: string;
    tileMatrixLabels?: string[];
    credit?: string;
    minimumLevel?: number;
    maximumLevel?: number;
    tileWidth?: number;
    tileHeight?: number;
    rectangle?: RectangleLike;
  }): ImageryProviderLike;
  OpenStreetMapImageryProvider: new (options: {
    url?: string;
    credit?: string;
    maximumLevel?: number;
  }) => ImageryProviderLike;
  IonImageryProvider: {
    fromAssetId(assetId: number, options?: { accessToken?: string }): Promise<ImageryProviderLike>;
  };
  IonWorldImageryStyle: { AERIAL: number; AERIAL_WITH_LABELS: number; ROAD: number };
  IonResource: { fromAssetId(assetId: number, options?: { accessToken?: string }): Promise<ResourceLike> };
  EllipsoidTerrainProvider: new () => TerrainProviderLike;
  /** `CesiumTerrainProvider.fromUrl` for a URL string or an ion resource. */
  createTerrainFromUrl(
    url: string | ResourceLike,
    options?: { requestVertexNormals?: boolean; requestWaterMask?: boolean },
  ): Promise<TerrainProviderLike>;
  createGooglePhotorealistic3DTileset(options?: {
    key?: string;
    onlyUsingWithGoogleGeocoder?: true;
  }): Promise<TilesetLike>;
  PointPrimitiveCollection: new () => PointCollectionLike;
  PolylineCollection: new () => PolylineCollectionLike;
  /** `new BillboardCollection({ scene })` — the scene enables height references / depth against the globe. */
  createBillboardCollection(scene: SceneLike): BillboardCollectionLike;
  createLabelCollection(scene: SceneLike): LabelCollectionLike;
  /**
   * A transparent imagery layer whose tiles are drawn on demand: 256-px tiles in the
   * geographic tiling scheme, `draw` filling each one; a tile it reports empty (returns
   * false) is discarded rather than uploaded. Used for the reference borders.
   */
  createCanvasImageryLayer(options: {
    maximumLevel: number;
    draw(ctx: CanvasRenderingContext2D, x: number, y: number, level: number): boolean;
  }): ImageryLayerLike;
  Material: { fromType(type: string, uniforms?: Record<string, unknown>): MaterialLike };
  /** `GroundPrimitive.isSupported(scene)`. */
  groundPrimitivesSupported(scene: SceneLike): boolean;
  /** One GroundPrimitive of colour-attributed RectangleGeometry instances (PerInstanceColorAppearance, flat, translucent). */
  createGroundRectangles(cells: GroundRectangleCell[]): GroundPrimitiveLike;
  CustomDataSource: new (name?: string) => DataSourceLike;
  createPolygonHierarchy(positions: Cartesian3Like[], holes?: PolygonHierarchyLike[]): PolygonHierarchyLike;
  ScreenSpaceEventHandler: new (canvas: HTMLCanvasElement) => ScreenSpaceEventHandlerLike;
  ScreenSpaceEventType: {
    LEFT_CLICK: number;
    MOUSE_MOVE: number;
    LEFT_DOWN: number;
    RIGHT_DOWN: number;
    MIDDLE_DOWN: number;
    WHEEL: number;
    PINCH_START: number;
  };
  CameraEventType: { WHEEL: number };
  KeyboardEventModifier: { CTRL: number };
  HeightReference: { NONE: number; CLAMP_TO_GROUND: number; RELATIVE_TO_GROUND: number };
  VerticalOrigin: { CENTER: number; BOTTOM: number; TOP: number };
  HorizontalOrigin: { CENTER: number; LEFT: number };
  LabelStyle: { FILL_AND_OUTLINE: number };
  ClassificationType: { TERRAIN: number; BOTH: number };
  SceneTransforms: { worldToWindowCoordinates(scene: SceneLike, position: Cartesian3Like): Cartesian2Like | undefined };
}
