import { geodesicCircle, type RenderFeature, type ResolvedStyle } from '@worldview/render-core';
import type { GeoPosition } from '@worldview/world-model';
import type { CesiumLike, ColorLike, DataSourceLike, EntityLike, EntityOptions } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { positionsValid, toCartesianArray } from '../geometry.js';

/**
 * Polygons and circles: entities in one CustomDataSource per layer. Entity
 * polygons/ellipses without a height drape on terrain (clamp-to-ground) and
 * classify both terrain and 3D tiles. Entities are replaced on upsert.
 *
 * Cesium draws no outline on a ground-clamped polygon or ellipse (it says so in the console,
 * once per shape), so an area was a faint fill with no edge — a watch zone or a weather alert
 * over the sea was hard to see at all. The edge is a ground-clamped polyline of the outer
 * ring on the same entity.
 */
export class EntityLayer {
  private readonly items = new Map<string, EntityLike>();
  constructor(
    private readonly cesium: Pick<CesiumLike, 'Cartesian3' | 'createPolygonHierarchy' | 'ClassificationType'>,
    private readonly theme: CesiumTheme,
    readonly dataSource: DataSourceLike,
  ) {}

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    const options = this.entityOptions(feature, resolved);
    if (!options) {
      this.remove(feature.id);
      return;
    }
    const entities = this.dataSource.entities;
    entities.suspendEvents();
    try {
      const existing = this.items.get(feature.id);
      if (existing) entities.remove(existing);
      this.items.set(feature.id, entities.add(options));
    } finally {
      entities.resumeEvents();
    }
  }

  entityOptions(feature: RenderFeature, resolved: ResolvedStyle): EntityOptions | undefined {
    const g = feature.geometry;
    const fill = this.theme.color({ ...resolved.color, a: resolved.fillAlpha });
    const outline = this.theme.color(resolved.color);
    if (g.kind === 'polygon') {
      const outer = g.rings[0];
      if (!outer || !positionsValid(outer) || outer.length < 3) return undefined;
      const holes = g.rings
        .slice(1)
        .filter((r) => positionsValid(r) && r.length >= 3)
        .map((r) => this.cesium.createPolygonHierarchy(toCartesianArray(this.cesium, r, 'clamp')));
      return {
        id: feature.id,
        polygon: {
          hierarchy: this.cesium.createPolygonHierarchy(toCartesianArray(this.cesium, outer, 'clamp'), holes),
          material: fill,
          outline: false,
          classificationType: this.cesium.ClassificationType.BOTH,
        },
        polyline: this.edge(closed(outer), outline, feature),
      };
    }
    if (g.kind === 'circle') {
      if (!Number.isFinite(g.radiusM) || g.radiusM <= 0) return undefined;
      return {
        id: feature.id,
        position: this.cesium.Cartesian3.fromDegrees(g.center.longitude, g.center.latitude, 0),
        ellipse: {
          semiMajorAxis: g.radiusM,
          semiMinorAxis: g.radiusM,
          material: fill,
          outline: false,
          classificationType: this.cesium.ClassificationType.BOTH,
        },
        polyline: this.edge(geodesicCircle(g.center, g.radiusM), outline, feature),
      };
    }
    return undefined;
  }

  private edge(ring: readonly GeoPosition[], color: ColorLike, feature: RenderFeature) {
    return {
      positions: toCartesianArray(this.cesium, ring, 'clamp'),
      width: Math.max(1.5, feature.style.size ?? 1.5),
      material: color,
      clampToGround: true,
    };
  }

  remove(id: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    this.items.delete(id);
    return this.dataSource.entities.remove(e);
  }

  get count(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
    this.dataSource.entities.removeAll();
  }
  dispose(): void {
    this.clear();
  }
}

/** A ring with its first position repeated at the end. */
function closed(ring: readonly GeoPosition[]): GeoPosition[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last || (first.latitude === last.latitude && first.longitude === last.longitude)) return [...ring];
  return [...ring, first];
}
