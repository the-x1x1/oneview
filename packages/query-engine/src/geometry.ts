import {
  boundsIntersect, circleBounds, geometryCentroid, pointInPolygon, regionBounds, regionContains,
  type GeoBounds, type GeoPosition, type GeoRegion, type WorldGeometry,
} from '@worldview/world-model';

/** All vertices of a geometry as lon/lat pairs. */
export function geometryPoints(g: WorldGeometry): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const push = (c: [number, number] | [number, number, number]) => { out.push([c[0], c[1]]); };
  switch (g.type) {
    case 'Point': push(g.coordinates); break;
    case 'MultiPoint': case 'LineString': g.coordinates.forEach(push); break;
    case 'MultiLineString': case 'Polygon': for (const r of g.coordinates) r.forEach(push); break;
    case 'MultiPolygon': for (const p of g.coordinates) for (const r of p) r.forEach(push); break;
  }
  return out;
}

export function geometryBounds(g: WorldGeometry): GeoBounds | undefined {
  const pts = geometryPoints(g);
  if (pts.length === 0) return undefined;
  let west = 180, east = -180, south = 90, north = -90;
  for (const [lon, lat] of pts) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/** Outer rings of polygon-like geometries. */
function outerRings(g: WorldGeometry): Array<Array<[number, number]>> {
  switch (g.type) {
    case 'Polygon': return g.coordinates[0] ? [g.coordinates[0].map((c) => [c[0], c[1]] as [number, number])] : [];
    case 'MultiPolygon': return g.coordinates.map((p) => p[0]).filter((r): r is NonNullable<typeof r> => r !== undefined).map((r) => r.map((c) => [c[0], c[1]] as [number, number]));
    default: return [];
  }
}

/** Representative points of a region: circle centre, bounds corners + centre, polygon vertices. */
export function regionSamplePoints(region: GeoRegion): GeoPosition[] {
  switch (region.kind) {
    case 'circle': return [region.center];
    case 'polygon': return region.polygon.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
    case 'bounds': return boundsSamples(region.bounds);
    case 'admin': return region.bounds ? boundsSamples(region.bounds) : [];
  }
}

function boundsSamples(b: GeoBounds): GeoPosition[] {
  const midLon = b.west <= b.east ? (b.west + b.east) / 2 : ((b.west + b.east + 360) / 2 + 180) % 360 - 180;
  return [
    { latitude: b.south, longitude: b.west }, { latitude: b.south, longitude: b.east },
    { latitude: b.north, longitude: b.east }, { latitude: b.north, longitude: b.west },
    { latitude: (b.south + b.north) / 2, longitude: midLon },
  ];
}

export function regionCenter(region: GeoRegion): GeoPosition | undefined {
  if (region.kind === 'circle') return region.center;
  const b = regionBounds(region);
  if (!b) return undefined;
  const midLon = b.west <= b.east ? (b.west + b.east) / 2 : ((b.west + b.east + 360) / 2 + 180) % 360 - 180;
  return { latitude: (b.south + b.north) / 2, longitude: midLon };
}

/**
 * Does a geometry intersect a region? Exact for points; for polygons/lines it is
 * true when any vertex lies in the region or any region sample point lies inside the
 * geometry's outer ring. Edge-only crossings with no vertex inside either shape are
 * not detected (documented limitation; adequate for alert polygons and watch zones).
 */
export function geometryIntersectsRegion(g: WorldGeometry, region: GeoRegion): boolean {
  const gb = geometryBounds(g);
  const rb = regionBounds(region);
  if (!gb || !rb) return false;
  if (!boundsIntersect(gb, rb)) return false;
  for (const [lon, lat] of geometryPoints(g)) if (regionContains(region, { latitude: lat, longitude: lon })) return true;
  const rings = outerRings(g);
  if (rings.length === 0) return false;
  for (const p of regionSamplePoints(region)) for (const ring of rings) if (pointInPolygon(p, ring)) return true;
  if (region.kind === 'circle') {
    // Circle whose centre is outside the polygon but whose radius reaches a vertex is caught above;
    // catch the case where the polygon lies fully within the circle's bounds and contains the centre.
    const cb = circleBounds(region.center, region.radiusM);
    for (const ring of rings) if (pointInPolygon(region.center, ring) && boundsIntersect(cb, gb)) return true;
  }
  return false;
}

export function geometryRepresentativePoint(g: WorldGeometry): GeoPosition | undefined {
  if (g.type === 'Point') return { latitude: g.coordinates[1], longitude: g.coordinates[0] };
  return geometryCentroid(g);
}
