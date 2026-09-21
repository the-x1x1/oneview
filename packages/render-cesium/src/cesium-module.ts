import type * as Cesium from 'cesium';
import type { CesiumLike, ColorLike, ImageryProviderLike, RectangleLike, ResourceLike, SceneLike, Cartesian3Like, PolygonHierarchyLike } from './cesium-like.js';

/**
 * Adapts the real `cesium` module to `CesiumLike`. This is the ONE file typed
 * against Cesium's own declarations (the declaration shim in
 * tools/dev/type-shims/cesium when the package is not installed), so the
 * typecheck verifies that every member the adapter relies on exists with a
 * compatible signature.
 *
 * `own()` re-attaches Cesium's nominal class types to values that this same
 * module produced (a Rectangle from `Rectangle.fromDegrees`, a Color from
 * `new Color`, the Scene from the Viewer). The *Like interfaces drop Cesium's
 * instance methods on purpose so tests can substitute plain objects; handing the
 * values back to constructors that demand the class type is the only place the
 * narrowing is undone.
 */
export type CesiumModule = typeof Cesium;

function own<T>(value: unknown): T {
  return value as T;
}

export function adaptCesiumModule(C: CesiumModule): CesiumLike {
  return {
    Viewer: C.Viewer,
    Cartesian2: C.Cartesian2,
    Cartesian3: C.Cartesian3,
    Cartographic: C.Cartographic,
    Rectangle: C.Rectangle,
    Color: C.Color,
    Credit: C.Credit,
    NearFarScalar: C.NearFarScalar,
    Math: C.Math,
    buildModuleUrl: C.buildModuleUrl,
    ImageryLayer: { fromProviderAsync: (provider: Promise<ImageryProviderLike>) => C.ImageryLayer.fromProviderAsync(own<Promise<Cesium.ImageryProvider>>(provider)) },
    TileMapServiceImageryProvider: C.TileMapServiceImageryProvider,
    UrlTemplateImageryProvider: C.UrlTemplateImageryProvider,
    ArcGisMapServerImageryProvider: C.ArcGisMapServerImageryProvider,
    OpenStreetMapImageryProvider: C.OpenStreetMapImageryProvider,
    IonImageryProvider: C.IonImageryProvider,
    IonWorldImageryStyle: C.IonWorldImageryStyle,
    IonResource: C.IonResource,
    EllipsoidTerrainProvider: C.EllipsoidTerrainProvider,
    createTerrainFromUrl: (url: string | ResourceLike, options) => C.CesiumTerrainProvider.fromUrl(typeof url === 'string' ? url : own<Cesium.Resource>(url), options),
    createGooglePhotorealistic3DTileset: (options) => C.createGooglePhotorealistic3DTileset(options),
    PointPrimitiveCollection: C.PointPrimitiveCollection,
    PolylineCollection: C.PolylineCollection,
    createBillboardCollection: (scene: SceneLike) => new C.BillboardCollection({ scene: own<Cesium.Scene>(scene) }),
    createLabelCollection: (scene: SceneLike) => new C.LabelCollection({ scene: own<Cesium.Scene>(scene) }),
    Material: C.Material,
    groundPrimitivesSupported: (scene: SceneLike) => C.GroundPrimitive.isSupported(own<Cesium.Scene>(scene)),
    createGroundRectangles: (cells) => new C.GroundPrimitive({
      geometryInstances: cells.map((cell) => new C.GeometryInstance({
        id: cell.id,
        geometry: new C.RectangleGeometry({ rectangle: own<Cesium.Rectangle>(cell.rectangle satisfies RectangleLike), vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(own<Cesium.Color>(cell.color satisfies ColorLike)) },
      })),
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
      asynchronous: true,
      show: true,
    }),
    CustomDataSource: C.CustomDataSource,
    createPolygonHierarchy: (positions: Cartesian3Like[], holes?: PolygonHierarchyLike[]) => new C.PolygonHierarchy(own<Cesium.Cartesian3[]>(positions), holes ? own<Cesium.PolygonHierarchy[]>(holes) : undefined),
    ScreenSpaceEventHandler: C.ScreenSpaceEventHandler,
    ScreenSpaceEventType: C.ScreenSpaceEventType,
    CameraEventType: C.CameraEventType,
    KeyboardEventModifier: C.KeyboardEventModifier,
    HeightReference: C.HeightReference,
    VerticalOrigin: C.VerticalOrigin,
    HorizontalOrigin: C.HorizontalOrigin,
    LabelStyle: C.LabelStyle,
    ClassificationType: C.ClassificationType,
    SceneTransforms: C.SceneTransforms,
  };
}

/** Load and adapt the real module (renderer process only). */
export async function loadCesium(): Promise<CesiumLike> {
  const mod: CesiumModule = await import('cesium');
  return adaptCesiumModule(mod);
}
