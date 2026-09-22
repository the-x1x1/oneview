import type { RenderFeature, ResolvedStyle } from '@worldview/render-core';
import type { CesiumLike, MaterialLike, PolylineCollectionLike, PolylineLike } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { positionsValid, toCartesianArray } from '../geometry.js';

/** Material per line style: solid colour, dashed, or the selected-object trail (dash with a translucent gap). */
export function lineMaterial(
  cesium: Pick<CesiumLike, 'Material'>,
  theme: CesiumTheme,
  resolved: ResolvedStyle,
  lineStyle: RenderFeature['style']['lineStyle'],
): MaterialLike {
  const color = theme.color(resolved.color);
  switch (lineStyle ?? 'solid') {
    case 'solid':
      return cesium.Material.fromType('Color', { color });
    case 'dashed':
      return cesium.Material.fromType('PolylineDash', {
        color,
        gapColor: theme.color({ ...resolved.color, a: 0 }),
        dashLength: 16,
      });
    case 'trail':
      return cesium.Material.fromType('PolylineDash', {
        color,
        gapColor: theme.color({ ...resolved.color, a: 0.25 }),
        dashLength: 12,
      });
  }
}

/** Lines and trails: one PolylineCollection per layer. */
export class PolylineLayer {
  private readonly items = new Map<string, PolylineLike>();
  constructor(
    private readonly cesium: Pick<CesiumLike, 'Cartesian3' | 'Material'>,
    private readonly theme: CesiumTheme,
    readonly collection: PolylineCollectionLike,
  ) {}

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    if (feature.geometry.kind !== 'line') return;
    const positions = feature.geometry.positions;
    if (!positionsValid(positions)) {
      this.remove(feature.id);
      return;
    }
    const cartesians = toCartesianArray(this.cesium, positions, feature.style.heightMode);
    const material = lineMaterial(this.cesium, this.theme, resolved, feature.style.lineStyle);
    const width = Math.max(1, feature.style.size ?? 2);
    const existing = this.items.get(feature.id);
    if (existing) {
      existing.positions = cartesians;
      existing.material = material;
      existing.width = width;
      existing.show = true;
      return;
    }
    this.items.set(
      feature.id,
      this.collection.add({ id: feature.id, positions: cartesians, width, material, show: true }),
    );
  }

  remove(id: string): boolean {
    const p = this.items.get(id);
    if (!p) return false;
    this.items.delete(id);
    return this.collection.remove(p);
  }

  get count(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
    this.collection.removeAll();
  }
  dispose(): void {
    this.items.clear();
    if (!this.collection.isDestroyed()) this.collection.destroy();
  }
}
