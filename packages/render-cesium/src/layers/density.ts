import { densityColor, type RenderFeature, type ResolvedStyle } from '@worldview/render-core';
import type { GeoBounds } from '@worldview/world-model';
import type { CesiumLike, DataSourceLike, EntityLike, GroundPrimitiveLike, PrimitiveCollectionLike, SceneLike } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { boundsToRectangle } from '../geometry.js';

interface Cell { bounds: GeoBounds; intensity: number; resolved: ResolvedStyle }

/**
 * Density cells (LOD 'density'): one GroundPrimitive per layer holding every
 * cell as a colour-attributed RectangleGeometry instance. Cells arrive in
 * batches from one presentation pass, so upserts mark the layer dirty and
 * `flush()` rebuilds the primitive once (replace-then-remove to avoid a blank
 * frame). Where GroundPrimitive is unsupported the cells fall back to draped
 * rectangle entities.
 */
export class DensityLayer {
  private readonly cells = new Map<string, Cell>();
  private readonly entities = new Map<string, EntityLike>();
  private primitive: GroundPrimitiveLike | null = null;
  private dirty = false;
  private readonly supported: boolean;

  constructor(
    private readonly cesium: Pick<CesiumLike, 'Rectangle' | 'groundPrimitivesSupported' | 'createGroundRectangles' | 'ClassificationType'>,
    private readonly theme: CesiumTheme,
    private readonly scene: SceneLike,
    private readonly primitives: PrimitiveCollectionLike,
    private readonly fallback: DataSourceLike,
  ) {
    this.supported = cesium.groundPrimitivesSupported(scene);
  }

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    if (feature.geometry.kind !== 'density') return;
    this.cells.set(feature.id, { bounds: feature.geometry.bounds, intensity: feature.geometry.intensity, resolved });
    this.dirty = true;
  }

  remove(id: string): boolean {
    const had = this.cells.delete(id);
    if (had) this.dirty = true;
    return had;
  }

  /** Rebuild the batched primitive if anything changed. Returns true when a rebuild happened. */
  flush(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    if (!this.supported) return this.flushEntities();
    const cells = [...this.cells.entries()].map(([id, c]) => ({ id, rectangle: boundsToRectangle(this.cesium, c.bounds), color: this.theme.color(densityColor(c.resolved, c.intensity)) }));
    const previous = this.primitive;
    this.primitive = cells.length ? this.primitives.add(this.cesium.createGroundRectangles(cells)) : null;
    if (previous) { this.primitives.remove(previous); if (!previous.isDestroyed()) previous.destroy(); }
    return true;
  }

  private flushEntities(): boolean {
    const entities = this.fallback.entities;
    entities.suspendEvents();
    try {
      for (const [id, e] of this.entities) if (!this.cells.has(id)) { entities.remove(e); this.entities.delete(id); }
      for (const [id, c] of this.cells) {
        const existing = this.entities.get(id);
        if (existing) entities.remove(existing);
        this.entities.set(id, entities.add({ id, rectangle: { coordinates: boundsToRectangle(this.cesium, c.bounds), material: this.theme.color(densityColor(c.resolved, c.intensity)), outline: false, classificationType: this.cesium.ClassificationType.BOTH } }));
      }
    } finally { entities.resumeEvents(); }
    return true;
  }

  get count(): number { return this.cells.size; }
  clear(): void { this.cells.clear(); this.dirty = true; this.flush(); }
  dispose(): void { this.clear(); }
}
