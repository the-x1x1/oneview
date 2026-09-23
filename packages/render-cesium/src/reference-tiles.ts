import { lineVisibleAt, type ReferenceLine } from '@worldview/render-core';

/**
 * Borders on the 3D globe, drawn as a transparent imagery layer over the basemap.
 *
 * Why imagery rather than polylines: a line at height 0 fights the globe's own surface for
 * the same depth and breaks up into dashes, and with real terrain it runs underground
 * through every mountain range. Ground-clamped polyline primitives fix that at the cost of
 * tens of thousands of geometry instances built up front. An imagery layer is draped by the
 * globe itself — over terrain, at any tilt — and costs only the tiles in view: each tile is
 * a 256-pixel canvas with the lines that cross it drawn in, found through a coarse grid
 * index, with vertices closer than a pixel skipped.
 *
 * Tiles are in the geographic tiling scheme (two tiles at level 0), where level L is web
 * zoom L + 1; a line is drawn in a tile when Natural Earth's minimum zoom for it is reached.
 */

export interface TileContext2D {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  lineWidth: number;
  strokeStyle: string;
  lineJoin: string;
  lineCap: string;
}

export const REFERENCE_TILE_PX = 256;
const CELL_DEG = 5;
const COLS = 360 / CELL_DEG;
const ROWS = 180 / CELL_DEG;

/** Line styles: a dark underlay for contrast on bright ground, then a light line. Deliberately faint. */
export const REFERENCE_LINE_STYLE = {
  country: { under: 'rgba(0,0,0,0.30)', underWidth: 2.4, line: 'rgba(255,255,255,0.55)', width: 1.1 },
  state: { under: 'rgba(0,0,0,0.18)', underWidth: 1.9, line: 'rgba(255,255,255,0.32)', width: 0.8 },
} as const;

/** The web zoom a geographic-scheme tile level corresponds to. */
export function zoomForLevel(level: number): number {
  return level + 1;
}

/** Tile bounds in degrees: `[west, south, east, north]`. */
export function tileBounds(x: number, y: number, level: number): [number, number, number, number] {
  const size = 180 / 2 ** level;
  const west = -180 + x * size;
  const north = 90 - y * size;
  return [west, north - size, west + size, north];
}

export class ReferenceTileSource {
  private readonly cells: number[][] = Array.from({ length: COLS * ROWS }, () => []);
  private readonly stamp: Uint32Array;
  private stampGen = 0;

  constructor(private readonly lines: readonly ReferenceLine[]) {
    this.stamp = new Uint32Array(lines.length);
    lines.forEach((line, i) => {
      const [w, s, e, n] = line.bbox;
      const c0 = cellCol(w);
      const c1 = cellCol(e);
      const r0 = cellRow(n);
      const r1 = cellRow(s);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.cells[r * COLS + c]!.push(i);
    });
  }

  /** Indices of lines whose bounding box meets the tile and that are drawn at its zoom. */
  linesFor(x: number, y: number, level: number): number[] {
    const [w, s, e, n] = tileBounds(x, y, level);
    const zoom = zoomForLevel(level);
    this.stampGen = (this.stampGen + 1) >>> 0 || 1;
    const out: number[] = [];
    const c0 = cellCol(w);
    const c1 = cellCol(e - 1e-9);
    const r0 = cellRow(n);
    const r1 = cellRow(s + 1e-9);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        for (const i of this.cells[r * COLS + c]!) {
          if (this.stamp[i] === this.stampGen) continue;
          this.stamp[i] = this.stampGen;
          const line = this.lines[i]!;
          const [lw, ls, le, ln] = line.bbox;
          if (le < w || lw > e || ln < s || ls > n) continue;
          if (!lineVisibleAt(line, zoom)) continue;
          out.push(i);
        }
    return out;
  }

  /** Draw tile (x, y, level) into `ctx` (a REFERENCE_TILE_PX square). Returns the number of lines drawn. */
  draw(ctx: TileContext2D, x: number, y: number, level: number, px = REFERENCE_TILE_PX): number {
    ctx.clearRect(0, 0, px, px);
    const ids = this.linesFor(x, y, level);
    if (ids.length === 0) return 0;
    const [w, , , n] = tileBounds(x, y, level);
    const scale = px / (180 / 2 ** level);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // States under countries, each as an underlay pass then a line pass.
    for (const kind of ['state', 'country'] as const) {
      const style = REFERENCE_LINE_STYLE[kind];
      const mine = ids.filter((i) => this.lines[i]!.kind === kind);
      if (mine.length === 0) continue;
      for (const pass of ['under', 'line'] as const) {
        for (const dashed of [false, true]) {
          const group = mine.filter((i) => this.lines[i]!.dashed === dashed);
          if (group.length === 0) continue;
          ctx.setLineDash(dashed ? [4, 3] : []);
          ctx.strokeStyle = pass === 'under' ? style.under : style.line;
          ctx.lineWidth = pass === 'under' ? style.underWidth : style.width;
          ctx.beginPath();
          for (const i of group) traceLine(ctx, this.lines[i]!.coords, w, n, scale);
          ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);
    return ids.length;
  }
}

/** Path of one line in tile pixels, skipping vertices less than half a pixel from the last drawn. */
function traceLine(ctx: TileContext2D, coords: Float64Array, west: number, north: number, scale: number): void {
  let lx = (coords[0]! - west) * scale;
  let ly = (north - coords[1]!) * scale;
  ctx.moveTo(lx, ly);
  const last = coords.length - 2;
  for (let i = 2; i < coords.length; i += 2) {
    const px = (coords[i]! - west) * scale;
    const py = (north - coords[i + 1]!) * scale;
    if (i !== last && Math.abs(px - lx) < 0.5 && Math.abs(py - ly) < 0.5) continue;
    ctx.lineTo(px, py);
    lx = px;
    ly = py;
  }
}

function cellCol(lon: number): number {
  return Math.max(0, Math.min(COLS - 1, Math.floor((lon + 180) / CELL_DEG)));
}
function cellRow(lat: number): number {
  return Math.max(0, Math.min(ROWS - 1, Math.floor((90 - lat) / CELL_DEG)));
}
