import type { FeatureUpdate, RenderFeature } from '@worldview/render-core';
import type {
  Cartesian3Like,
  CesiumLike,
  DataSourceLike,
  PrimitiveCollectionLike,
  ViewerLike,
} from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import type { SpriteSheet } from '../sprites.js';
import { FeatureStore, type FeatureRoute } from '../featureRouter.js';
import { PointLayer } from './points.js';
import { BillboardLayer } from './billboards.js';
import { LabelLayer } from './labels.js';
import { PolylineLayer } from './polylines.js';
import { EntityLayer } from './entities.js';
import { DensityLayer } from './density.js';

export type LayerSetModule = Pick<
  CesiumLike,
  | 'Cartesian3'
  | 'Cartesian2'
  | 'Rectangle'
  | 'NearFarScalar'
  | 'HeightReference'
  | 'VerticalOrigin'
  | 'HorizontalOrigin'
  | 'LabelStyle'
  | 'ClassificationType'
  | 'Material'
  | 'PointPrimitiveCollection'
  | 'PolylineCollection'
  | 'CustomDataSource'
  | 'createBillboardCollection'
  | 'createLabelCollection'
  | 'createPolygonHierarchy'
  | 'groundPrimitivesSupported'
  | 'createGroundRectangles'
>;

/** Everything one `RenderFeature.layer` owns; collections are created on first use. */
class LayerBundle {
  points?: PointLayer;
  billboards?: BillboardLayer;
  labels?: LabelLayer;
  polylines?: PolylineLayer;
  entities?: EntityLayer;
  density?: DensityLayer;
  private dataSource?: DataSourceLike;
  constructor(
    readonly id: string,
    private readonly cesium: LayerSetModule,
    private readonly theme: CesiumTheme,
    private readonly sprites: SpriteSheet,
    private readonly viewer: ViewerLike,
    private readonly primitives: PrimitiveCollectionLike,
  ) {}

  private ds(): DataSourceLike {
    if (!this.dataSource) {
      this.dataSource = new this.cesium.CustomDataSource(`worldview:${this.id}`);
      void this.viewer.dataSources.add(this.dataSource);
    }
    return this.dataSource;
  }
  pointLayer(): PointLayer {
    return (this.points ??= new PointLayer(
      this.cesium,
      this.theme,
      this.primitives.add(new this.cesium.PointPrimitiveCollection()),
    ));
  }
  billboardLayer(): BillboardLayer {
    return (this.billboards ??= new BillboardLayer(
      this.cesium,
      this.theme,
      this.sprites,
      this.primitives.add(this.cesium.createBillboardCollection(this.viewer.scene)),
    ));
  }
  labelLayer(): LabelLayer {
    return (this.labels ??= new LabelLayer(
      this.cesium,
      this.theme,
      this.primitives.add(this.cesium.createLabelCollection(this.viewer.scene)),
    ));
  }
  polylineLayer(): PolylineLayer {
    return (this.polylines ??= new PolylineLayer(
      this.cesium,
      this.theme,
      this.primitives.add(new this.cesium.PolylineCollection()),
    ));
  }
  entityLayer(): EntityLayer {
    return (this.entities ??= new EntityLayer(this.cesium, this.theme, this.ds()));
  }
  densityLayer(): DensityLayer {
    return (this.density ??= new DensityLayer(
      this.cesium,
      this.theme,
      this.viewer.scene,
      this.viewer.scene.groundPrimitives,
      this.ds(),
    ));
  }

  remove(id: string, routes: FeatureRoute[]): void {
    for (const r of routes) {
      switch (r) {
        case 'point':
          this.points?.remove(id);
          break;
        case 'billboard':
        case 'cluster':
          this.billboards?.remove(id);
          break;
        case 'label':
          this.labels?.remove(id);
          break;
        case 'polyline':
          this.polylines?.remove(id);
          break;
        case 'polygon':
        case 'circle':
          this.entities?.remove(id);
          break;
        case 'density':
          this.density?.remove(id);
          break;
      }
    }
  }

  flush(): void {
    this.density?.flush();
  }
  get count(): number {
    return (
      (this.points?.count ?? 0) +
      (this.billboards?.count ?? 0) +
      (this.polylines?.count ?? 0) +
      (this.entities?.count ?? 0) +
      (this.density?.count ?? 0)
    );
  }

  clear(): void {
    this.points?.clear();
    this.billboards?.clear();
    this.labels?.clear();
    this.polylines?.clear();
    this.entities?.clear();
    this.density?.clear();
  }

  dispose(): void {
    for (const c of [this.points, this.billboards, this.labels, this.polylines])
      if (c) {
        this.primitives.remove(c.collection);
        c.dispose();
      }
    this.entities?.dispose();
    this.density?.dispose();
    if (this.dataSource) this.viewer.dataSources.remove(this.dataSource, true);
  }
}

/** Routes FeatureUpdates into per-layer primitive collections. */
export class LayerSet {
  readonly store = new FeatureStore();
  private readonly bundles = new Map<string, LayerBundle>();
  private readonly primitives: PrimitiveCollectionLike;

  constructor(
    private readonly cesium: LayerSetModule,
    private readonly theme: CesiumTheme,
    private readonly sprites: SpriteSheet,
    private readonly viewer: ViewerLike,
  ) {
    this.primitives = viewer.scene.primitives;
  }

  private bundle(layer: string): LayerBundle {
    let b = this.bundles.get(layer);
    if (!b) {
      b = new LayerBundle(layer, this.cesium, this.theme, this.sprites, this.viewer, this.primitives);
      this.bundles.set(layer, b);
    }
    return b;
  }

  apply(update: FeatureUpdate, styleOverride?: (f: RenderFeature) => RenderFeature): void {
    const { removed, upserted } = this.store.apply(update);
    const touched = new Set<string>();
    for (const r of removed) {
      this.bundles.get(r.previous.feature.layer)?.remove(r.id, r.previous.routes);
      touched.add(r.previous.feature.layer);
    }
    for (const { previous, next } of upserted) {
      if (
        previous &&
        (previous.feature.layer !== next.feature.layer || previous.routes.some((r) => !next.routes.includes(r)))
      ) {
        this.bundles.get(previous.feature.layer)?.remove(next.feature.id, previous.routes);
      }
      this.render(styleOverride ? styleOverride(next.feature) : next.feature, next.routes);
      touched.add(next.feature.layer);
    }
    for (const layer of touched) this.bundles.get(layer)?.flush();
  }

  /** Re-render one stored feature (selection highlight) without changing the store. */
  restyle(id: string, transform: (f: RenderFeature) => RenderFeature): boolean {
    const stored = this.store.get(id);
    if (!stored) return false;
    this.render(transform(stored), this.store.routesOf(id));
    this.bundles.get(stored.layer)?.flush();
    return true;
  }

  private render(feature: RenderFeature, routes: FeatureRoute[]): void {
    const resolved = this.theme.resolve(feature.style);
    const b = this.bundle(feature.layer);
    for (const r of routes) {
      switch (r) {
        case 'point':
          b.pointLayer().upsert(feature, resolved);
          break;
        case 'billboard':
        case 'cluster':
          b.billboardLayer().upsert(feature, resolved);
          break;
        case 'label':
          b.labelLayer().upsert(feature, resolved);
          break;
        case 'polyline':
          b.polylineLayer().upsert(feature, resolved);
          break;
        case 'polygon':
        case 'circle':
          b.entityLayer().upsert(feature, resolved);
          break;
        case 'density':
          b.densityLayer().upsert(feature, resolved);
          break;
      }
    }
  }

  declutter(
    project: (position: Cartesian3Like) => { x: number; y: number } | undefined,
    viewport: { width: number; height: number },
  ): number {
    let shown = 0;
    for (const b of this.bundles.values()) if (b.labels) shown += b.labels.declutter(project, viewport);
    return shown;
  }

  get featureCount(): number {
    return this.store.size;
  }
  get primitiveCount(): number {
    let n = 0;
    for (const b of this.bundles.values()) n += b.count;
    return n;
  }
  layerIds(): string[] {
    return [...this.bundles.keys()];
  }

  clear(layer?: string): void {
    this.store.clear(layer);
    if (layer) this.bundles.get(layer)?.clear();
    else for (const b of this.bundles.values()) b.clear();
  }

  dispose(): void {
    for (const b of this.bundles.values()) b.dispose();
    this.bundles.clear();
    this.store.clear();
  }
}
