import { haversineMeters, type GeoPosition } from '@worldview/world-model';
import { splitAtAntimeridian, type RenderFeature } from '@worldview/render-core';

/**
 * The measure tool (M, or the ruler under the map controls): click points on the globe or the
 * flat map and read the great-circle distance along them and each leg's initial bearing. All of
 * it is computed here, from the points — nothing is looked up. The line is drawn along the
 * great circle (densified, cut at 180°), so on the flat map it curves as a real route does.
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

export function measureSummary(points: readonly GeoPosition[]): MeasureSummary {
  const legs: MeasureLeg[] = [];
  let totalM = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!,
      to = points[i]!;
    const distanceM = haversineMeters(from, to);
    totalM += distanceM;
    legs.push({ from, to, distanceM, bearingDeg: initialBearingDeg(from, to) });
  }
  return { legs, totalM };
}

/** Points along the great circle from `a` to `b` (both included), spherical interpolation. */
export function greatCircle(a: GeoPosition, b: GeoPosition): GeoPosition[] {
  const d = haversineMeters(a, b);
  const n = Math.min(MAX_VERTICES_PER_LEG, Math.max(1, Math.ceil(d / DENSIFY_STEP_M)));
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

/** Nautical miles and statute miles beside the kilometres: "6.7 nm · 7.7 mi". */
export function formatDistanceAlt(m: number): string {
  const nm = m / 1852,
    mi = m / 1609.344;
  const f = (v: number) => (v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
  return `${f(nm)} nm · ${f(mi)} mi`;
}

/** The measured line and its points as map features (layer `measure`, never pick targets). */
export function measureFeatures(points: readonly GeoPosition[]): RenderFeature[] {
  const out: RenderFeature[] = [];
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
