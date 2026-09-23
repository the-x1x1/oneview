import { motionSpeedMps, positionAlong, type RenderFeature, type RenderMotion } from '@worldview/render-core';
import type { GeoBounds, GeoPosition } from '@worldview/world-model';

/**
 * Moving markers in 2D (RenderFeature.motion): which of them move, and where they are now.
 *
 * MapLibre cannot move one point of a GeoJSON source: any change to a source re-indexes all
 * of it in the worker and reloads its tiles. Moving satellites in their own 16.5k-point source
 * held the map at ~20 fps (RENDERING.md, "Satellites between polls in 2D"). So the markers
 * that move are taken out of their layer's source and drawn from a small companion source of
 * their own (`<layer>~moving`), and only that one is replaced each step: the cost of a step is
 * the markers in it, not the layer.
 *
 * What moves: markers with motion inside the view (and a margin around it), no more than
 * `maxActive` of them. A view holding more than that is zoomed out far enough that a step is
 * under a pixel for a long while — the whole globe in view, an aircraft crosses a pixel in a
 * minute — so nothing moves there and the markers are drawn at their reports, as before. The
 * set is chosen again when the view settles, not mid-gesture: every change of it is a change
 * to the big source.
 */
export interface MotionTrack {
  id: string;
  layer: string;
  from: GeoPosition;
  motion: RenderMotion;
  speedMps: number;
}

/** Default most markers moved at once (the companion sources' total). */
export const MAX_MOVING_2D = 1500;
/** The view is widened by this much of its size on each side when choosing what moves. */
const VIEW_MARGIN = 0.25;

export class MotionModel2D {
  private readonly tracks = new Map<string, MotionTrack>();
  private readonly activeIds = new Set<string>();

  get size(): number {
    return this.tracks.size;
  }
  get active(): ReadonlySet<string> {
    return this.activeIds;
  }
  has(id: string): boolean {
    return this.tracks.has(id);
  }
  track(id: string): MotionTrack | undefined {
    return this.tracks.get(id);
  }
  ids(): string[] {
    return [...this.tracks.keys()];
  }

  /** Track a feature that has motion; returns false (and forgets it) when it has none. */
  set(feature: RenderFeature): boolean {
    const m = feature.motion;
    if (!m || feature.geometry.kind !== 'point') {
      this.delete(feature.id);
      return false;
    }
    const from = feature.geometry.position;
    this.tracks.set(feature.id, {
      id: feature.id,
      layer: feature.layer,
      from,
      motion: m,
      speedMps: motionSpeedMps(from, m),
    });
    return true;
  }

  /** Forget a feature; true when it was moving (its marker has to go back to its layer). */
  delete(id: string): boolean {
    this.tracks.delete(id);
    return this.activeIds.delete(id);
  }

  clear(): string[] {
    const was = [...this.activeIds];
    this.tracks.clear();
    this.activeIds.clear();
    return was;
  }

  /**
   * Choose what moves for a view. Returns the markers that start moving (`enter`) and the
   * ones that stop (`leave`); `active` is the new set.
   */
  choose(
    bounds: GeoBounds | undefined,
    nowMs: number,
    maxActive = MAX_MOVING_2D,
  ): { enter: string[]; leave: string[] } {
    const next = new Set<string>();
    if (bounds) {
      const box = widen(bounds, VIEW_MARGIN);
      for (const t of this.tracks.values()) {
        const [lon, lat] = positionAlong(t.from, t.motion, nowMs);
        if (!inBox(box, lon, lat)) continue;
        next.add(t.id);
        if (next.size > maxActive) {
          next.clear();
          break;
        }
      }
    }
    const enter: string[] = [];
    const leave: string[] = [];
    for (const id of next) if (!this.activeIds.has(id)) enter.push(id);
    for (const id of this.activeIds) if (!next.has(id)) leave.push(id);
    this.activeIds.clear();
    for (const id of next) this.activeIds.add(id);
    return { enter, leave };
  }

  /** Where a tracked marker is at `nowMs`, [longitude, latitude]. */
  position(id: string, nowMs: number): [number, number] | undefined {
    const t = this.tracks.get(id);
    return t ? positionAlong(t.from, t.motion, nowMs) : undefined;
  }

  /** The moving markers grouped by layer. */
  activeByLayer(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.activeIds) {
      const t = this.tracks.get(id);
      if (!t) continue;
      let list = out.get(t.layer);
      if (!list) out.set(t.layer, (list = []));
      list.push(id);
    }
    return out;
  }

  /** The fastest moving marker, m/s (0 when nothing moves). */
  maxActiveSpeedMps(): number {
    let max = 0;
    for (const id of this.activeIds) {
      const s = this.tracks.get(id)?.speedMps ?? 0;
      if (s > max) max = s;
    }
    return max;
  }
}

const WEB_MERCATOR_EQUATOR_M = 40_075_016.686;

/**
 * How often the moving markers are stepped in 2D: often enough that the fastest moves half a
 * pixel a step, at most 30 times a second and at least once every two seconds. MapLibre's
 * zoom is for 512-pixel tiles.
 */
export function motionStepMs2d(zoom: number, latitude: number, speedMps: number): number {
  if (!Number.isFinite(zoom) || !(speedMps > 0)) return 2000;
  const mpp =
    (WEB_MERCATOR_EQUATOR_M * Math.cos((Math.max(-85, Math.min(85, latitude)) * Math.PI) / 180)) / (512 * 2 ** zoom);
  return Math.max(1000 / 30, Math.min(2000, (0.5 * mpp * 1000) / speedMps));
}

interface Box {
  west: number;
  east: number;
  south: number;
  north: number;
  /** Crosses the antimeridian (west > east after widening). */
  wraps: boolean;
  all: boolean;
}

function widen(b: GeoBounds, margin: number): Box {
  let width = b.east - b.west;
  if (width < 0) width += 360;
  const height = b.north - b.south;
  const south = Math.max(-90, b.south - height * margin);
  const north = Math.min(90, b.north + height * margin);
  const grown = width * (1 + 2 * margin);
  if (grown >= 360) return { west: -180, east: 180, south, north, wraps: false, all: true };
  let west = b.west - width * margin;
  let east = b.east + width * margin;
  if (west < -180) west += 360;
  if (east > 180) east -= 360;
  return { west, east, south, north, wraps: west > east, all: false };
}

function inBox(box: Box, lon: number, lat: number): boolean {
  if (lat < box.south || lat > box.north) return false;
  if (box.all) return true;
  return box.wraps ? lon >= box.west || lon <= box.east : lon >= box.west && lon <= box.east;
}
