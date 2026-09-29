/**
 * The pixel step behind an overlay's `fadeBelow` (world-model overlay.ts): each pixel's
 * alpha is scaled by where its brightest channel falls between `from` (transparent) and `to`
 * (unchanged). Pure and in place over RGBA bytes, so both renderers use the same numbers — the
 * globe on a tile's canvas before Cesium uploads it, the 2D map in its tile protocol.
 *
 * `monochrome` also redraws the pixel in one grey scale shared by every source: from a light
 * grey where the ramp starts to white where it ends. The five infrared slices come from two
 * services with different pictures — NASA GIBS colours the coldest cloud tops green, yellow and
 * red, EUMETSAT's are grey — so side by side the seam between them was a change of colour as
 * well as of satellite, and GIBS's coloured tops read as rain beside the precipitation layer.
 * In one grey, each normalised by its own ramp, the slices look alike and colour on the map
 * means precipitation.
 *
 * `columnWeight`, one factor per pixel column, multiplies the alpha as well: the feather that
 * cross-fades two neighbouring satellites' slices (`featherWeights`).
 */
export interface FadeRamp {
  from: number;
  to: number;
  monochrome?: boolean;
}

export function applyBrightnessFade(
  rgba: Uint8ClampedArray,
  ramp: FadeRamp,
  columnWeight?: Float32Array,
  width?: number,
): void {
  const span = ramp.to - ramp.from;
  if (!(span > 0)) return;
  const mono = ramp.monochrome === true;
  const weighted = columnWeight !== undefined && width !== undefined && width > 0;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    const t = m >= ramp.to ? 1 : m <= ramp.from ? 0 : (m - ramp.from) / span;
    let a = t === 1 ? rgba[i + 3]! : Math.round(rgba[i + 3]! * t);
    if (weighted) a = Math.round(a * columnWeight![p % width!]!);
    rgba[i + 3] = a;
    if (mono) {
      const grey = Math.round(170 + 85 * t);
      rgba[i] = grey;
      rgba[i + 1] = grey;
      rgba[i + 2] = grey;
    }
  }
}

/** The longitude of the west edge of Web Mercator tile column `x` at zoom `z`. */
function tileWest(z: number, x: number): number {
  return (x / 2 ** z) * 360 - 180;
}

/**
 * Per-column alpha for a tile of a slice drawn `featherDeg` wider than its bounds and faded
 * across its edges, so two slices meeting at a longitude overlap by `featherDeg` and cross-fade
 * there instead of cutting from one satellite's picture to the other's along a straight line.
 * Weight 1 inside the slice's edges less half the feather, 0 beyond them plus half, linear
 * between: at the seam itself each slice is at one half, and the two sum to one throughout.
 * Undefined when the whole tile is at full weight (nothing to do). A slice may cross the
 * antimeridian (`west > east`); a slice spanning the whole world is never feathered.
 */
export function featherWeights(
  tile: { z: number; x: number },
  width: number,
  slice: { west: number; east: number },
  featherDeg: number,
): Float32Array | undefined {
  if (!(featherDeg > 0) || !(width > 0)) return undefined;
  const east = slice.east < slice.west ? slice.east + 360 : slice.east;
  const west = slice.west;
  if (east - west >= 360) return undefined;
  const centre = (west + east) / 2;
  const half = featherDeg / 2;
  const w0 = tileWest(tile.z, tile.x);
  const span = 360 / 2 ** tile.z;
  const out = new Float32Array(width);
  let partial = false;
  for (let c = 0; c < width; c++) {
    let lon = w0 + ((c + 0.5) / width) * span;
    // The copy of this longitude nearest the slice, so a slice across 180° reads its far side.
    while (lon - centre > 180) lon -= 360;
    while (lon - centre < -180) lon += 360;
    const fromWest = (lon - (west - half)) / featherDeg;
    const fromEast = (east + half - lon) / featherDeg;
    const v = Math.max(0, Math.min(1, fromWest, fromEast));
    out[c] = v;
    if (v < 1) partial = true;
  }
  return partial ? out : undefined;
}
