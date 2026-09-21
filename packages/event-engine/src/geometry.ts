import type { GeoBounds, WorldGeometry } from '@worldview/world-model';

/** Andrew's monotone chain convex hull on lon/lat pairs (planar; fine for regional clusters). Returns a closed ring. */
export function convexHull(points: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p] as const)).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return [];
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 3) return [];
  hull.push(hull[0]!);
  return hull;
}

export function boundsOfPoints(points: ReadonlyArray<[number, number]>): GeoBounds | undefined {
  if (points.length === 0) return undefined;
  let west = 180, east = -180, south = 90, north = -90;
  for (const [lon, lat] of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

export function boundsPolygon(b: GeoBounds, padDeg = 0): WorldGeometry {
  const w = b.west - padDeg, e = b.east + padDeg, s = Math.max(-90, b.south - padDeg), n = Math.min(90, b.north + padDeg);
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** Convex hull polygon when the points span an area, otherwise a padded bounding box. */
export function footprintGeometry(points: ReadonlyArray<[number, number]>, padDeg = 0.005): WorldGeometry | undefined {
  const hull = convexHull(points);
  if (hull.length >= 4) return { type: 'Polygon', coordinates: [hull] };
  const b = boundsOfPoints(points);
  return b ? boundsPolygon(b, padDeg) : undefined;
}

export function roundCoord(n: number): number { return Math.round(n * 1e5) / 1e5; }
