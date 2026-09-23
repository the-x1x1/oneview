/**
 * Geographic primitives. All coordinates are WGS84 degrees; altitudes are metres.
 * Longitudes are normalised to [-180, 180]. Regions are used by queries, watch zones
 * and worldpacks.
 */

export interface GeoPosition {
  latitude: number;
  longitude: number;
  /** Metres. Datum is declared by `altitudeDatum`; absent altitude means surface/unknown. */
  altitudeM?: number;
  altitudeDatum?: 'ellipsoid' | 'msl' | 'barometric' | 'ground' | 'sea-surface' | 'orbit';
  /** Horizontal accuracy in metres when the source reports it. */
  accuracyM?: number;
}

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type WorldGeometry =
  | { type: 'Point'; coordinates: [number, number] | [number, number, number] }
  | { type: 'MultiPoint'; coordinates: Array<[number, number] | [number, number, number]> }
  | { type: 'LineString'; coordinates: Array<[number, number] | [number, number, number]> }
  | { type: 'MultiLineString'; coordinates: Array<Array<[number, number] | [number, number, number]>> }
  | { type: 'Polygon'; coordinates: Array<Array<[number, number] | [number, number, number]>> }
  | { type: 'MultiPolygon'; coordinates: Array<Array<Array<[number, number] | [number, number, number]>>> };

export type GeoRegion =
  | { kind: 'bounds'; bounds: GeoBounds }
  | { kind: 'circle'; center: GeoPosition; radiusM: number }
  | { kind: 'polygon'; polygon: Array<[number, number]> }
  | {
      kind: 'admin';
      /** Stable admin id such as `iso3166-1:US` or `iso3166-2:US-HI` */ regionId: string;
      bounds?: GeoBounds;
    };

export const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export function normalizeLongitude(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  let x = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
}

export function isValidLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

export function isValidBounds(b: GeoBounds): boolean {
  return (
    Number.isFinite(b.west) &&
    Number.isFinite(b.east) &&
    Number.isFinite(b.south) &&
    Number.isFinite(b.north) &&
    b.south <= b.north &&
    Math.abs(b.south) <= 90 &&
    Math.abs(b.north) <= 90 &&
    Math.abs(b.west) <= 180 &&
    Math.abs(b.east) <= 180
  );
}

/** Great-circle distance in metres (haversine). */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(a.latitude * DEG) * Math.cos(b.latitude * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees [0, 360). */
export function bearingDegrees(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const φ1 = a.latitude * DEG,
    φ2 = b.latitude * DEG,
    Δλ = (b.longitude - a.longitude) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * Pull a viewport rectangle back inside the contract's limits.
 *
 * A renderer's own idea of what it can see routinely lands a hair outside the world:
 * Cesium's `computeViewRectangle` is radians, and ±π converted to degrees is
 * ±180.00000000000003, while MapLibre reports an unwrapped longitude once the map has
 * been dragged past the antimeridian. Either is enough for the IPC validator to reject
 * the whole `world.viewport` call — which it did, silently, for every view wide enough to
 * see the globe, so the backend never learned what the operator was actually looking at.
 * Clamping at the edge of the world is right here rather than merely convenient: the
 * caller is describing a region of the Earth, and the Earth stops at 180.
 */
export function clampBounds(b: GeoBounds): GeoBounds {
  const lat = (v: number) => (Number.isFinite(v) ? Math.max(-90, Math.min(90, v)) : v);
  const lon = (v: number) => (Number.isFinite(v) ? Math.max(-180, Math.min(180, v)) : v);
  return { west: lon(b.west), south: lat(b.south), east: lon(b.east), north: lat(b.north) };
}

/** Bounds may cross the antimeridian (west > east). */
export function boundsContain(b: GeoBounds, p: { latitude: number; longitude: number }): boolean {
  if (p.latitude < b.south || p.latitude > b.north) return false;
  if (b.west <= b.east) return p.longitude >= b.west && p.longitude <= b.east;
  return p.longitude >= b.west || p.longitude <= b.east;
}

export function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  if (a.north < b.south || a.south > b.north) return false;
  const aSplit = a.west > a.east,
    bSplit = b.west > b.east;
  if (!aSplit && !bSplit) return !(a.east < b.west || a.west > b.east);
  if (aSplit && bSplit) return true;
  const [s, n] = aSplit ? [a, b] : [b, a];
  return n.east >= s.west || n.west <= s.east;
}

/** Bounding box of a circle (clamped at the poles; may cross the antimeridian). */
export function circleBounds(center: GeoPosition, radiusM: number): GeoBounds {
  const dLat = radiusM / EARTH_RADIUS_M / DEG;
  const south = Math.max(-90, center.latitude - dLat);
  const north = Math.min(90, center.latitude + dLat);
  const cosLat = Math.cos(center.latitude * DEG);
  if (cosLat < 1e-9 || dLat >= 90) return { west: -180, south, east: 180, north };
  const dLon = Math.min(180, radiusM / (EARTH_RADIUS_M * cosLat) / DEG);
  if (dLon >= 180) return { west: -180, south, east: 180, north };
  return {
    west: normalizeLongitude(center.longitude - dLon),
    south,
    east: normalizeLongitude(center.longitude + dLon),
    north,
  };
}

export function polygonBounds(ring: Array<[number, number]>): GeoBounds {
  let west = 180,
    east = -180,
    south = 90,
    north = -90;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/** Ray-casting point-in-polygon on lon/lat (planar; adequate for regional polygons that do not cross the antimeridian). */
export function pointInPolygon(p: { latitude: number; longitude: number }, ring: Array<[number, number]>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect =
      yi > p.latitude !== yj > p.latitude && p.longitude < ((xj - xi) * (p.latitude - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function regionBounds(region: GeoRegion): GeoBounds | undefined {
  switch (region.kind) {
    case 'bounds':
      return region.bounds;
    case 'circle':
      return circleBounds(region.center, region.radiusM);
    case 'polygon':
      return polygonBounds(region.polygon);
    case 'admin':
      return region.bounds;
  }
}

/** Exact membership test used as the final filter after a coarse spatial-index lookup. */
export function regionContains(region: GeoRegion, p: { latitude: number; longitude: number }): boolean {
  switch (region.kind) {
    case 'bounds':
      return boundsContain(region.bounds, p);
    case 'circle':
      return haversineMeters(region.center, p) <= region.radiusM;
    case 'polygon':
      return pointInPolygon(p, region.polygon);
    case 'admin':
      return region.bounds ? boundsContain(region.bounds, p) : false;
  }
}

export function geometryCentroid(g: WorldGeometry): GeoPosition | undefined {
  const pts: Array<[number, number] | [number, number, number]> = [];
  switch (g.type) {
    case 'Point':
      pts.push(g.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      pts.push(...g.coordinates);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const r of g.coordinates) pts.push(...r);
      break;
    case 'MultiPolygon':
      for (const poly of g.coordinates) for (const r of poly) pts.push(...r);
      break;
  }
  if (pts.length === 0) return undefined;
  let lat = 0,
    lon = 0;
  for (const p of pts) {
    lon += p[0];
    lat += p[1];
  }
  return { latitude: lat / pts.length, longitude: lon / pts.length };
}

export function positionToGeometry(p: GeoPosition): WorldGeometry {
  return p.altitudeM !== undefined
    ? { type: 'Point', coordinates: [p.longitude, p.latitude, p.altitudeM] }
    : { type: 'Point', coordinates: [p.longitude, p.latitude] };
}

type Coord = [number, number] | [number, number, number];

/**
 * Douglas–Peucker simplification of one closed ring, in degrees (planar, like the rest of
 * this module's polygon helpers). Every vertex within `toleranceDeg` of the simplified
 * outline is dropped; the first and last (closing) vertices always stay. A ring that would
 * fall below a triangle is returned unchanged rather than collapsed — a small island is
 * still land.
 *
 * Coordinates are rounded to `decimals` places (5 is ~1 m), which on its own roughly halves
 * the JSON a polygon takes.
 */
export function simplifyRing<C extends Coord>(ring: readonly C[], toleranceDeg: number, decimals = 5): C[] {
  const round = (c: C): C => {
    const f = 10 ** decimals;
    return c.map((v, i) => (i < 2 ? Math.round(v * f) / f : v)) as C;
  };
  if (ring.length <= 4 || !(toleranceDeg > 0)) return ring.map(round);
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const tol2 = toleranceDeg * toleranceDeg;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i++) {
      const d2 = segmentDistance2(ring[i]!, ring[a]!, ring[b]!);
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  const out: C[] = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(round(ring[i]!));
  return out.length >= 4 ? out : ring.map(round);
}

/** Squared distance from `p` to segment `a`–`b` (to `a` itself when the segment is a point, as a closed ring's is). */
function segmentDistance2(p: Coord, a: Coord, b: Coord): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}
