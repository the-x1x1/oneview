import type { RenderFeature, ResolvedStyle } from '@worldview/render-core';
import type { Cartesian3Like, CesiumLike, PointCollectionLike, PointPrimitiveLike } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { toCartesian } from '../geometry.js';
import { MARKER_DEPTH_TEST_DISTANCE_M } from './depth.js';
import type { Movers } from './motion.js';

/** Plain points (LOD 'points'/'markers' without an icon): one PointPrimitiveCollection per layer, updated in place. */
export class PointLayer {
  private readonly items = new Map<string, PointPrimitiveLike>();
  constructor(
    private readonly cesium: Pick<CesiumLike, 'Cartesian3' | 'NearFarScalar'>,
    private readonly theme: CesiumTheme,
    readonly collection: PointCollectionLike,
    /** Whether the Earth leaves a position in view (horizon.ts); markers are not depth-tested. */
    private readonly visible: (position: Cartesian3Like) => boolean = () => true,
    /** Where a feature with `motion` is moved between its two positions (motion.ts). */
    private readonly movers?: Movers,
  ) {}

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
      existing.show = this.visible(position);
      this.track(feature, existing, position);
      return;
    }
    const point = this.collection.add({
      id: feature.id,
      position,
      color,
      outlineColor,
      outlineWidth: resolved.outlineWidthPx,
      pixelSize: resolved.sizePx,
      show: this.visible(position),
      disableDepthTestDistance: MARKER_DEPTH_TEST_DISTANCE_M,
      // Larger close up; never smaller than the size asked for. Shrinking to 0.7 at a
      // globe-wide distance turned a 3 px dot into a 2 px smudge.
      scaleByDistance: new this.cesium.NearFarScalar(1.0e5, 1.25, 8.0e6, 1.0),
    });
    this.items.set(feature.id, point);
    this.track(feature, point, position);
  }

  private track(feature: RenderFeature, point: PointPrimitiveLike, from: Cartesian3Like): void {
    if (!this.movers) return;
    const key = `p:${feature.id}`;
    const m = feature.motion;
    if (!m) {
      this.movers.delete(key);
      return;
    }
    const to = toCartesian(this.cesium, m.to, feature.style.heightMode);
    this.movers.set(
      key,
      {
        place: (p) => {
          point.position = p;
        },
        shown: () => point.show,
        from,
        to,
      },
      m,
    );
  }

  /** Re-test every point against the horizon; returns how many changed. */
  cull(): number {
    let changed = 0;
    for (const p of this.items.values()) {
      const show = this.visible(p.position);
      if (p.show !== show) {
        p.show = show;
        changed++;
      }
    }
    return changed;
  }

  remove(id: string): boolean {
    const p = this.items.get(id);
    if (!p) return false;
    this.items.delete(id);
    this.movers?.delete(`p:${id}`);
    return this.collection.remove(p);
  }

  get count(): number {
    return this.items.size;
  }
  clear(): void {
    for (const id of this.items.keys()) this.movers?.delete(`p:${id}`);
    this.items.clear();
    this.collection.removeAll();
  }
  dispose(): void {
    for (const id of this.items.keys()) this.movers?.delete(`p:${id}`);
    this.items.clear();
    if (!this.collection.isDestroyed()) this.collection.destroy();
  }
}
