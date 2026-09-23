import type {
  BillboardCollectionLike,
  BillboardLike,
  BillboardOptions,
  Cartesian2Like,
  Cartesian3Like,
  CartographicLike,
  CesiumLike,
  ColorLike,
  CreditLike,
  DataSourceLike,
  EntityLike,
  EntityOptions,
  EventLike,
  GroundPrimitiveLike,
  ImageryLayerLike,
  ImageryProviderLike,
  LabelCollectionLike,
  LabelLike,
  LabelOptions,
  MaterialLike,
  PointCollectionLike,
  PointPrimitiveLike,
  PointPrimitiveOptions,
  PolylineCollectionLike,
  PolylineLike,
  PolylineOptions,
  PrimitiveCollectionLike,
  RectangleLike,
  SceneLike,
  ScreenSpaceEventHandlerLike,
  TerrainProviderLike,
  TilesetLike,
  ViewerLike,
  ViewerOptionsLike,
} from '../cesium-like.js';

/**
 * A fake `CesiumLike` module for Node tests: plain objects that record what the
 * adapter does (collections, entities, camera, credits, picks). No WebGL, no
 * DOM. Geometry is kept in degrees so assertions read naturally.
 */
const DEG = Math.PI / 180;

export class FakeEvent<T = void> implements EventLike<T> {
  readonly listeners = new Set<(arg: T) => void>();
  addEventListener(listener: (arg: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  removeEventListener(listener: (arg: T) => void): boolean {
    return this.listeners.delete(listener);
  }
  raise(arg: T): void {
    for (const l of [...this.listeners]) l(arg);
  }
  get size(): number {
    return this.listeners.size;
  }
}

class FakeCollection<Item extends { id: unknown; show: boolean }, Opts> {
  show = true;
  readonly items: Item[] = [];
  private destroyed = false;
  constructor(private readonly make: (o: Opts) => Item) {}
  get length(): number {
    return this.items.length;
  }
  add(options?: Opts): Item {
    const it = this.make((options ?? {}) as Opts);
    this.items.push(it);
    return it;
  }
  remove(item: Item): boolean {
    const i = this.items.indexOf(item);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
  removeAll(): void {
    this.items.length = 0;
  }
  destroy(): void {
    this.destroyed = true;
    this.items.length = 0;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  byId(id: unknown): Item | undefined {
    return this.items.find((i) => i.id === id);
  }
}

const color = (r: number, g: number, b: number, a: number): ColorLike => ({ red: r, green: g, blue: b, alpha: a });

export function fakeImageryProvider(
  name: string,
): ImageryProviderLike & { name: string; errorEvent: FakeEvent<{ timesRetried?: number }>; destroyed: boolean } {
  const p = {
    name,
    errorEvent: new FakeEvent<{ timesRetried?: number }>(),
    destroyed: false,
    destroy() {
      p.destroyed = true;
    },
    isDestroyed() {
      return p.destroyed;
    },
  };
  return p;
}

export function fakeTerrainProvider(name: string): TerrainProviderLike & { name: string } {
  return { name, hasWaterMask: false, hasVertexNormals: false };
}

export class FakePrimitiveCollection implements PrimitiveCollectionLike {
  readonly items: unknown[] = [];
  add<T>(primitive: T): T {
    this.items.push(primitive);
    return primitive;
  }
  remove(primitive: unknown): boolean {
    const i = this.items.indexOf(primitive);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
  removeAll(): void {
    this.items.length = 0;
  }
  contains(primitive: unknown): boolean {
    return this.items.includes(primitive);
  }
  get length(): number {
    return this.items.length;
  }
}

export class FakeCamera {
  longitude = 0;
  latitude = 20 * DEG;
  height = 20_000_000;
  heading = 0;
  pitch = -Math.PI / 2;
  roll = 0;
  percentageChanged = 0.5;
  readonly changed = new FakeEvent<number>();
  readonly moveEnd = new FakeEvent<void>();
  readonly moveStart = new FakeEvent<void>();
  readonly flights: Array<{ destination: Cartesian3Like | RectangleLike; duration?: number }> = [];
  rectangle: RectangleLike | undefined;
  get positionCartographic(): CartographicLike {
    return { longitude: this.longitude, latitude: this.latitude, height: this.height };
  }
  get positionWC(): Cartesian3Like {
    return toCartesian(this.longitude / DEG, this.latitude / DEG, this.height);
  }
  setView(options: {
    destination?: Cartesian3Like | RectangleLike;
    orientation?: { heading?: number; pitch?: number; roll?: number };
  }): void {
    if (options.destination && 'x' in options.destination) {
      const c = fromCartesian(options.destination);
      this.longitude = c.longitude;
      this.latitude = c.latitude;
      this.height = c.height;
    }
    if (options.orientation) {
      this.heading = options.orientation.heading ?? this.heading;
      this.pitch = options.orientation.pitch ?? this.pitch;
      this.roll = options.orientation.roll ?? this.roll;
    }
    this.changed.raise(1);
  }
  flyTo(options: {
    destination: Cartesian3Like | RectangleLike;
    orientation?: { heading?: number; pitch?: number; roll?: number };
    duration?: number;
    complete?: () => void;
  }): void {
    this.flights.push({
      destination: options.destination,
      ...(options.duration !== undefined ? { duration: options.duration } : {}),
    });
    this.setView(options);
    this.moveEnd.raise();
    options.complete?.();
  }
  cancelFlight(): void {
    /* nothing in flight */
  }
  computeViewRectangle(): RectangleLike | undefined {
    return this.rectangle;
  }
  pickEllipsoid(_windowPosition: Cartesian2Like): Cartesian3Like | undefined {
    return toCartesian(this.longitude / DEG, this.latitude / DEG, 0);
  }
}

/** Degrees → a fake Cartesian that simply stores lon/lat/height (x=lon, y=lat, z=height). */
export function toCartesian(lon: number, lat: number, height = 0): Cartesian3Like {
  return { x: lon, y: lat, z: height };
}
export function fromCartesian(c: Cartesian3Like): CartographicLike {
  return { longitude: c.x * DEG, latitude: c.y * DEG, height: c.z };
}

export class FakeScene implements SceneLike {
  readonly canvas = {
    width: 1024,
    height: 768,
    clientWidth: 1024,
    clientHeight: 768,
    toBlob: (cb: (b: null) => void) => cb(null),
  } as unknown as HTMLCanvasElement;
  readonly camera = new FakeCamera();
  globe = {
    show: true,
    depthTestAgainstTerrain: false,
    baseColor: color(0, 0, 0, 1),
    enableLighting: false,
    showGroundAtmosphere: false,
    tileCacheSize: 100,
    preloadSiblings: false,
  };
  skyAtmosphere = { show: false, atmosphereLightIntensity: 0, saturationShift: 0, brightnessShift: 0 };
  backgroundColor = color(0, 0, 0, 1);
  readonly primitives = new FakePrimitiveCollection();
  readonly groundPrimitives = new FakePrimitiveCollection();
  terrainProvider: TerrainProviderLike = fakeTerrainProvider('initial');
  readonly screenSpaceCameraController = {
    zoomEventTypes: undefined as SceneLike['screenSpaceCameraController']['zoomEventTypes'],
    enableCollisionDetection: false,
    minimumZoomDistance: 1,
    maximumZoomDistance: Number.POSITIVE_INFINITY,
  };
  requestRenderMode = false;
  pickPositionSupported = false;
  readonly postRender = new FakeEvent<unknown>();
  readonly preRender = new FakeEvent<unknown>();
  readonly preUpdate = new FakeEvent<unknown>();
  renderRequests = 0;
  /** Test hook: what `pick()` returns at any position. */
  pickResult: unknown = undefined;
  groundPrimitiveSupport = true;
  requestRender(): void {
    this.renderRequests++;
  }
  pick(): { id?: unknown; primitive?: unknown } | undefined {
    return this.pickResult as { id?: unknown } | undefined;
  }
  pickPosition(): Cartesian3Like | undefined {
    return undefined;
  }
}

export class FakeViewer implements ViewerLike {
  readonly scene = new FakeScene();
  readonly camera: FakeCamera;
  readonly canvas: HTMLCanvasElement;
  readonly imageryLayers = {
    layers: [] as ImageryLayerLike[],
    get length() {
      return this.layers.length;
    },
    add(l: ImageryLayerLike, index?: number) {
      if (index === 0) this.layers.unshift(l);
      else this.layers.push(l);
    },
    remove(l: ImageryLayerLike, destroy?: boolean) {
      const i = this.layers.indexOf(l);
      if (i < 0) return false;
      this.layers.splice(i, 1);
      if (destroy) l.destroy();
      return true;
    },
    removeAll() {
      this.layers.length = 0;
    },
  };
  readonly dataSources = {
    sources: [] as DataSourceLike[],
    add: (ds: DataSourceLike | Promise<DataSourceLike>): Promise<DataSourceLike> => {
      if (ds instanceof Promise)
        return ds.then((d) => {
          this.dataSources.sources.push(d);
          return d;
        });
      this.dataSources.sources.push(ds);
      return Promise.resolve(ds);
    },
    remove: (ds: DataSourceLike) => {
      const i = this.dataSources.sources.indexOf(ds);
      if (i < 0) return false;
      this.dataSources.sources.splice(i, 1);
      return true;
    },
  };
  readonly creditDisplay = {
    credits: new Set<CreditLike>(),
    addStaticCredit(c: CreditLike) {
      this.credits.add(c);
    },
    removeStaticCredit(c: CreditLike) {
      this.credits.delete(c);
    },
  };
  targetFrameRate = 0;
  useDefaultRenderLoop = true;
  resolutionScale = 1;
  useBrowserRecommendedResolution = true;
  renders = 0;
  private destroyed = false;
  constructor(
    readonly container: Element,
    readonly options: ViewerOptionsLike | undefined,
  ) {
    this.camera = this.scene.camera;
    this.canvas = this.scene.canvas;
  }
  render(): void {
    this.renders++;
  }
  resize(): void {
    /* noop */
  }
  destroy(): void {
    this.destroyed = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

export class FakeScreenSpaceEventHandler implements ScreenSpaceEventHandlerLike {
  readonly actions = new Map<number, (event: { position?: Cartesian2Like; endPosition?: Cartesian2Like }) => void>();
  destroyed = false;
  constructor(readonly canvas: HTMLCanvasElement) {}
  setInputAction(
    action: (event: { position?: Cartesian2Like; endPosition?: Cartesian2Like }) => void,
    type: number,
  ): void {
    this.actions.set(type, action);
  }
  removeInputAction(type: number): void {
    this.actions.delete(type);
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** Test hook. */
  fire(type: number, event: { position?: Cartesian2Like; endPosition?: Cartesian2Like }): void {
    this.actions.get(type)?.(event);
  }
}

class FakeEntityCollection {
  readonly entities: Array<EntityLike & { options: EntityOptions }> = [];
  suspended = 0;
  add(options: EntityOptions): EntityLike & { options: EntityOptions } {
    const e = { id: options.id ?? `e${this.entities.length}`, show: options.show ?? true, options };
    this.entities.push(e);
    return e;
  }
  remove(entity: EntityLike): boolean {
    const i = this.entities.findIndex((e) => e === entity);
    if (i < 0) return false;
    this.entities.splice(i, 1);
    return true;
  }
  removeById(id: string): boolean {
    const i = this.entities.findIndex((e) => e.id === id);
    if (i < 0) return false;
    this.entities.splice(i, 1);
    return true;
  }
  removeAll(): void {
    this.entities.length = 0;
  }
  getById(id: string): EntityLike | undefined {
    return this.entities.find((e) => e.id === id);
  }
  suspendEvents(): void {
    this.suspended++;
  }
  resumeEvents(): void {
    this.suspended--;
  }
}

export class FakeDataSource implements DataSourceLike {
  show = true;
  readonly entities = new FakeEntityCollection();
  constructor(public name = '') {}
}

export interface FakeCesiumOptions {
  /** Provider factories per stack, keyed by the URL/asset they are asked for. */
  naturalEarth?: () => Promise<ImageryProviderLike>;
  /** Esri World Imagery is a synchronous tile template now, so its hook is synchronous too. */
  esri?: () => ImageryProviderLike;
  osm?: () => ImageryProviderLike;
  ion?: (assetId: number, token?: string) => Promise<ImageryProviderLike>;
  google?: (key?: string) => Promise<TilesetLike>;
  terrainFromUrl?: (url: string) => Promise<TerrainProviderLike>;
  groundPrimitivesSupported?: boolean;
}

export interface FakeCesium extends CesiumLike {
  viewers: FakeViewer[];
  handlers: FakeScreenSpaceEventHandler[];
  groundPrimitives: Array<GroundPrimitiveLike & { cells: unknown[] }>;
  credits: Array<CreditLike>;
  /** Canvas imagery layers created, with the draw callback so a test can render a tile. */
  canvasLayers: Array<
    ImageryLayerLike & {
      maximumLevel: number;
      draw(ctx: CanvasRenderingContext2D, x: number, y: number, level: number): boolean;
    }
  >;
}

export function createFakeCesium(opts: FakeCesiumOptions = {}): FakeCesium {
  const viewers: FakeViewer[] = [];
  const handlers: FakeScreenSpaceEventHandler[] = [];
  const groundPrimitives: Array<GroundPrimitiveLike & { cells: unknown[] }> = [];
  const credits: CreditLike[] = [];
  const canvasLayers: FakeCesium['canvasLayers'] = [];
  const point = (o: PointPrimitiveOptions): PointPrimitiveLike => ({
    show: o.show ?? true,
    position: o.position ?? toCartesian(0, 0),
    pixelSize: o.pixelSize ?? 1,
    color: o.color ?? color(1, 1, 1, 1),
    outlineColor: o.outlineColor ?? color(0, 0, 0, 1),
    outlineWidth: o.outlineWidth ?? 0,
    id: o.id,
    disableDepthTestDistance: o.disableDepthTestDistance ?? 0,
  });
  const billboard = (o: BillboardOptions): BillboardLike => ({
    show: o.show ?? true,
    position: o.position ?? toCartesian(0, 0),
    image: o.image,
    scale: o.scale ?? 1,
    rotation: o.rotation ?? 0,
    color: o.color ?? color(1, 1, 1, 1),
    id: o.id,
    width: o.width,
    height: o.height,
    heightReference: o.heightReference ?? 0,
    disableDepthTestDistance: o.disableDepthTestDistance ?? 0,
  });
  const label = (o: LabelOptions): LabelLike => ({
    show: o.show ?? true,
    position: o.position ?? toCartesian(0, 0),
    text: o.text ?? '',
    font: o.font ?? '',
    fillColor: o.fillColor ?? color(1, 1, 1, 1),
    outlineColor: o.outlineColor ?? color(0, 0, 0, 1),
    outlineWidth: o.outlineWidth ?? 0,
    pixelOffset: o.pixelOffset ?? { x: 0, y: 0 },
    id: o.id,
    heightReference: o.heightReference ?? 0,
    disableDepthTestDistance: o.disableDepthTestDistance ?? 0,
  });
  const polyline = (o: PolylineOptions): PolylineLike => ({
    show: o.show ?? true,
    positions: o.positions ?? [],
    width: o.width ?? 1,
    material: o.material ?? { type: 'Color', uniforms: {} },
    id: o.id,
  });
  const fake: FakeCesium = {
    viewers,
    handlers,
    groundPrimitives,
    canvasLayers,
    createCanvasImageryLayer: ({ maximumLevel, draw }) => {
      let destroyed = false;
      const layer = {
        show: true,
        alpha: 1,
        maximumLevel,
        draw,
        destroy() {
          destroyed = true;
        },
        isDestroyed() {
          return destroyed;
        },
      };
      canvasLayers.push(layer);
      return layer;
    },
    credits,
    createViewer: (container: Element, options: ViewerOptionsLike) => {
      const v = new FakeViewer(container, options);
      viewers.push(v);
      return v;
    },
    Cartesian2: class {
      constructor(
        public x: number,
        public y: number,
      ) {}
    },
    Cartesian3: {
      UNIT_Z: { x: 0, y: 0, z: 1 },
      fromDegrees: (lon, lat, height = 0) => toCartesian(lon, lat, height),
      fromDegreesArray: (c) => {
        const out: Cartesian3Like[] = [];
        for (let i = 0; i < c.length; i += 2) out.push(toCartesian(c[i]!, c[i + 1]!));
        return out;
      },
      fromDegreesArrayHeights: (c) => {
        const out: Cartesian3Like[] = [];
        for (let i = 0; i < c.length; i += 3) out.push(toCartesian(c[i]!, c[i + 1]!, c[i + 2]!));
        return out;
      },
    },
    Cartographic: { fromCartesian: (c) => fromCartesian(c) },
    Rectangle: { fromDegrees: (w, s, e, n) => ({ west: w * DEG, south: s * DEG, east: e * DEG, north: n * DEG }) },
    Color: class {
      constructor(
        public red: number,
        public green: number,
        public blue: number,
        public alpha: number,
      ) {}
    },
    Credit: class {
      constructor(
        public html: string,
        public showOnScreen = false,
      ) {
        credits.push(this);
      }
    },
    NearFarScalar: class {
      constructor(
        public near: number,
        public nearValue: number,
        public far: number,
        public farValue: number,
      ) {}
    },
    Math: { toRadians: (d) => d * DEG, toDegrees: (r) => r / DEG },
    buildModuleUrl: (rel) => `cesium://${rel}`,
    ImageryLayer: {
      fromProviderAsync: (promise) => {
        const layer = {
          show: true,
          alpha: 1,
          destroyed: false,
          provider: undefined as ImageryProviderLike | undefined,
          destroy() {
            layer.destroyed = true;
          },
          isDestroyed() {
            return layer.destroyed;
          },
        };
        void promise.then((p) => {
          layer.provider = p;
        });
        return layer;
      },
    },
    TileMapServiceImageryProvider: {
      fromUrl: async () => (opts.naturalEarth ? opts.naturalEarth() : fakeImageryProvider('natural-earth')),
    },
    UrlTemplateImageryProvider: class {
      name: string;
      errorEvent = new FakeEvent<{ timesRetried?: number }>();
      maximumLevel: number | undefined;
      url: string;
      constructor(o: { url: string; maximumLevel?: number }) {
        this.url = o.url;
        this.maximumLevel = o.maximumLevel;
        this.name = o.url.includes('World_Imagery') ? 'esri' : `xyz:${o.url}`;
        // Esri World Imagery is addressed as a tile template now rather than through
        // ArcGisMapServerImageryProvider, so the fake recognises it by URL to keep
        // honouring the `esri` injection hook.
        if (opts.esri && o.url.includes('World_Imagery')) return opts.esri() as this;
      }
    },
    ArcGisMapServerImageryProvider: { fromUrl: async () => (opts.esri ? opts.esri() : fakeImageryProvider('esri')) },
    OpenStreetMapImageryProvider: class {
      name = 'osm';
      errorEvent = new FakeEvent<{ timesRetried?: number }>();
      constructor() {
        if (opts.osm) return opts.osm() as this;
      }
    },
    IonImageryProvider: {
      fromAssetId: async (assetId, o) =>
        opts.ion ? opts.ion(assetId, o?.accessToken) : fakeImageryProvider(`ion:${assetId}`),
    },
    IonWorldImageryStyle: { AERIAL: 2, AERIAL_WITH_LABELS: 3, ROAD: 4 },
    IonResource: { fromAssetId: async (assetId, o) => ({ url: `ion://${assetId}?token=${o?.accessToken ?? ''}` }) },
    EllipsoidTerrainProvider: class {
      hasWaterMask = false;
      hasVertexNormals = false;
      name = 'ellipsoid';
    },
    createTerrainFromUrl: async (url) =>
      opts.terrainFromUrl
        ? opts.terrainFromUrl(typeof url === 'string' ? url : url.url)
        : fakeTerrainProvider(typeof url === 'string' ? url : url.url),
    createGooglePhotorealistic3DTileset: async (o) => {
      if (opts.google) return opts.google(o?.key);
      const t = {
        show: true,
        key: o?.key,
        destroyed: false,
        destroy() {
          t.destroyed = true;
        },
        isDestroyed() {
          return t.destroyed;
        },
      };
      return t;
    },
    PointPrimitiveCollection: class
      extends FakeCollection<PointPrimitiveLike, PointPrimitiveOptions>
      implements PointCollectionLike
    {
      constructor() {
        super(point);
      }
    },
    PolylineCollection: class extends FakeCollection<PolylineLike, PolylineOptions> implements PolylineCollectionLike {
      constructor() {
        super(polyline);
      }
    },
    createBillboardCollection: () =>
      new (class extends FakeCollection<BillboardLike, BillboardOptions> implements BillboardCollectionLike {
        constructor() {
          super(billboard);
        }
      })(),
    createLabelCollection: () =>
      new (class extends FakeCollection<LabelLike, LabelOptions> implements LabelCollectionLike {
        constructor() {
          super(label);
        }
      })(),
    Material: { fromType: (type, uniforms = {}): MaterialLike => ({ type, uniforms }) },
    groundPrimitivesSupported: () => opts.groundPrimitivesSupported ?? true,
    createGroundRectangles: (cells) => {
      const gp = {
        show: true,
        cells: [...cells],
        destroyed: false,
        destroy() {
          gp.destroyed = true;
        },
        isDestroyed() {
          return gp.destroyed;
        },
      };
      groundPrimitives.push(gp);
      return gp;
    },
    CustomDataSource: FakeDataSource,
    createPolygonHierarchy: (positions, holes = []) => ({ positions, holes }),
    ScreenSpaceEventHandler: class extends FakeScreenSpaceEventHandler {
      constructor(canvas: HTMLCanvasElement) {
        super(canvas);
        handlers.push(this);
      }
    },
    ScreenSpaceEventType: { LEFT_CLICK: 2, MOUSE_MOVE: 15 },
    CameraEventType: { WHEEL: 3 },
    KeyboardEventModifier: { CTRL: 1 },
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
    VerticalOrigin: { CENTER: 0, BOTTOM: 1, TOP: -1 },
    HorizontalOrigin: { CENTER: 0, LEFT: 1 },
    LabelStyle: { FILL_AND_OUTLINE: 2 },
    ClassificationType: { TERRAIN: 0, BOTH: 2 },
    SceneTransforms: {
      worldToWindowCoordinates: (scene, position) => {
        const cam = (scene as FakeScene).camera;
        const dx = position.x - cam.longitude / DEG,
          dy = position.y - cam.latitude / DEG;
        return { x: 512 + dx * 10, y: 384 - dy * 10 };
      },
    },
  };
  return fake;
}

/** Fake canvas factory for sprite generation (records nothing, yields a deterministic data URL per size). */
export function fakeCanvasFactory() {
  return (width: number, height: number) => {
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) =>
        typeof prop === 'string' && /^(fillStyle|strokeStyle|lineWidth|lineJoin|lineCap|globalAlpha)$/.test(prop)
          ? ''
          : () => undefined,
      set: () => true,
    });
    return {
      width,
      height,
      getContext: () => ctx as unknown as import('@worldview/render-core').GlyphContext,
      toDataURL: () => `data:image/png;base64,${width}x${height}`,
    };
  };
}
