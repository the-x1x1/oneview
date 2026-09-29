import type { RasterOverlay } from '@worldview/world-model';

/**
 * Before/after imagery comparison: two raster sources shown either side of a vertical divider
 * the operator drags across the map — yesterday's true-colour pass against today's, a
 * morning satellite against an afternoon one, the infrared against the visible picture.
 * Adapted from God's Eye View's imagery split (src/ui/imagerySplit.js and
 * src/maps/imageryComparison.js, MIT): the divider's value is the fraction of the map's
 * width left of it, and the keyboard moves it as GEV's does (arrows by 1 %, with Shift by
 * 5 %, Home and End to the edges).
 *
 * Sides are chosen by *source* (`RasterOverlay.providerId`), not by overlay id. A time-stepped
 * source publishes a new descriptor with a new id for every frame (world-model overlay.ts);
 * keyed by id, the comparison would lose its side each time GIBS or the radar advanced.
 *
 * On the globe a side is `ImageryLayer.splitDirection` and the divider `scene.splitPosition`,
 * both Cesium's own. The 2D map has nothing like it — MapLibre draws every raster layer into
 * one canvas and cannot clip one layer to part of the screen — so there the divider becomes a
 * cross-fade (`fadeOpacity`): the right source is as opaque as the share of the map right of
 * the divider, the left source the share left of it.
 */
export interface ImagerySplit {
  /** Source (providerId) drawn only left of the divider; null for none (the map as it is). */
  left: string | null;
  /** Source drawn only right of the divider; null for none. */
  right: string | null;
  /** The divider, as the fraction of the map's width to its left (0–1). */
  position: number;
}

export type SplitSide = 'left' | 'right' | 'none';

/** A position the renderers can take: finite, within 0–1; anything else is the middle. */
export function clampSplit(position: number): number {
  if (!Number.isFinite(position)) return 0.5;
  return Math.max(0, Math.min(1, position));
}

/** Which side of the divider a source's layers are drawn on. */
export function splitSideFor(split: ImagerySplit | null | undefined, providerId: string): SplitSide {
  if (!split) return 'none';
  // The same source on both sides is no comparison; drawn whole, as without one.
  if (split.left === split.right) return 'none';
  if (split.left === providerId) return 'left';
  if (split.right === providerId) return 'right';
  return 'none';
}

/**
 * The 2D stand-in: an overlay's opacity with the divider applied. A source on the right is
 * faded by the share of the map left of the divider, one on the left by the share right of
 * it, so dragging the divider leftwards brings the right source in, as it would uncover it on
 * the globe. Any other overlay keeps its opacity.
 */
export function fadeOpacity(split: ImagerySplit | null | undefined, providerId: string, opacity: number): number {
  const side = splitSideFor(split, providerId);
  if (side === 'none' || !split) return opacity;
  const p = clampSplit(split.position);
  return opacity * (side === 'right' ? 1 - p : p);
}

/** The divider after a key, or undefined for a key it does not take. */
export function stepSplit(position: number, key: string, shift: boolean): number | undefined {
  const step = shift ? 0.05 : 0.01;
  switch (key) {
    case 'ArrowLeft':
      return clampSplit(position - step);
    case 'ArrowRight':
      return clampSplit(position + step);
    case 'Home':
      return 0;
    case 'End':
      return 1;
    default:
      return undefined;
  }
}

/** One source the comparison can put on a side. */
export interface SplitCandidate {
  providerId: string;
  name: string;
}

/**
 * The sources the comparison offers: every overlay drawn over the map, one entry per source
 * (its first overlay's name), in the order they are drawn. A basemap-role overlay is the map
 * itself rather than something laid over it, so it is not offered.
 */
export function splitCandidates(overlays: readonly RasterOverlay[]): SplitCandidate[] {
  const seen = new Set<string>();
  const out: SplitCandidate[] = [];
  for (const o of overlays) {
    if (o.role === 'basemap' || seen.has(o.providerId)) continue;
    seen.add(o.providerId);
    out.push({ providerId: o.providerId, name: o.name });
  }
  return out;
}

/**
 * The comparison to start with, from what is drawn: the last two sources (the newest-added
 * on the right), or the one source on the right against the map as it is. Undefined when
 * nothing is drawn over the map.
 */
export function defaultSplit(candidates: readonly SplitCandidate[]): ImagerySplit | undefined {
  const n = candidates.length;
  if (n === 0) return undefined;
  if (n === 1) return { left: null, right: candidates[0]!.providerId, position: 0.5 };
  return { left: candidates[n - 2]!.providerId, right: candidates[n - 1]!.providerId, position: 0.5 };
}

/**
 * The comparison kept current with what is drawn: a side whose source is no longer drawn
 * becomes the map as it is (null). Returns the same object when nothing changed.
 */
export function reconcileSplit(split: ImagerySplit, candidates: readonly SplitCandidate[]): ImagerySplit {
  const ids = new Set(candidates.map((c) => c.providerId));
  const left = split.left !== null && !ids.has(split.left) ? null : split.left;
  const right = split.right !== null && !ids.has(split.right) ? null : split.right;
  return left === split.left && right === split.right ? split : { ...split, left, right };
}
