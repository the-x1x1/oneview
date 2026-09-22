import type { RenderFeature, ResolvedStyle } from '@worldview/render-core';
import type { Cartesian3Like, CesiumLike, LabelCollectionLike, LabelLike } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { heightReferenceFor, toCartesian } from '../geometry.js';
import { declutterLabels, estimateLabelSize, type LabelCandidate } from '../labelDeclutter.js';
import { iconSizePx } from './billboards.js';
import { MARKER_DEPTH_TEST_DISTANCE_M } from './depth.js';

interface LabelEntry {
  label: LabelLike;
  position: Cartesian3Like;
  priority: number;
  width: number;
  height: number;
  centered: boolean;
}

/**
 * Labels: one LabelCollection per layer. Cluster counts sit centred on the disc;
 * other labels hang below their marker. `declutter()` projects anchors to the
 * window and hides overlapping lower-priority labels (labelDeclutter.ts).
 */
export class LabelLayer {
  private readonly items = new Map<string, LabelEntry>();
  constructor(
    private readonly cesium: Pick<
      CesiumLike,
      'Cartesian3' | 'Cartesian2' | 'HeightReference' | 'VerticalOrigin' | 'HorizontalOrigin' | 'LabelStyle'
    >,
    private readonly theme: CesiumTheme,
    readonly collection: LabelCollectionLike,
  ) {}

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    const text = feature.style.label;
    if (!text) {
      this.remove(feature.id);
      return;
    }
    const g = feature.geometry;
    const anchor = g.kind === 'point' || g.kind === 'cluster' ? g.position : g.kind === 'circle' ? g.center : undefined;
    if (!anchor) return;
    const centered = g.kind === 'cluster';
    const mode = centered ? 'clamp' : feature.style.heightMode;
    const position = toCartesian(this.cesium, anchor, mode);
    const priority = feature.style.labelPriority ?? feature.priority;
    const fontPx = centered
      ? Math.max(10, Math.min(16, Math.round(iconSizePx(resolved, true) * 0.4)))
      : resolved.labelFontPx;
    const { width, height } = estimateLabelSize(text, fontPx);
    const offsetY = centered ? 0 : (feature.style.icon ? iconSizePx(resolved, false) / 2 : resolved.sizePx / 2) + 3;
    const fill = this.theme.color(centered ? { r: 0.04, g: 0.06, b: 0.09, a: 1 } : resolved.labelColor);
    const outline = this.theme.color(centered ? resolved.color : resolved.labelOutlineColor);
    const font = `${centered ? '600 ' : ''}${fontPx}px "Inter", "Segoe UI", system-ui, sans-serif`;
    const existing = this.items.get(feature.id);
    if (existing) {
      const l = existing.label;
      l.position = position;
      l.text = text;
      l.font = font;
      l.fillColor = fill;
      l.outlineColor = outline;
      l.pixelOffset = new this.cesium.Cartesian2(0, offsetY);
      l.heightReference = heightReferenceFor(this.cesium, mode);
      existing.position = position;
      existing.priority = priority;
      existing.width = width;
      existing.height = height;
      existing.centered = centered;
      return;
    }
    const label = this.collection.add({
      id: feature.id,
      position,
      text,
      font,
      fillColor: fill,
      outlineColor: outline,
      outlineWidth: centered ? 0 : 3,
      style: this.cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new this.cesium.Cartesian2(0, offsetY),
      horizontalOrigin: this.cesium.HorizontalOrigin.CENTER,
      verticalOrigin: centered ? this.cesium.VerticalOrigin.CENTER : this.cesium.VerticalOrigin.TOP,
      heightReference: heightReferenceFor(this.cesium, mode),
      disableDepthTestDistance: MARKER_DEPTH_TEST_DISTANCE_M,
      show: true,
    });
    this.items.set(feature.id, { label, position, priority, width, height, centered });
  }

  remove(id: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    this.items.delete(id);
    return this.collection.remove(e.label);
  }

  /** Hide overlapping labels. `project` maps a world position to window px (undefined when behind the globe). */
  declutter(
    project: (position: Cartesian3Like) => { x: number; y: number } | undefined,
    viewport: { width: number; height: number },
  ): number {
    const candidates: LabelCandidate[] = [];
    const behind: string[] = [];
    for (const [id, e] of this.items) {
      const p = project(e.position);
      if (!p) {
        behind.push(id);
        continue;
      }
      candidates.push({
        id,
        x: p.x,
        y: p.y,
        width: e.width,
        height: e.height,
        priority: e.priority,
        anchor: e.centered ? 'center' : 'below',
      });
    }
    const visible = declutterLabels(candidates, viewport);
    for (const [id, e] of this.items) e.label.show = visible.has(id);
    return visible.size;
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
