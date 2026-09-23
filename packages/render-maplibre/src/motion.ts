import type { RenderFeature } from '@worldview/render-core';

/**
 * Moving points on the 2D map (RenderFeature.motion — a satellite's position at this poll
 * and at the next, both SGP4), placed by wall-clock time. The 3D adapter has done this since
 * the motion contract landed; on the 2D map every satellite stood still for fifteen seconds
 * and then jumped ~110 km.
 *
 * The step is taken along the great circle between the two ends (a straight line in
 * longitude/latitude would bend near the poles, where polar orbits spend their time, and
 * wrap wrongly at the antimeridian). Before the first end the point holds there; past the
 * second it carries on for one more step at most (the next poll is late), then holds.
 *
 * Moving a point on a GeoJSON source costs a diff and a re-index in MapLibre's worker, so
 * the 2D map steps less eagerly than the globe: only points inside the view, no more than
 * five times a second, and not at all while so many are in view that the map is showing a
 * continent or more — there a satellite crosses a pixel in several seconds anyway.
 */
export interface Mover {
  from: [number, number];
  to: [number, number];
  fromMs: number;
  toMs: number;
}

/** How far past the second position a late point is carried: one more step. */
const MAX_T = 2;
/** Points stepped at most per step; more in view and the step is skipped. */
export const MAX_MOVED_PER_STEP = 2500;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Low orbit, the fastest thing that moves: ~7.5 km/s over the ground, in metres a millisecond. */
const FASTEST_M_PER_MS = 7.5;

export function moverOf(f: RenderFeature): Mover | undefined {
  const m = f.motion;
  if (!m || f.geometry.kind !== 'point') return undefined;
  if (!(m.toMs > m.fromMs)) return undefined;
  const p = f.geometry.position;
  return {
    from: [p.longitude, p.latitude],
    to: [m.to.longitude, m.to.latitude],
    fromMs: m.fromMs,
    toMs: m.toMs,
  };
}

const RAD = Math.PI / 180;

function unit(lon: number, lat: number): [number, number, number] {
  const cl = Math.cos(lat * RAD);
  return [cl * Math.cos(lon * RAD), cl * Math.sin(lon * RAD), Math.sin(lat * RAD)];
}

/** Where the point is at `nowMs`, as [longitude, latitude]. */
export function positionAt(m: Mover, nowMs: number): [number, number] {
  const t = Math.max(0, Math.min(MAX_T, (nowMs - m.fromMs) / (m.toMs - m.fromMs)));
  if (t === 0) return [m.from[0], m.from[1]];
  const a = unit(m.from[0], m.from[1]);
  const b = unit(m.to[0], m.to[1]);
  // Along the chord, then back onto the sphere: for a step of a degree or two this is the
  // great circle to well under a metre, and it needs no special case at either pole.
  const x = a[0] + (b[0] - a[0]) * t;
  const y = a[1] + (b[1] - a[1]) * t;
  const z = a[2] + (b[2] - a[2]) * t;
  const r = Math.hypot(x, y, z);
  if (r < 1e-9) return [m.from[0], m.from[1]];
  const lat = Math.asin(Math.max(-1, Math.min(1, z / r))) / RAD;
  const lon = Math.atan2(y, x) / RAD;
  return [lon, lat];
}

/**
 * How often to step, from how many metres a pixel covers at the view's zoom and latitude
 * (512-pixel tiles): often enough that the fastest point moves about half a pixel, but never
 * more than five times a second nor less than once every two seconds.
 */
export function motionStepMs2d(zoom: number, latitude: number): number {
  const mpp = (EARTH_CIRCUMFERENCE_M * Math.cos(Math.min(85, Math.abs(latitude)) * RAD)) / (512 * 2 ** zoom);
  if (!Number.isFinite(mpp) || mpp <= 0) return 200;
  return Math.max(200, Math.min(2000, (0.5 * mpp) / FASTEST_M_PER_MS));
}

export interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Inside the view, with a margin of a tenth of its size (a point about to come in moves too). */
export function inView(lon: number, lat: number, b: ViewBounds): boolean {
  const padLat = (b.north - b.south) * 0.1;
  if (lat < b.south - padLat || lat > b.north + padLat) return false;
  const width = b.east - b.west;
  if (width >= 360) return true;
  const padLon = width * 0.1;
  // MapLibre's bounds may run past ±180 when the view crosses the antimeridian.
  let x = lon;
  while (x < b.west - padLon) x += 360;
  while (x > b.east + padLon) x -= 360;
  return x >= b.west - padLon && x <= b.east + padLon;
}

/** Whether any of a mover's step can be in the view: either end, or a step straight across it. */
export function moverInView(m: Mover, b: ViewBounds): boolean {
  if (inView(m.from[0], m.from[1], b) || inView(m.to[0], m.to[1], b)) return true;
  if (Math.abs(m.to[0] - m.from[0]) > 180) return false; // across the antimeridian: the ends decide
  const west = Math.min(m.from[0], m.to[0]);
  const east = Math.max(m.from[0], m.to[0]);
  const south = Math.min(m.from[1], m.to[1]);
  const north = Math.max(m.from[1], m.to[1]);
  return west <= b.east && east >= b.west && south <= b.north && north >= b.south;
}
