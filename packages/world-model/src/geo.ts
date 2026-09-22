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
