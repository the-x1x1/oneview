/**
 * The pixel step behind an overlay's `fadeBelow` (world-model overlay.ts): each pixel's
 * alpha is scaled by where its brightest channel falls between `from` (transparent) and `to`
 * (unchanged). Pure and in place over RGBA bytes, so both renderers use the same numbers — the
 * globe on a tile's canvas before Cesium uploads it, the 2D map in its tile protocol.
 */
export function applyBrightnessFade(rgba: Uint8ClampedArray, ramp: { from: number; to: number }): void {
  const span = ramp.to - ramp.from;
  if (!(span > 0)) return;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (m >= ramp.to) continue;
    rgba[i + 3] = m <= ramp.from ? 0 : Math.round((rgba[i + 3]! * (m - ramp.from)) / span);
  }
}
