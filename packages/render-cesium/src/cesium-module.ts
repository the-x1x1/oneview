import type * as Cesium from '@cesium/engine';
import type {
  CesiumLike,
  ColorLike,
  ImageryProviderLike,
  RectangleLike,
  ResourceLike,
  SceneLike,
  Cartesian3Like,
  PolygonHierarchyLike,
  ViewerLike,
  ViewerOptionsLike,
} from './cesium-like.js';

/**
 * Adapts the real Cesium module to `CesiumLike`. This is the ONE file typed against
 * Cesium's own declarations (the declaration shim in tools/dev/type-shims/@cesium__engine
 * when the package is not installed), so the typecheck verifies that every member the
 * adapter relies on exists with a compatible signature.
 *
 * It imports **@cesium/engine, not cesium**, and that is a hard requirement rather than a
 * preference. The `cesium` package re-exports @cesium/engine *and* @cesium/widgets, and
 * @cesium/widgets bundles Knockout, whose first statement is `var t = this || (0, eval)("this")`
 * at module scope. Under WORLDVIEW's Content-Security-Policy (`script-src 'self'
 * 'wasm-unsafe-eval'`, see src/main/csp.ts) that throws EvalError the moment the chunk is
 * evaluated, before any WORLDVIEW code runs — the packaged application opened to a blank
 * window because of it. Importing the engine alone removes Knockout from the bundle
 * entirely, which is why the policy can stay strict.
 *
 * The only symbol the adapter ever took from widgets was `Viewer`. Everything it does
 * with a viewer — dataSources, imageryLayers, creditDisplay, camera, scene — is on
 * `CesiumWidget`, which lives in the engine, so `createViewer` builds one of those.
 * `cesium` remains an apps/desktop devDependency: its `Build/Cesium` directory is where
 * the Workers, Assets and ThirdParty wasm are staged from (scripts/cesium-assets.mjs).
 * Those are data, not modules, and nothing imports them as code.
 *
 * `own()` re-attaches Cesium's nominal class types to values that this same
 * module produced (a Rectangle from `Rectangle.fromDegrees`, a Color from
 * `new Color`, the Scene from the widget). The *Like interfaces drop Cesium's
 * instance methods on purpose so tests can substitute plain objects; handing the
 * values back to constructors that demand the class type is the only place the
 * narrowing is undone.
 */
export type CesiumModule = typeof Cesium;

function own<T>(value: unknown): T {
  return value as T;
}

/** CesiumWidget declares its options inline in its signature, with no exported alias to name. */
type WidgetOptions = NonNullable<ConstructorParameters<typeof Cesium.CesiumWidget>[1]>;

/**
 * Translate `ViewerOptionsLike` into CesiumWidget's own option names.
 *
 * Built key by key rather than as one object literal because the workspace compiles with
 * `exactOptionalPropertyTypes`: writing `baseLayer: options.baseLayer` would pass an
 * explicit `undefined` where Cesium's declaration says `false | ImageryLayer`, and the
 * two are not the same thing to the compiler even though they are at run time.
 */
function widgetOptions(options: ViewerOptionsLike): WidgetOptions {
  const out: WidgetOptions = {};
  if (options.baseLayer === false) out.baseLayer = false;
  if (options.creditContainer !== undefined) out.creditContainer = options.creditContainer;
  if (options.msaaSamples !== undefined) out.msaaSamples = options.msaaSamples;
  if (options.requestRenderMode !== undefined) out.requestRenderMode = options.requestRenderMode;
  if (options.contextOptions !== undefined) out.contextOptions = own<Cesium.ContextOptions>(options.contextOptions);
  return out;
}

export function adaptCesiumModule(C: CesiumModule): CesiumLike {
  return {
    createViewer: (container: Element, options: ViewerOptionsLike): ViewerLike =>
      new C.CesiumWidget(container, widgetOptions(options)),
    Cartesian2: C.Cartesian2,
    Cartesian3: C.Cartesian3,
    Cartographic: C.Cartographic,
    Rectangle: C.Rectangle,
    Color: C.Color,
    Credit: C.Credit,
    NearFarScalar: C.NearFarScalar,
    Math: C.Math,
    buildModuleUrl: C.buildModuleUrl,
    ImageryLayer: {
      fromProviderAsync: (provider: Promise<ImageryProviderLike>) =>
        C.ImageryLayer.fromProviderAsync(own<Promise<Cesium.ImageryProvider>>(provider)),
    },
    TileMapServiceImageryProvider: C.TileMapServiceImageryProvider,
    UrlTemplateImageryProvider: C.UrlTemplateImageryProvider,
    ArcGisMapServerImageryProvider: C.ArcGisMapServerImageryProvider,
    OpenStreetMapImageryProvider: C.OpenStreetMapImageryProvider,
    IonImageryProvider: C.IonImageryProvider,
    IonWorldImageryStyle: C.IonWorldImageryStyle,
    IonResource: C.IonResource,
    EllipsoidTerrainProvider: C.EllipsoidTerrainProvider,
    createTerrainFromUrl: (url: string | ResourceLike, options) =>
      C.CesiumTerrainProvider.fromUrl(typeof url === 'string' ? url : own<Cesium.Resource>(url), options),
    createGooglePhotorealistic3DTileset: (options) => C.createGooglePhotorealistic3DTileset(options),
    PointPrimitiveCollection: C.PointPrimitiveCollection,
    PolylineCollection: C.PolylineCollection,
    createBillboardCollection: (scene: SceneLike) => new C.BillboardCollection({ scene: own<Cesium.Scene>(scene) }),
    createLabelCollection: (scene: SceneLike) => new C.LabelCollection({ scene: own<Cesium.Scene>(scene) }),
    Material: C.Material,
    groundPrimitivesSupported: (scene: SceneLike) => C.GroundPrimitive.isSupported(own<Cesium.Scene>(scene)),
    createGroundRectangles: (cells) =>
      new C.GroundPrimitive({
        geometryInstances: cells.map(
          (cell) =>
            new C.GeometryInstance({
              id: cell.id,
              geometry: new C.RectangleGeometry({
                rectangle: own<Cesium.Rectangle>(cell.rectangle satisfies RectangleLike),
                vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
              }),
              attributes: {
                color: C.ColorGeometryInstanceAttribute.fromColor(own<Cesium.Color>(cell.color satisfies ColorLike)),
              },
            }),
        ),
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
        asynchronous: true,
        show: true,
      }),
    CustomDataSource: C.CustomDataSource,
    createPolygonHierarchy: (positions: Cartesian3Like[], holes?: PolygonHierarchyLike[]) =>
      new C.PolygonHierarchy(
        own<Cesium.Cartesian3[]>(positions),
        holes ? own<Cesium.PolygonHierarchy[]>(holes) : undefined,
      ),
    ScreenSpaceEventHandler: C.ScreenSpaceEventHandler,
    ScreenSpaceEventType: C.ScreenSpaceEventType,
    CameraEventType: C.CameraEventType,
    KeyboardEventModifier: C.KeyboardEventModifier,
    HeightReference: C.HeightReference,
    VerticalOrigin: C.VerticalOrigin,
    HorizontalOrigin: C.HorizontalOrigin,
    LabelStyle: C.LabelStyle,
    ClassificationType: C.ClassificationType,
    SceneTransforms: {
      // `own()` undoes the SceneLike narrowing: at runtime this is the Scene Cesium
      // handed us, and SceneTransforms demands the class type, not a structural subset.
      worldToWindowCoordinates: (scene, position) =>
        C.SceneTransforms.worldToWindowCoordinates(own<Cesium.Scene>(scene), own<Cesium.Cartesian3>(position)),
    },
  };
}

/**
 * Load and adapt the real module (renderer process only).
 *
 * The specifier is asserted by cesium-module.test.ts: importing `cesium` here would pull
 * @cesium/widgets and its Knockout `eval` back into the bundle and blank the window.
 */
export async function loadCesium(): Promise<CesiumLike> {
  const mod: CesiumModule = await import('@cesium/engine');
  return adaptCesiumModule(mod);
}
