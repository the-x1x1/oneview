import {
  boundsContain,
  boundsIntersect,
  geometryCentroid,
  geometrySchema,
  isValidBounds,
  polygonBounds,
  s,
  type GeoBounds,
  type JsonValue,
  type Schema,
  type WorldGeometry,
} from '@worldview/world-model';

/**
 * The slice of GeoJSON a world pack carries: a FeatureCollection of features with a
 * WorldGeometry and a flat JSON properties object. Validated on the way in (builder)
 * and on the way out (registry) with the world-model geometry schema.
 */
export interface PackFeature {
  type: 'Feature';
  id?: string | number;
  geometry: WorldGeometry;
  properties: Record<string, JsonValue>;
}

export interface PackFeatureCollection {
  type: 'FeatureCollection';
  features: PackFeature[];
}

export const packFeatureSchema: Schema<PackFeature> = s.object({
  type: s.literal('Feature'),
  id: s.optional(s.union([s.string({ max: 256 }), s.number()])),
  geometry: geometrySchema,
  properties: s.record(s.json({ maxDepth: 8 }), { max: 256 }),
}) as Schema<PackFeature>;

export const packFeatureCollectionSchema: Schema<PackFeatureCollection> = s.object({
  type: s.literal('FeatureCollection'),
  features: s.array(packFeatureSchema, { max: 2_000_000 }),
}) as Schema<PackFeatureCollection>;

export function parseFeatureCollection(
  value: unknown,
): { ok: true; collection: PackFeatureCollection } | { ok: false; issues: string[] } {
  const r = packFeatureCollectionSchema.parse(value);
  if (r.ok) return { ok: true, collection: r.value };
  return { ok: false, issues: r.issues.slice(0, 20).map((i) => `${i.path || '<root>'}: ${i.message}`) };
}

/** Bounding box of any WorldGeometry. */
export function geometryBounds(g: WorldGeometry): GeoBounds | undefined {
  const ring: Array<[number, number]> = [];
  const push = (c: [number, number] | [number, number, number]) => ring.push([c[0], c[1]]);
  switch (g.type) {
    case 'Point':
      push(g.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      g.coordinates.forEach(push);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const r of g.coordinates) r.forEach(push);
      break;
    case 'MultiPolygon':
      for (const poly of g.coordinates) for (const r of poly) r.forEach(push);
      break;
  }
  if (ring.length === 0) return undefined;
  const b = polygonBounds(ring);
  return isValidBounds(b) ? b : undefined;
}

/**
 * Keep the features that touch `bounds`: points by position, everything else when
 * its bounding box intersects. Features without a usable geometry are dropped.
 */
export function clipFeatureCollection(
  collection: PackFeatureCollection,
  bounds: GeoBounds,
): { collection: PackFeatureCollection; kept: number; dropped: number } {
  const features: PackFeature[] = [];
  let dropped = 0;
  for (const f of collection.features) {
    if (featureTouchesBounds(f, bounds)) features.push(f);
    else dropped++;
  }
  return { collection: { type: 'FeatureCollection', features }, kept: features.length, dropped };
}

export function featureTouchesBounds(feature: PackFeature, bounds: GeoBounds): boolean {
  const g = feature.geometry;
  if (g.type === 'Point') return boundsContain(bounds, { longitude: g.coordinates[0], latitude: g.coordinates[1] });
  const gb = geometryBounds(g);
  if (gb) return boundsIntersect(bounds, gb);
  const c = geometryCentroid(g);
  return c ? boundsContain(bounds, c) : false;
}

export function featurePosition(feature: PackFeature): { latitude: number; longitude: number } | undefined {
  const g = feature.geometry;
  if (g.type === 'Point') return { longitude: g.coordinates[0], latitude: g.coordinates[1] };
  return geometryCentroid(g);
}

export function stringProp(props: Record<string, JsonValue>, key: string): string | undefined {
  const v = props[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function numberProp(props: Record<string, JsonValue>, key: string): number | undefined {
  const v = props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function stringArrayProp(props: Record<string, JsonValue>, key: string): string[] {
  const v = props[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}
