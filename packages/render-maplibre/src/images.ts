import { drawGlyph, type GlyphContext } from '@worldview/render-core';
import type { MapLike, StyleImageLike } from './maplibre-like.js';
import { iconImageId } from './geojson.js';

/**
 * Icon images for symbol layers. MapLibre tints only SDF sprites, and plain
 * glyph masks are not distance fields, so each (icon, colour) pair is rasterised
 * once and registered under `wv-icon:<icon>:<colour>`; the feature property
 * `icon` carries that id. Images survive `setStyle` in MapLibre ≥ 4 only when
 * re-added, so the registry re-registers after a style change.
 */
export interface ImageCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): (GlyphContext & { getImageData(x: number, y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } }) | null;
}
export type ImageCanvasFactory = (width: number, height: number) => ImageCanvas;

export const ICON_IMAGE_PX = 48;

export function domImageCanvasFactory(): ImageCanvasFactory {
  return (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}

export class IconRegistry {
  private readonly images = new Map<string, StyleImageLike>();
  constructor(private readonly createCanvas: ImageCanvasFactory, private readonly sizePx = ICON_IMAGE_PX) {}

  /** Rasterise (once) and register (if missing) the image for an icon/colour pair; returns the image id. */
  ensure(map: MapLike, icon: string, colorCss: string): string {
    const id = iconImageId(icon, colorCss);
    let image = this.images.get(id);
    if (!image) {
      const canvas = this.createCanvas(this.sizePx, this.sizePx);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable for icon rasterisation');
      drawGlyph(ctx, icon, this.sizePx, colorCss);
      const px = ctx.getImageData(0, 0, this.sizePx, this.sizePx);
      image = { width: px.width, height: px.height, data: px.data };
      this.images.set(id, image);
    }
    if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: 2 });
    return id;
  }

  /** Re-register every known image (after `setStyle`). */
  reapply(map: MapLike): number {
    let n = 0;
    for (const [id, image] of this.images) if (!map.hasImage(id)) { map.addImage(id, image, { pixelRatio: 2 }); n++; }
    return n;
  }

  get size(): number { return this.images.size; }
}

/** Parse an image id produced by `iconImageId` back into its parts. */
export function parseIconImageId(id: string): { icon: string; colorCss: string } | undefined {
  const m = /^wv-icon:([^:]+):(.+)$/.exec(id);
  return m ? { icon: m[1]!, colorCss: m[2]! } : undefined;
}
