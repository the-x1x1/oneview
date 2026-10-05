import { geodesicInverse, geodesicPolygonArea, haversineMeters, type GeoPosition } from '@worldview/world-model';
import { splitAtAntimeridian, type RenderFeature } from '@worldview/render-core';

/**
 * The measure tool (M, or the ruler under the map controls): click points on the globe or the
 * flat map and read the distance along them and each leg's initial bearing — on the WGS84
 * ellipsoid (world-model geodesic.ts), as survey and navigation tools give them. With Area on
 * the shape is closed back to the first point and the area it encloses is given too, unless
 * its outline crosses itself. All of it is computed here, from the points — nothing is looked
 * up. The line is drawn along the great circle (densified, cut at 180°), so on the flat map it
 * curves as a real route does.
 */
export const MEASURE_LAYER = 'measure';
export const MEASURE_MAX_POINTS = 64;
const DEG = Math.PI / 180;
/** A great-circle leg is drawn with a vertex at least every this many metres. */
const DENSIFY_STEP_M = 50_000;
const MAX_VERTICES_PER_LEG = 128;

export interface MeasureLeg {
  from: GeoPosition;
  to: GeoPosition;
  distanceM: number;
  /** Initial great-circle bearing from `from`, degrees clockwise from true north. */
  bearingDeg: number;
}

export interface MeasureSummary {
  legs: MeasureLeg[];
  /** Along the legs; with the shape closed, its perimeter. */
  totalM: number;
}

/** Initial bearing of the great circle from `a` to `b`, degrees in [0, 360). */
export function initialBearingDeg(a: GeoPosition, b: GeoPosition): number {
  const φ1 = a.latitude * DEG,
    φ2 = b.latitude * DEG,
    Δλ = (b.longitude - a.longitude) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

/**
 * The legs between the points, in order, with their ellipsoidal distances and initial bearings;
 * `closed` (three points or more) adds the leg from the last point back to the first.
 */
export function measureSummary(points: readonly GeoPosition[], closed = false): MeasureSummary {
  const legs: MeasureLeg[] = [];
  let totalM = 0;
  const n = closed && points.length >= 3 ? points.length + 1 : points.length;
  for (let i = 1; i < n; i++) {
    const from = points[i - 1]!,
      to = points[i % points.length]!;
    const g = geodesicInverse(from, to);
    totalM += g.distanceM;
    legs.push({ from, to, distanceM: g.distanceM, bearingDeg: g.initialBearingDeg });
  }
  return { legs, totalM };
}

/**
 * The area the points enclose, closed back to the first: undefined below three points, and
 * `crossing` when the outline crosses itself — its lobes would count against each other, so
 * no figure is given.
 */
export function measureArea(points: readonly GeoPosition[]): { areaM2: number } | { crossing: true } | undefined {
  if (points.length < 3) return undefined;
  if (outlineCrosses(points)) return { crossing: true };
  return { areaM2: geodesicPolygonArea(points) };
}

type Vec = readonly [number, number, number];
const vec = (p: GeoPosition): Vec => {
  const φ = p.latitude * DEG,
    λ = p.longitude * DEG;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
};
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Whether great-circle arcs a→b and c→d meet away from their ends. */
function arcsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const n1 = cross(a, b),
    n2 = cross(c, d);
  const line = cross(n1, n2);
  const len = Math.hypot(line[0], line[1], line[2]);
  if (len < 1e-12) return false; // on one great circle: overlapping, not crossing
  for (const sgn of [1, -1]) {
    const p: Vec = [(sgn * line[0]) / len, (sgn * line[1]) / len, (sgn * line[2]) / len];
    const within = (s: Vec, e: Vec, n: Vec) => dot(cross(s, p), n) > 1e-12 && dot(cross(p, e), n) > 1e-12;
    if (within(a, b, n1) && within(c, d, n2)) return true;
  }
  return false;
}

/** Whether the closed outline through the points crosses itself (any two legs that do not share a point). */
export function outlineCrosses(points: readonly GeoPosition[]): boolean {
  const v = points.map(vec);
  const n = v.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the closing leg meets the first at point 0
      if (arcsCross(v[i]!, v[(i + 1) % n]!, v[j]!, v[(j + 1) % n]!)) return true;
    }
  return false;
}

/**
 * A closed shape's outline as drawn — each leg along its great circle — as at most `maxPoints`
 * points, not closed: what a watch zone made from the measured shape must hold, since a zone is
 * tested in plain longitude and latitude, where a long leg's straight line strays from the arc
 * the map drew (60° N, 0° to 40° E: 170 km).
 */
export function densifyRing(points: readonly GeoPosition[], maxPoints = 10_000): GeoPosition[] {
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) perimeter += haversineMeters(points[i]!, points[(i + 1) % points.length]!);
  const step = Math.max(DENSIFY_STEP_M / 5, perimeter / (maxPoints * 0.9));
  const out: GeoPosition[] = [];
  for (let i = 0; i < points.length; i++) {
    const leg = greatCircle(points[i]!, points[(i + 1) % points.length]!, step);
    out.push(...leg.slice(0, -1));
  }
  return out.length <= maxPoints ? out : out.filter((_, i) => i % Math.ceil(out.length / maxPoints) === 0);
}

/** Points along the great circle from `a` to `b` (both included), spherical interpolation. */
export function greatCircle(a: GeoPosition, b: GeoPosition, stepM = DENSIFY_STEP_M): GeoPosition[] {
  const d = haversineMeters(a, b);
  const n = Math.min(MAX_VERTICES_PER_LEG, Math.max(1, Math.ceil(d / stepM)));
  if (n === 1) return [plain(a), plain(b)];
  const toVec = (p: GeoPosition) => {
    const φ = p.latitude * DEG,
      λ = p.longitude * DEG;
    return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)] as const;
  };
  const va = toVec(a),
    vb = toVec(b);
  const ω = Math.acos(Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
  if (!(ω > 1e-12)) return [plain(a), plain(b)];
  const out: GeoPosition[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s1 = Math.sin((1 - t) * ω) / Math.sin(ω),
      s2 = Math.sin(t * ω) / Math.sin(ω);
    const x = s1 * va[0] + s2 * vb[0],
      y = s1 * va[1] + s2 * vb[1],
      z = s1 * va[2] + s2 * vb[2];
    out.push({ latitude: Math.atan2(z, Math.hypot(x, y)) / DEG, longitude: Math.atan2(y, x) / DEG });
  }
  out[0] = plain(a);
  out[out.length - 1] = plain(b);
  return out;
}

/** "12.4 km", "850 m", "1,204 km". */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
}

/** "8,500 m²", "12.31 km²", "438.2 km²", "1,204,301 km²". */
export function formatArea(m2: number): string {
  if (m2 < 1e6) return `${Math.round(m2).toLocaleString('en-US')} m²`;
  const km2 = m2 / 1e6;
  if (km2 < 100) return `${km2.toFixed(2)} km²`;
  if (km2 < 10_000) return `${km2.toFixed(1)} km²`;
  return `${Math.round(km2).toLocaleString('en-US')} km²`;
}

/** Beside it: hectares and acres for a field, square nautical and statute miles for anything larger. */
export function formatAreaAlt(m2: number): string {
  const f = (v: number) => (v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
  if (m2 < 1e7) return `${f(m2 / 10_000)} ha · ${f(m2 / 4046.8564224)} ac`;
  return `${f(m2 / (1852 * 1852))} nmi² · ${f(m2 / (1609.344 * 1609.344))} mi²`;
}

/** Nautical miles and statute miles beside the kilometres: "6.7 nm · 7.7 mi". */
export function formatDistanceAlt(m: number): string {
  const nm = m / 1852,
    mi = m / 1609.344;
  const f = (v: number) => (v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
  return `${f(nm)} nm · ${f(mi)} mi`;
}

/**
 * The measured line and its points as map features (layer `measure`, never pick targets);
 * `closed` adds the leg back to the first point, dashed.
 */
export function measureFeatures(points: readonly GeoPosition[], closed = false): RenderFeature[] {
  const out: RenderFeature[] = [];
  if (closed && points.length >= 3)
    splitAtAntimeridian(greatCircle(points.at(-1)!, points[0]!)).forEach((piece, i) => {
      if (piece.length < 2) return;
      out.push({
        id: `measure:closing${i ? `:${i}` : ''}`,
        geometry: { kind: 'line', positions: piece },
        style: { styleClass: 'measure', lineStyle: 'dashed', size: 2 },
        interactive: false,
        priority: 95,
        layer: MEASURE_LAYER,
      });
    });
  if (points.length >= 2) {
    const path: GeoPosition[] = [];
    for (let i = 1; i < points.length; i++) {
      const leg = greatCircle(points[i - 1]!, points[i]!);
      path.push(...(i === 1 ? leg : leg.slice(1)));
    }
    splitAtAntimeridian(path).forEach((piece, i) => {
      if (piece.length < 2) return;
      out.push({
        id: `measure:line${i ? `:${i}` : ''}`,
        geometry: { kind: 'line', positions: piece },
        style: { styleClass: 'measure', lineStyle: 'solid', size: 3 },
        interactive: false,
        priority: 95,
        layer: MEASURE_LAYER,
      });
    });
  }
  const { legs } = measureSummary(points);
  let running = 0;
  points.forEach((p, i) => {
    if (i > 0) running += legs[i - 1]!.distanceM;
    out.push({
      id: `measure:point:${i}`,
      geometry: { kind: 'point', position: plain(p) },
      style: {
        styleClass: 'measure.point',
        size: i === 0 || i === points.length - 1 ? 8 : 6,
        ...(i > 0 ? { label: formatDistance(running) } : {}),
        labelPriority: 95,
      },
      interactive: false,
      priority: 96,
      layer: MEASURE_LAYER,
    });
  });
  return out;
}

function plain(p: GeoPosition): GeoPosition {
  return { latitude: p.latitude, longitude: p.longitude };
}
