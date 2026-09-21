/**
 * The slice of the CesiumJS module this adapter uses, as structural interfaces.
 * Every Cesium call site takes a `CesiumLike` (or one of the narrower *Like
 * interfaces) so the adapter can be exercised in Node with a fake module and the
 * real module is adapted (and type-checked) in `cesium-module.ts`.
 *
 * Method-style members are used deliberately: TypeScript compares them
 * bivariantly, which lets Cesium's richer signatures satisfy these subsets.
 */
export interface Cartesian2Like { x: number; y: number }
export interface Cartesian3Like { x: number; y: number; z: number }
export interface CartographicLike { longitude: number; latitude: number; height: number }
export interface RectangleLike { west: number; south: number; east: number; north: number }
export interface ColorLike { red: number; green: number; blue: number; alpha: number }
export interface BoundingRectangleLike { x: number; y: number; width: number; height: number }
export interface NearFarScalarLike { near: number; nearValue: number; far: number; farValue: number }

export interface EventLike<T = void> {
  addEventListener(listener: (arg: T) => void): () => void;
  removeEventListener(listener: (arg: T) => void): boolean;
}

export interface CreditLike { readonly html: string; readonly showOnScreen: boolean }
export interface CreditDisplayLike {
  addStaticCredit(credit: CreditLike): void;
  removeStaticCredit(credit: CreditLike): void;
}

export interface TileProviderErrorLike { timesRetried?: number; message?: string }
export interface ImageryProviderLike {
  readonly errorEvent?: EventLike<TileProviderErrorLike>;
  destroy?(): void;
  isDestroyed?(): boolean;
}
export interface ImageryLayerLike {
  show: boolean;
  alpha: number;
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

export interface PointPrimitiveLike {
  show: boolean;
  position: Cartesian3Like;
  pixelSize: number;
  color: ColorLike;
  outlineColor: ColorLike;
  outlineWidth: number;
  id: unknown;
  disableDepthTestDistance: number;
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
  disableDepthTestDistance: number;
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
  disableDepthTestDistance: number;
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

export interface MaterialLike { readonly type: string; uniforms: Record<string, unknown> }
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
export interface GroundRectangleCell { id: string; rectangle: RectangleLike; color: ColorLike }
export interface GroundPrimitiveLike {
  show: boolean;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface PolygonHierarchyLike { positions: Cartesian3Like[]; holes: PolygonHierarchyLike[] }
/** Cesium wraps entity values in `Property` objects; inputs accept either the raw value or a property. */
export interface PropertyLike { getValue?(time?: unknown, result?: unknown): unknown }
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
export interface EntityLike { readonly id: string; show: boolean }
export interface EntityCollectionLike {
  add(entity: EntityOptions): EntityLike;
  remove(entity: EntityLike): boolean;
  removeById(id: string): boolean;
  removeAll(): void;
  getById(id: string): EntityLike | undefined;
  suspendEvents(): void;
  resumeEvents(): void;
}
export interface DataSourceLike { name: string; show: boolean; readonly entities: EntityCollectionLike }
export interface DataSourceCollectionLike {
  add(dataSource: DataSourceLike | Promise<DataSourceLike>): Promise<DataSourceLike>;
  remove(dataSource: DataSourceLike, destroy?: boolean): boolean;
}

/** Heading/pitch/roll in radians, or Cesium's direction/up form. */
export interface CameraOrientationLike { heading?: number; pitch?: number; roll?: number; direction?: Cartesian3Like; up?: Cartesian3Like }
export interface CameraLike {
  readonly positionCartographic: CartographicLike;
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
  percentageChanged: number;
  readonly changed: EventLike<number>;
  readonly moveEnd: EventLike<void>;
  readonly moveStart: EventLike<void>;
  setView(options: { destination?: Cartesian3Like | RectangleLike; orientation?: CameraOrientationLike }): void;
  flyTo(options: { destination: Cartesian3Like | RectangleLike; orientation?: CameraOrientationLike; duration?: number; complete?: () => void; cancel?: () => void }): void;
  cancelFlight(): void;
  computeViewRectangle(): RectangleLike | undefined;
  pickEllipsoid(windowPosition: Cartesian2Like): Cartesian3Like | undefined;
}

export interface GlobeLike { show: boolean; depthTestAgainstTerrain: boolean; baseColor: ColorLike; enableLighting: boolean; showGroundAtmosphere: boolean }
export interface SkyAtmosphereLike { show: boolean; atmosphereLightIntensity: number; saturationShift: number; brightnessShift: number }
export interface CameraEventBindingLike { eventType: number; modifier: number }
export interface ScreenSpaceCameraControllerLike {
  zoomEventTypes: number | CameraEventBindingLike | Array<number | CameraEventBindingLike> | undefined;
  enableCollisionDetection: boolean;
  minimumZoomDistance: number;
}
export interface PickedLike { id?: unknown; primitive?: unknown }
export interface SceneLike {
  readonly canvas: HTMLCanvasElement;
  readonly camera: CameraLike;
  globe: GlobeLike;
  skyAtmosphere: SkyAtmosphereLike;
  backgroundColor: ColorLike;
  readonly primitives: PrimitiveCollectionLike;
  readonly groundPrimitives: PrimitiveCollectionLike;
  terrainProvider: TerrainProviderLike;
  readonly screenSpaceCameraController: ScreenSpaceCameraControllerLike;
  requestRenderMode: boolean;
  readonly pickPositionSupported: boolean;
  readonly postRender: EventLike<unknown>;
  requestRender(): void;
  pick(windowPosition: Cartesian2Like, width?: number, height?: number): PickedLike | undefined;
  pickPosition(windowPosition: Cartesian2Like): Cartesian3Like | undefined;
}

export interface ScreenSpaceEventHandlerLike {
  setInputAction(action: (event: { position?: Cartesian2Like; endPosition?: Cartesian2Like }) => void, type: number, modifier?: number): void;
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
  targetFrameRate: number;
  useDefaultRenderLoop: boolean;
  resolutionScale: number;
  render(): void;
  resize(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface ViewerOptionsLike {
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
  baseLayer?: false;
  creditContainer?: Element;
  msaaSamples?: number;
  requestRenderMode?: boolean;
  contextOptions?: { webgl?: { preserveDrawingBuffer?: boolean; powerPreference?: 'default' | 'low-power' | 'high-performance' } };
}

/** Enumerations are consumed as plain numbers. */
export interface ResourceLike { readonly url: string }

/**
 * Module surface. Members that Cesium exposes as classes taking primitive inputs
 * are passed through as constructors; the few whose constructors take Cesium
 * class instances (Scene, Geometry, Resource) are exposed as factory methods,
 * because construct signatures are checked contravariantly and cannot be
 * satisfied by narrow interfaces. `cesium-module.ts` adapts the real module.
 * Enumerations are consumed as plain numbers.
 */
export interface CesiumLike {
  Viewer: new (container: Element, options?: ViewerOptionsLike) => ViewerLike;
  Cartesian2: new (x: number, y: number) => Cartesian2Like;
  Cartesian3: {
    readonly UNIT_Z: Cartesian3Like;
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
  buildModuleUrl(relativeUrl: string): string;
  ImageryLayer: { fromProviderAsync(provider: Promise<ImageryProviderLike>): ImageryLayerLike };
  TileMapServiceImageryProvider: { fromUrl(url: string, options?: { credit?: string; fileExtension?: string; maximumLevel?: number }): Promise<ImageryProviderLike> };
  UrlTemplateImageryProvider: new (options: { url: string; credit?: string; maximumLevel?: number; minimumLevel?: number; tileWidth?: number; tileHeight?: number; subdomains?: string[]; hasAlphaChannel?: boolean }) => ImageryProviderLike;
  ArcGisMapServerImageryProvider: { fromUrl(url: string, options?: { credit?: string; enablePickFeatures?: boolean }): Promise<ImageryProviderLike> };
  OpenStreetMapImageryProvider: new (options?: { url?: string; credit?: string; maximumLevel?: number }) => ImageryProviderLike;
  IonImageryProvider: { fromAssetId(assetId: number, options?: { accessToken?: string }): Promise<ImageryProviderLike> };
  IonWorldImageryStyle: { AERIAL: number; AERIAL_WITH_LABELS: number; ROAD: number };
  IonResource: { fromAssetId(assetId: number, options?: { accessToken?: string }): Promise<ResourceLike> };
  EllipsoidTerrainProvider: new () => TerrainProviderLike;
  /** `CesiumTerrainProvider.fromUrl` for a URL string or an ion resource. */
  createTerrainFromUrl(url: string | ResourceLike, options?: { requestVertexNormals?: boolean; requestWaterMask?: boolean }): Promise<TerrainProviderLike>;
  createGooglePhotorealistic3DTileset(options?: { key?: string; onlyUsingWithGoogleGeocoder?: boolean }): Promise<TilesetLike>;
  PointPrimitiveCollection: new () => PointCollectionLike;
  PolylineCollection: new () => PolylineCollectionLike;
  /** `new BillboardCollection({ scene })` — the scene enables height references / depth against the globe. */
  createBillboardCollection(scene: SceneLike): BillboardCollectionLike;
  createLabelCollection(scene: SceneLike): LabelCollectionLike;
  Material: { fromType(type: string, uniforms?: Record<string, unknown>): MaterialLike };
  /** `GroundPrimitive.isSupported(scene)`. */
  groundPrimitivesSupported(scene: SceneLike): boolean;
  /** One GroundPrimitive of colour-attributed RectangleGeometry instances (PerInstanceColorAppearance, flat, translucent). */
  createGroundRectangles(cells: GroundRectangleCell[]): GroundPrimitiveLike;
  CustomDataSource: new (name?: string) => DataSourceLike;
  createPolygonHierarchy(positions: Cartesian3Like[], holes?: PolygonHierarchyLike[]): PolygonHierarchyLike;
  ScreenSpaceEventHandler: new (canvas: HTMLCanvasElement) => ScreenSpaceEventHandlerLike;
  ScreenSpaceEventType: { LEFT_CLICK: number; MOUSE_MOVE: number };
  CameraEventType: { WHEEL: number };
  KeyboardEventModifier: { CTRL: number };
  HeightReference: { NONE: number; CLAMP_TO_GROUND: number; RELATIVE_TO_GROUND: number };
  VerticalOrigin: { CENTER: number; BOTTOM: number; TOP: number };
  HorizontalOrigin: { CENTER: number; LEFT: number };
  LabelStyle: { FILL_AND_OUTLINE: number };
  ClassificationType: { TERRAIN: number; BOTH: number };
  SceneTransforms: { worldToWindowCoordinates(scene: SceneLike, position: Cartesian3Like): Cartesian2Like | undefined };
}
