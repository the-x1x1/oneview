import type { RenderFeature, ResolvedStyle } from '@worldview/render-core';
import type { BillboardCollectionLike, BillboardLike, Cartesian3Like, CesiumLike } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import type { SpriteSheet } from '../sprites.js';
import { heightReferenceFor, toCartesian } from '../geometry.js';
import { MARKER_DEPTH_TEST_DISTANCE_M } from './depth.js';
import type { Movers } from './motion.js';

/** Icon pixel size from the feature's point size: icons read larger than dots. */
export function iconSizePx(resolved: ResolvedStyle, isCluster: boolean): number {
  if (isCluster) return Math.max(16, Math.min(56, resolved.sizePx));
  return Math.max(14, Math.min(44, resolved.sizePx * 2.2));
}

/** Cesium billboard rotation is counter-clockwise radians; headings are clockwise from north. */
export function headingToBillboardRotation(headingDegrees: number): number {
  return -((headingDegrees % 360) * Math.PI) / 180;
}

/**
 * Icons and cluster discs: one BillboardCollection per layer. Sprites are white
 * glyphs tinted by `color`; `alignedAxis = UNIT_Z` keeps "up" pointing north on
 * screen so heading rotation is meaningful from any camera heading.
 */
export class BillboardLayer {
  private readonly items = new Map<string, BillboardLike>();
  constructor(
    private readonly cesium: Pick<
      CesiumLike,
      'Cartesian3' | 'HeightReference' | 'VerticalOrigin' | 'HorizontalOrigin' | 'NearFarScalar'
    >,
    private readonly theme: CesiumTheme,
    private readonly sprites: SpriteSheet,
    readonly collection: BillboardCollectionLike,
    /** Whether the Earth leaves a position in view (horizon.ts); markers are not depth-tested. */
    private readonly visible: (position: Cartesian3Like) => boolean = () => true,
    /** Where a feature with `motion` is moved between its two positions (motion.ts). */
    private readonly movers?: Movers,
  ) {}

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    const g = feature.geometry;
    if (g.kind !== 'point' && g.kind !== 'cluster') return;
    const isCluster = g.kind === 'cluster';
    const mode = isCluster ? 'clamp' : feature.style.heightMode;
    const position = toCartesian(this.cesium, g.position, mode);
    const sprite = this.sprites.get(resolved.icon ?? 'default');
    const size = iconSizePx(resolved, isCluster);
    const color = this.theme.color(resolved.color);
    const rotation = isCluster ? 0 : headingToBillboardRotation(resolved.rotationDegrees);
    const existing = this.items.get(feature.id);
    if (existing) {
      existing.position = position;
      existing.image = sprite.url;
      existing.color = color;
      existing.width = size;
      existing.height = size;
      existing.rotation = rotation;
      existing.heightReference = heightReferenceFor(this.cesium, mode);
      existing.show = this.visible(position);
      this.track(feature, existing, position, mode);
      return;
    }
    const billboard = this.collection.add({
      id: feature.id,
      position,
      image: sprite.url,
      color,
      width: size,
      height: size,
      rotation,
      alignedAxis: this.cesium.Cartesian3.UNIT_Z,
      verticalOrigin: this.cesium.VerticalOrigin.CENTER,
      horizontalOrigin: this.cesium.HorizontalOrigin.CENTER,
      heightReference: heightReferenceFor(this.cesium, mode),
      show: this.visible(position),
      disableDepthTestDistance: MARKER_DEPTH_TEST_DISTANCE_M,
      scaleByDistance: new this.cesium.NearFarScalar(1.0e5, 1.0, 8.0e6, 0.8),
    });
    this.items.set(feature.id, billboard);
    this.track(feature, billboard, position, mode);
  }

  private track(
    feature: RenderFeature,
    billboard: BillboardLike,
    from: Cartesian3Like,
    mode: RenderFeature['style']['heightMode'],
  ): void {
    if (!this.movers) return;
    const key = `b:${feature.id}`;
    const m = feature.geometry.kind === 'point' ? feature.motion : undefined;
    if (!m) {
      this.movers.delete(key);
      return;
    }
    const to = toCartesian(this.cesium, m.to, mode);
    this.movers.set(
      key,
      {
        place: (p) => {
          billboard.position = p;
        },
        shown: () => billboard.show,
        from,
        to,
      },
      m,
    );
  }

  /** Re-test every billboard against the horizon; returns how many changed. */
  cull(): number {
    let changed = 0;
    for (const b of this.items.values()) {
      const show = this.visible(b.position);
      if (b.show !== show) {
        b.show = show;
        changed++;
      }
    }
    return changed;
  }

  remove(id: string): boolean {
    const b = this.items.get(id);
    if (!b) return false;
    this.items.delete(id);
    this.movers?.delete(`b:${id}`);
    return this.collection.remove(b);
  }

  get count(): number {
    return this.items.size;
  }
  clear(): void {
    for (const id of this.items.keys()) this.movers?.delete(`b:${id}`);
    this.items.clear();
    this.collection.removeAll();
  }
  dispose(): void {
    for (const id of this.items.keys()) this.movers?.delete(`b:${id}`);
    this.items.clear();
    if (!this.collection.isDestroyed()) this.collection.destroy();
  }
}
