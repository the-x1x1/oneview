import { labelVisibleAt, type ReferenceData, type ReferenceLabel, type ReferenceOptions } from '@worldview/render-core';
import type { CesiumLike, ImageryLayerLike, LabelCollectionLike, LabelLike, ViewerLike } from './cesium-like.js';
import { ALWAYS_VISIBLE, type HorizonTest, type Vec3 } from './horizon.js';
import { ReferenceTileSource, type TileContext2D } from './reference-tiles.js';

/** Deep enough for a city block; the tiles redraw the same simplified lines at every level. */
const MAX_TILE_LEVEL = 18;

const FONT = '"Inter", "Segoe UI", system-ui, sans-serif';

/** Every place-name label's id starts with this, so picking can ignore them. */
export const REFERENCE_LABEL_ID_PREFIX = 'reference:';

/**
 * Borders and names on the globe. Borders are a transparent imagery layer over the basemap
 * (reference-tiles.ts explains why); names are a LabelCollection whose members are shown
 * by Natural Earth's zoom range and hidden behind the Earth by the same horizon test the
 * markers use — they are not depth-tested, so terrain never slices a name in half.
 */
export class ReferenceOverlay3D {
  private layer: ImageryLayerLike | undefined;
  private labels: LabelCollectionLike | undefined;
  private entries: Array<{ label: LabelLike; ref: ReferenceLabel; position: Vec3 }> = [];
  private data: ReferenceData | null = null;
  private options: ReferenceOptions = { borders: false, labels: false };
  private zoom = 0;
  private horizon: HorizonTest = ALWAYS_VISIBLE;

  constructor(
    private readonly cesium: Pick<
      CesiumLike,
      | 'Cartesian3'
      | 'Color'
      | 'LabelStyle'
      | 'HorizontalOrigin'
      | 'VerticalOrigin'
      | 'HeightReference'
      | 'createLabelCollection'
      | 'createCanvasImageryLayer'
    >,
    private readonly viewer: ViewerLike,
  ) {}

  set(data: ReferenceData | null, options: ReferenceOptions): void {
    const dataChanged = data !== this.data;
    this.data = data;
    this.options = options;
    // Borders.
    const wantBorders = Boolean(data && options.borders && data.lines.length);
    if (this.layer && (!wantBorders || dataChanged)) {
      this.viewer.imageryLayers.remove(this.layer, true);
      this.layer = undefined;
    }
    if (wantBorders && !this.layer && data) {
      const source = new ReferenceTileSource(data.lines);
      this.layer = this.cesium.createCanvasImageryLayer({
        maximumLevel: MAX_TILE_LEVEL,
        draw: (ctx, x, y, level) => source.draw(ctx as unknown as TileContext2D, x, y, level) > 0,
      });
      // On top of the basemap, which the stack controller keeps at index 0.
      this.viewer.imageryLayers.add(this.layer);
    }
    // Names.
    const wantLabels = Boolean(data && options.labels && data.labels.length);
    if (this.labels && (!wantLabels || dataChanged)) {
      this.viewer.scene.primitives.remove(this.labels);
      this.labels = undefined;
      this.entries = [];
    }
    if (wantLabels && !this.labels && data) this.buildLabels(data.labels);
    this.refresh();
    this.viewer.scene.requestRender();
  }

  /** The camera moved: new zoom, new horizon. Cheap enough to run on every camera change. */
  update(zoom: number, horizon: HorizonTest): void {
    this.zoom = zoom;
    this.horizon = horizon;
    this.refresh();
  }

  dispose(): void {
    if (this.layer) this.viewer.imageryLayers.remove(this.layer, true);
    if (this.labels) this.viewer.scene.primitives.remove(this.labels);
    this.layer = undefined;
    this.labels = undefined;
    this.entries = [];
  }

  /** How many names are showing (diagnostics, tests). */
  get visibleLabelCount(): number {
    return this.entries.filter((e) => e.label.show).length;
  }

  private buildLabels(labels: readonly ReferenceLabel[]): void {
    const c = this.cesium;
    const collection = c.createLabelCollection(this.viewer.scene);
    const countryFill = new c.Color(1, 1, 1, 0.82);
    const stateFill = new c.Color(0.9, 0.93, 0.97, 0.62);
    const outline = new c.Color(0, 0, 0, 0.55);
    for (const ref of labels) {
      const country = ref.kind === 'country';
      const position = c.Cartesian3.fromDegrees(ref.lon, ref.lat, 0);
      const label = collection.add({
        id: `${REFERENCE_LABEL_ID_PREFIX}${ref.kind}:${ref.name}`,
        position,
        text: ref.name,
        font: `${country ? '600 13px' : '11px'} ${FONT}`,
        fillColor: country ? countryFill : stateFill,
        outlineColor: outline,
        outlineWidth: country ? 3 : 2,
        style: c.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: c.HorizontalOrigin.CENTER,
        verticalOrigin: c.VerticalOrigin.CENTER,
        heightReference: c.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: false,
      });
      this.entries.push({ label, ref, position: position as Vec3 });
    }
    this.viewer.scene.primitives.add(collection);
    this.labels = collection;
  }

  private refresh(): void {
    const on = this.options.labels;
    for (const e of this.entries) {
      const show = on && labelVisibleAt(e.ref, this.zoom) && this.horizon(e.position);
      if (e.label.show !== show) e.label.show = show;
    }
  }
}
