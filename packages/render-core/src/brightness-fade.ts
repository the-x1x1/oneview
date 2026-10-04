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
 * means precipitation. A coloured pixel counts as cloud by its colour as well as its brightness
 * (below), since GIBS's colours are the coldest tops and many of them are dark.
 *
 * `whiteIsNoData` makes pure white (255,255,255) transparent: NASA GIBS fills the part of a
 * newly listed frame it has not rendered yet with solid white blocks, and its infrared palette
 * never reaches pure white otherwise (its greys stop near 200, colder is coloured), so the fade
 * drew those blocks as a band of thick cloud across the slice.
 *
 * `columnWeight`, one factor per pixel column, multiplies the alpha as well: the feather that
 * cross-fades two neighbouring satellites' slices (`featherWeights`).
 */
/** How far from grey (brightest less dimmest channel) a pixel is cold cloud in a monochrome infrared ramp: from nothing to all. */
const CHROMA_FROM = 24;
const CHROMA_TO = 64;

export interface FadeRamp {
  from: number;
  to: number;
  monochrome?: boolean;
  whiteIsNoData?: boolean;
}

export function applyBrightnessFade(
  rgba: Uint8ClampedArray,
  ramp: FadeRamp,
  columnWeight?: Float32Array,
  width?: number,
  rowWeight?: Float32Array,
): void {
  const span = ramp.to - ramp.from;
  if (!(span > 0)) return;
  const mono = ramp.monochrome === true;
  const whiteGap = ramp.whiteIsNoData === true;
  const weighted = columnWeight !== undefined && width !== undefined && width > 0;
  const rowed = rowWeight !== undefined && width !== undefined && width > 0;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    if (whiteGap && r === 255 && g === 255 && b === 255) {
      rgba[i + 3] = 0;
      continue;
    }
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    let t = m >= ramp.to ? 1 : m <= ramp.from ? 0 : (m - ramp.from) / span;
    if (mono && t < 1) {
      // Colour in an infrared picture is cold cloud: GIBS draws everything colder than its
      // grey scale in colour, and much of that colour is dark (deep blues, greens and reds
      // whose brightest channel is under the ramp). By brightness alone the coldest tops, the
      // middle of every storm, were faded out and the clouds that were left had hard edges.
      const n = r < g ? (r < b ? r : b) : g < b ? g : b;
      const c = m - n;
      if (c > CHROMA_FROM) {
        const tc = c >= CHROMA_TO ? 1 : (c - CHROMA_FROM) / (CHROMA_TO - CHROMA_FROM);
        if (tc > t) t = tc;
      }
    }
    let a = t === 1 ? rgba[i + 3]! : Math.round(rgba[i + 3]! * t);
    if (weighted) a = Math.round(a * columnWeight![p % width!]!);
    if (rowed) a = Math.round(a * (rowWeight![Math.floor(p / width!)] ?? 1));
    rgba[i + 3] = a;
    if (mono) {
      const grey = Math.round(170 + 85 * t);
      rgba[i] = grey;
      rgba[i + 1] = grey;
      rgba[i + 2] = grey;
    }
  }
}

/**
 * NASA GIBS renders the last pixel column of the easternmost Web Mercator tiles — the column
 * that ends on the antimeridian — darker than its neighbour: Himawari's at zoom 5 read 58
 * against 116 next to it, GOES-West's 99 against 109 (tiles fetched on the test laptop,
 * 2026-10-04). Through the brightness fade a darker pixel is a more transparent one, so that
 * column became a thin line of base map down the Pacific along 180° (V&V 2026-10-04 #17).
 * The tiles on the other side of 180° start clean. This copies the next column over the last
 * one in a tile whose east edge is the antimeridian, before the fade; any other tile is left
 * alone. In place over RGBA bytes, rows in any order (a flipped bitmap keeps its columns).
 */
export function mendAntimeridianColumn(
  rgba: Uint8ClampedArray,
  width: number,
  tile: { z: number; x: number },
): boolean {
  if (!(width >= 2) || tile.x !== 2 ** tile.z - 1) return false;
  const rows = Math.floor(rgba.length / 4 / width);
  for (let r = 0; r < rows; r++) {
    const last = (r * width + width - 1) * 4;
    const prev = last - 4;
    rgba[last] = rgba[prev]!;
    rgba[last + 1] = rgba[prev + 1]!;
    rgba[last + 2] = rgba[prev + 2]!;
    rgba[last + 3] = rgba[prev + 3]!;
  }
  return true;
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
  // An edge on the antimeridian is not faded: the slice is not drawn past it (world-model
  // `drawnBounds`), so its neighbour there has nothing to cross-fade with, and a fade would
  // leave both at half strength along 180°. The two meet edge to edge.
  const hardWest = slice.west <= -180;
  const hardEast = slice.east >= 180;
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
    const fromWest = hardWest ? 1 : (lon - (west - half)) / featherDeg;
    const fromEast = hardEast ? 1 : (east + half - lon) / featherDeg;
    const v = Math.max(0, Math.min(1, fromWest, fromEast));
    out[c] = v;
    if (v < 1) partial = true;
  }
  return partial ? out : undefined;
}

/**
 * How far in from a slice's north and south edges it fades out (degrees of latitude), when it
 * is feathered. The five infrared slices end at 60° N and S (polar ice reads as storm tops
 * beyond), and were cut straight across there: the clouds stopped along a line of latitude
 * round the globe. They now thin out over the last LATITUDE_FADE_DEG inside it (50°–60°).
 */
export const LATITUDE_FADE_DEG = 10;

/** The latitude of the middle of pixel row `row` of `height` in Web Mercator tile row `y` at zoom `z`. */
function rowLatitude(z: number, y: number, row: number, height: number): number {
  const n = Math.PI - (2 * Math.PI * (y + (row + 0.5) / height)) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/**
 * Per-row alpha for a tile of a slice that fades out over `fadeDeg` inside its north and south
 * edges: 1 more than `fadeDeg` inside them, 0 at them, linear between. Undefined when the whole
 * tile is at full weight, or the slice reaches the poles of the map (±85°).
 */
export function latitudeWeights(
  tile: { z: number; y: number },
  height: number,
  slice: { south: number; north: number },
  fadeDeg: number = LATITUDE_FADE_DEG,
): Float32Array | undefined {
  if (!(fadeDeg > 0) || !(height > 0)) return undefined;
  const fadeNorth = slice.north < 85;
  const fadeSouth = slice.south > -85;
  if (!fadeNorth && !fadeSouth) return undefined;
  const out = new Float32Array(height);
  let partial = false;
  for (let r = 0; r < height; r++) {
    const lat = rowLatitude(tile.z, tile.y, r, height);
    const n = fadeNorth ? (slice.north - lat) / fadeDeg : 1;
    const s = fadeSouth ? (lat - slice.south) / fadeDeg : 1;
    const v = Math.max(0, Math.min(1, n, s));
    out[r] = v;
    if (v < 1) partial = true;
  }
  return partial ? out : undefined;
}
