import type { RenderFeature, ResolvedStyle } from '@worldview/render-core';
import type { CesiumLike, DataSourceLike, EntityLike, EntityOptions } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { positionsValid, toCartesianArray } from '../geometry.js';

/**
 * Polygons and circles: entities in one CustomDataSource per layer. Entity
 * polygons/ellipses without a height drape on terrain (clamp-to-ground) and
 * classify both terrain and 3D tiles. Entities are replaced on upsert.
 */
export class EntityLayer {
  private readonly items = new Map<string, EntityLike>();
  constructor(private readonly cesium: Pick<CesiumLike, 'Cartesian3' | 'createPolygonHierarchy' | 'ClassificationType'>, private readonly theme: CesiumTheme, readonly dataSource: DataSourceLike) {}

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    const options = this.entityOptions(feature, resolved);
    if (!options) { this.remove(feature.id); return; }
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
      const holes = g.rings.slice(1).filter((r) => positionsValid(r) && r.length >= 3).map((r) => this.cesium.createPolygonHierarchy(toCartesianArray(this.cesium, r, 'clamp')));
      return {
        id: feature.id,
        polygon: {
          hierarchy: this.cesium.createPolygonHierarchy(toCartesianArray(this.cesium, outer, 'clamp'), holes),
          material: fill,
          outline: true,
          outlineColor: outline,
          outlineWidth: Math.max(1, feature.style.size ?? 1),
          classificationType: this.cesium.ClassificationType.BOTH,
        },
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
          outline: true,
          outlineColor: outline,
          outlineWidth: Math.max(1, feature.style.size ?? 1),
          classificationType: this.cesium.ClassificationType.BOTH,
        },
      };
    }
    return undefined;
  }

  remove(id: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    this.items.delete(id);
    return this.dataSource.entities.remove(e);
  }

  get count(): number { return this.items.size; }
  clear(): void { this.items.clear(); this.dataSource.entities.removeAll(); }
  dispose(): void { this.clear(); }
}
