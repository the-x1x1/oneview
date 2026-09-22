import { resolveStyle, type ResolvedStyle, type RenderStyle, type RgbaColor, type Theme } from '@worldview/render-core';
import type { CesiumLike, ColorLike } from './cesium-like.js';

/**
 * Cesium-side theme: the shared render-core theme resolved into Cesium colours.
 * Colours are memoised per rgba so thousands of points share instances.
 */
export class CesiumTheme {
  private readonly colors = new Map<string, ColorLike>();
  constructor(
    private readonly cesium: Pick<CesiumLike, 'Color'>,
    private readonly theme?: Theme,
  ) {}

  color(c: RgbaColor): ColorLike {
    const key = `${c.r.toFixed(3)},${c.g.toFixed(3)},${c.b.toFixed(3)},${c.a.toFixed(3)}`;
    let hit = this.colors.get(key);
    if (!hit) {
      hit = new this.cesium.Color(c.r, c.g, c.b, c.a);
      this.colors.set(key, hit);
    }
    return hit;
  }

  resolve(style: RenderStyle): ResolvedStyle {
    return resolveStyle(style, this.theme);
  }

  /** Cesium label font string. */
  labelFont(resolved: ResolvedStyle): string {
    return `${resolved.labelFontPx}px "Inter", "Segoe UI", system-ui, sans-serif`;
  }
}
