import type { ScreenPoint } from '@worldview/render-core';

/**
 * Where the live camera preview tiles go (map/camera-previews.tsx), as pure arithmetic.
 *
 * The placement and the overlap rule are adapted from OSIRIS's `lib/map-tile-layout.ts`
 * (https://github.com/simplifaisoul/osiris, MIT, Copyright (c) 2026 simplifaisoul; see
 * THIRD_PARTY_NOTICES.md). The point OSIRIS makes there is kept: the pass that chooses
 * which cameras get a tile (when the camera settles) and the pass that moves the tiles on
 * every frame both call `layoutTile`, so the overlap test is made against the places the
 * tiles are actually drawn at. The choice itself is WorldView's: a hard cap on tiles and a
 * smaller one on tiles that decode video, with every camera past the video cap shown as a
 * still rather than left out.
 */
export interface TileGeometry {
  width: number;
  /** Picture height: 16:9 against `width`, so nothing is letterboxed. */
  imageHeight: number;
  /** Caption strip under the picture. */
  labelHeight: number;
  /** Clearance between the tile and its camera; the stem crosses it. */
  gap: number;
}

export interface TilePlacement {
  x: number;
  y: number;
  /** No room above the camera: the tile sits below it. */
  flipped: boolean;
  /** False when the tile was pushed back inside the map, off its camera: then no stem is drawn. */
  anchored: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * Margins the tiles keep from the map's edges. The shell's rails are beside the map, not
 * over it, so these are only the map's own furniture: the 2D/3D switch across the top right,
 * and the credits along the bottom.
 */
export interface TileEdges {
  side: number;
  top: number;
  bottom: number;
}

export const PREVIEW_GEOMETRY: TileGeometry = { width: 160, imageHeight: 90, labelHeight: 18, gap: 22 };
export const PREVIEW_EDGES: TileEdges = { side: 8, top: 48, bottom: 44 };

/** Previews appear from this zoom in (a few streets across), and not further out. */
export const PREVIEW_MIN_ZOOM = 12;
/** At most this many tiles at once… */
export const MAX_PREVIEW_TILES = 6;
/** …and of those, at most this many decoding video (MJPEG or HLS); the rest are stills. */
export const MAX_LIVE_PREVIEWS = 2;

export function tileHeight(geom: TileGeometry): number {
  return geom.imageHeight + geom.labelHeight;
}

/** Where the tile for a camera drawn at `pt` goes on a map of `viewport`. */
export function layoutTile(
  pt: ScreenPoint,
  viewport: Viewport,
  geom: TileGeometry = PREVIEW_GEOMETRY,
  edges: TileEdges = PREVIEW_EDGES,
): TilePlacement {
  const h = tileHeight(geom);
  const maxX = viewport.width - geom.width - edges.side;
  const maxY = viewport.height - h - edges.bottom;
  // Above the camera by default; below it when there is no room, so a camera near the top
  // of the map still gets a tile it can be seen to belong to.
  const above = pt.y - h - geom.gap;
  const flipped = above < edges.top;
  const wantX = pt.x - geom.width / 2;
  const wantY = flipped ? pt.y + geom.gap : above;
  const x = Math.min(Math.max(wantX, edges.side), Math.max(edges.side, maxX));
  const y = Math.min(Math.max(wantY, edges.top), Math.max(edges.top, maxY));
  return { x, y, flipped, anchored: Math.abs(x - wantX) < 1 && Math.abs(y - wantY) < 1 };
}

/** Whether two placed tiles would overlap (with a little air between them). */
export function tilesOverlap(a: TilePlacement, b: TilePlacement, geom: TileGeometry = PREVIEW_GEOMETRY): boolean {
  return Math.abs(a.x - b.x) < geom.width + 8 && Math.abs(a.y - b.y) < tileHeight(geom) + geom.gap;
}

export interface PreviewCandidate {
  id: string;
  /** Where the camera is drawn now (renderer projection). */
  point: ScreenPoint;
  /** It publishes video this window can decode (MJPEG, or HLS where Chromium plays it). */
  video: boolean;
}

export interface PreviewPick {
  id: string;
  mode: 'live' | 'still';
}

/**
 * Which cameras get a tile: nearest the middle of the map first, none whose tile would land
 * on one already taken (overlapping pictures read as one smear, not as several cameras), at
 * most `maxTiles`, and the first `maxLive` that publish video shown live; every other one,
 * video or not, is a still refreshed on the camera's own cadence.
 */
export function choosePreviews(
  candidates: readonly PreviewCandidate[],
  viewport: Viewport,
  opts: { maxTiles?: number; maxLive?: number; geom?: TileGeometry; edges?: TileEdges } = {},
): PreviewPick[] {
  const maxTiles = opts.maxTiles ?? MAX_PREVIEW_TILES;
  const maxLive = opts.maxLive ?? MAX_LIVE_PREVIEWS;
  const geom = opts.geom ?? PREVIEW_GEOMETRY;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const ranked = candidates
    .map((c) => ({ c, d: (c.point.x - cx) ** 2 + (c.point.y - cy) ** 2 }))
    .sort((a, b) => a.d - b.d || (a.c.id < b.c.id ? -1 : 1));
  const taken: TilePlacement[] = [];
  const out: PreviewPick[] = [];
  let live = 0;
  for (const { c } of ranked) {
    if (out.length >= maxTiles) break;
    const box = layoutTile(c.point, viewport, geom, opts.edges);
    if (taken.some((t) => tilesOverlap(t, box, geom))) continue;
    taken.push(box);
    const mode = c.video && live < maxLive ? 'live' : 'still';
    if (mode === 'live') live++;
    out.push({ id: c.id, mode });
  }
  return out;
}

/** Whether two picks are the same set shown the same way (so React need not render again). */
export function samePicks(a: readonly PreviewPick[], b: readonly PreviewPick[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i]!.id && p.mode === b[i]!.mode);
}
