import { EARTH_RADIUS_M, haversineMeters, type GeoPosition } from '@worldview/world-model';

/**
 * Where a flight is along its planned route: which leg it is on, how far it has come and
 * how far it has to go, and when it might arrive — and the path still to fly, for the map.
 * Pure spherical geometry (the world-model's haversine and its Earth radius), no provider
 * or renderer types, shared by the context panel and presentation.
 *
 * All of it is an estimate. Distances are great-circle — the shortest path over the Earth —
 * while real flights follow airways, holds and approaches, so the true distance is longer;
 * the time is that distance at the current ground speed, which changes with the wind and
 * the descent. The panel labels it as such.
 */
const DEG = Math.PI / 180;

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface RouteProgress {
  /** Index of the leg the aircraft is on: from `airports[leg]` to `airports[leg + 1]`. */
  leg: number;
  /** Great-circle distance along the route from the origin to the aircraft (legs flown + this leg so far). */
  flownM: number;
  /** From the aircraft to the end of the current leg (the next stop or the destination). */
  toNextM: number;
  /** From the aircraft to the final destination, through any remaining stops. */
  remainingM: number;
  /** The whole route, airport to airport. */
  totalM: number;
  /**
   * How far off the leg the aircraft is: how much longer origin → aircraft → next airport is
   * than the leg itself. Large (hundreds of km) when the route does not fit the flight.
   */
  detourM: number;
}

/**
 * The aircraft's progress along a route of two or more airports. The leg is the one the
 * position fits best — the smallest detour — so a flight between its stop and its
 * destination is on the second leg. Undefined for fewer than two airports.
 */
export function routeProgress(position: RoutePoint, airports: readonly RoutePoint[]): RouteProgress | undefined {
  if (airports.length < 2) return undefined;
  const legs: number[] = [];
  for (let i = 0; i + 1 < airports.length; i++) legs.push(haversineMeters(airports[i]!, airports[i + 1]!));
  let leg = 0;
  let detour = Infinity;
  for (let i = 0; i < legs.length; i++) {
    const d = haversineMeters(airports[i]!, position) + haversineMeters(position, airports[i + 1]!) - legs[i]!;
    if (d < detour - 1) {
      detour = d;
      leg = i;
    }
  }
  const before = legs.slice(0, leg).reduce((a, b) => a + b, 0);
  const after = legs.slice(leg + 1).reduce((a, b) => a + b, 0);
  const toNextM = haversineMeters(position, airports[leg + 1]!);
  return {
    leg,
    flownM: before + haversineMeters(airports[leg]!, position),
    toNextM,
    remainingM: toNextM + after,
    totalM: legs.reduce((a, b) => a + b, 0),
    detourM: Math.max(0, detour),
  };
}

/** Below this ground speed (about 50 kt) an arrival time means nothing: taxiing, holding on the ground. */
export const MIN_ETA_SPEED_MPS = 25;

/** Epoch ms of arrival at `distanceM` away at `speedMps`, or undefined when the speed says nothing. */
export function estimateArrivalMs(distanceM: number, speedMps: number | undefined, nowMs: number): number | undefined {
  if (speedMps === undefined || !Number.isFinite(speedMps) || speedMps < MIN_ETA_SPEED_MPS) return undefined;
  if (!Number.isFinite(distanceM) || distanceM < 0) return undefined;
  return nowMs + (distanceM / speedMps) * 1000;
}

/** The point a fraction `f` of the way from `a` to `b` along the great circle (spherical interpolation). */
export function greatCirclePoint(a: RoutePoint, b: RoutePoint, f: number): RoutePoint {
  const lat1 = a.latitude * DEG;
  const lon1 = a.longitude * DEG;
  const lat2 = b.latitude * DEG;
  const lon2 = b.longitude * DEG;
  const delta = haversineMeters(a, b) / EARTH_RADIUS_M;
  if (delta < 1e-9) return { latitude: a.latitude, longitude: a.longitude };
  const A = Math.sin((1 - f) * delta) / Math.sin(delta);
  const B = Math.sin(f * delta) / Math.sin(delta);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return {
    latitude: Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG,
    longitude: normaliseLongitude(Math.atan2(y, x) / DEG),
  };
}

/**
 * The great circle from `a` to `b` as points at most `stepM` apart, both ends included,
 * longitudes in [-180, 180] — a line that crosses the antimeridian jumps there, and the
 * renderers' presentation cuts it (presentation.ts `splitAtAntimeridian`).
 */
export function greatCirclePath(a: RoutePoint, b: RoutePoint, stepM = 100_000): RoutePoint[] {
  const d = haversineMeters(a, b);
  const n = Math.max(1, Math.min(512, Math.ceil(d / Math.max(1_000, stepM))));
  const out: RoutePoint[] = [];
  out.push({ latitude: a.latitude, longitude: a.longitude });
  for (let i = 1; i < n; i++) out.push(greatCirclePoint(a, b, i / n));
  out.push({ latitude: b.latitude, longitude: b.longitude });
  return out;
}

/**
 * The path still to fly: from `position` along the great circle to the end of `leg`, then on
 * through any later airports. Altitudes: the aircraft's own at the start, falling in a
 * straight line to the next airport's elevation (or 0) at its end — a way to draw the line
 * from the aircraft down to the airport, not a descent profile — and the later legs on the
 * ground.
 */
export function remainingPath(
  position: RoutePoint & { altitudeM?: number },
  airports: ReadonlyArray<RoutePoint & { elevationM?: number }>,
  leg: number,
  stepM = 100_000,
): GeoPosition[] {
  const next = airports[leg + 1];
  if (!next) return [];
  const first = greatCirclePath(position, next, stepM);
  const startAlt = position.altitudeM !== undefined && Number.isFinite(position.altitudeM) ? position.altitudeM : 0;
  const endAlt = next.elevationM ?? 0;
  const out: GeoPosition[] = first.map((p, i) => ({
    ...p,
    altitudeM: startAlt + ((endAlt - startAlt) * i) / Math.max(1, first.length - 1),
  }));
  for (let i = leg + 1; i + 1 < airports.length; i++) {
    const seg = greatCirclePath(airports[i]!, airports[i + 1]!, stepM);
    for (const p of seg.slice(1)) out.push({ ...p, altitudeM: 0 });
  }
  return out;
}

function normaliseLongitude(lon: number): number {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}
