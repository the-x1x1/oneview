import type { RenderFeature, ResolvedStyle } from '@worldview/render-core';
import type { CesiumLike, PointCollectionLike, PointPrimitiveLike } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { toCartesian } from '../geometry.js';

/** Plain points (LOD 'points'/'markers' without an icon): one PointPrimitiveCollection per layer, updated in place. */
export class PointLayer {
  private readonly items = new Map<string, PointPrimitiveLike>();
  constructor(private readonly cesium: Pick<CesiumLike, 'Cartesian3' | 'NearFarScalar'>, private readonly theme: CesiumTheme, readonly collection: PointCollectionLike) {}

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    if (feature.geometry.kind !== 'point') return;
    const position = toCartesian(this.cesium, feature.geometry.position, feature.style.heightMode);
    const color = this.theme.color(resolved.color);
    const outlineColor = this.theme.color(resolved.outlineColor);
    const existing = this.items.get(feature.id);
    if (existing) {
      existing.position = position;
      existing.color = color;
      existing.outlineColor = outlineColor;
      existing.outlineWidth = resolved.outlineWidthPx;
      existing.pixelSize = resolved.sizePx;
      existing.show = true;
      return;
    }
    const point = this.collection.add({
      id: feature.id,
      position,
      color,
      outlineColor,
      outlineWidth: resolved.outlineWidthPx,
      pixelSize: resolved.sizePx,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new this.cesium.NearFarScalar(1.0e5, 1.2, 8.0e6, 0.7),
    });
    this.items.set(feature.id, point);
  }

  remove(id: string): boolean {
    const p = this.items.get(id);
    if (!p) return false;
    this.items.delete(id);
    return this.collection.remove(p);
  }

  get count(): number { return this.items.size; }
  clear(): void { this.items.clear(); this.collection.removeAll(); }
  dispose(): void { this.items.clear(); if (!this.collection.isDestroyed()) this.collection.destroy(); }
}
