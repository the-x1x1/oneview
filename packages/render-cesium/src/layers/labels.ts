import type { RenderFeature, ResolvedStyle } from '@worldview/render-core';
import type { Cartesian3Like, CesiumLike, LabelCollectionLike, LabelLike } from '../cesium-like.js';
import type { CesiumTheme } from '../theme.js';
import { heightReferenceFor, toCartesian } from '../geometry.js';
import { declutterLabels, estimateLabelSize, type LabelCandidate } from '../labelDeclutter.js';
import { iconSizePx } from './billboards.js';
import { MARKER_DEPTH_TEST_DISTANCE_M } from './depth.js';
import type { Movers } from './motion.js';

interface LabelEntry {
  label: LabelLike;
  position: Cartesian3Like;
  priority: number;
  width: number;
  height: number;
  centered: boolean;
  /** Where the label is drawn below its anchor, in px (its `pixelOffset`). */
  offsetY: number;
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
    /** A moving marker's label moves with it (motion.ts). */
    private readonly movers?: Movers,
  ) {}

  upsert(feature: RenderFeature, resolved: ResolvedStyle): void {
    const text = feature.style.label;
    if (!text) {
      this.remove(feature.id);
      return;
    }
    const g = feature.geometry;
    // An area's name sits on its northern edge, not its centre: the centre is usually what it
    // was drawn around (a watch zone made at an earthquake), and the two labels collided.
    const anchor =
      g.kind === 'point' || g.kind === 'cluster'
        ? g.position
        : g.kind === 'circle'
          ? { latitude: Math.min(89.9, g.center.latitude + g.radiusM / 111_320), longitude: g.center.longitude }
          : undefined;
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
      existing.offsetY = offsetY;
      this.track(feature, existing, position, mode);
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
    const entry: LabelEntry = { label, position, priority, width, height, centered, offsetY };
    this.items.set(feature.id, entry);
    this.track(feature, entry, position, mode);
  }

  private track(
    feature: RenderFeature,
    entry: LabelEntry,
    from: Cartesian3Like,
    mode: RenderFeature['style']['heightMode'],
  ): void {
    if (!this.movers) return;
    const key = `l:${feature.id}`;
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
          entry.label.position = p;
          // Declutter projects the anchor: it follows the label.
          entry.position = { x: p.x, y: p.y, z: p.z };
        },
        shown: () => entry.label.show,
        from,
        to,
      },
      m,
    );
  }

  remove(id: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    this.items.delete(id);
    this.movers?.delete(`l:${id}`);
    return this.collection.remove(e.label);
  }

  /**
   * This layer's labels as declutter candidates, ids prefixed with `prefix`. The box sits
   * where the label is drawn — `offsetY` below the anchor, past the icon — not at the anchor
   * itself: a storm's label hangs below a 40 px glyph and a forecast point's below an 8 px
   * dot, so boxes at the anchors missed a real overlap between them.
   */
  candidates(
    project: (position: Cartesian3Like) => { x: number; y: number } | undefined,
    prefix = '',
  ): LabelCandidate[] {
    const out: LabelCandidate[] = [];
    for (const [id, e] of this.items) {
      const p = project(e.position);
      if (!p) continue;
      out.push({
        id: prefix + id,
        x: p.x,
        y: p.y + e.offsetY,
        width: e.width,
        height: e.height,
        priority: e.priority,
        anchor: e.centered ? 'center' : 'below',
      });
    }
    return out;
  }

  /** Show the labels whose (prefixed) ids are in `visible`, hide the rest; returns how many show. */
  applyVisible(visible: ReadonlySet<string>, prefix = ''): number {
    let shown = 0;
    for (const [id, e] of this.items) {
      const show = visible.has(prefix + id);
      if (e.label.show !== show) e.label.show = show;
      if (show) shown++;
    }
    return shown;
  }

  /** Hide overlapping labels within this layer alone. `project` maps a world position to window px (undefined when behind the globe). */
  declutter(
    project: (position: Cartesian3Like) => { x: number; y: number } | undefined,
    viewport: { width: number; height: number },
  ): number {
    return this.applyVisible(declutterLabels(this.candidates(project), viewport));
  }

  get count(): number {
    return this.items.size;
  }
  clear(): void {
    for (const id of this.items.keys()) this.movers?.delete(`l:${id}`);
    this.items.clear();
    this.collection.removeAll();
  }
  dispose(): void {
    for (const id of this.items.keys()) this.movers?.delete(`l:${id}`);
    this.items.clear();
    if (!this.collection.isDestroyed()) this.collection.destroy();
  }
}
