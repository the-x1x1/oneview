import { s, type Schema } from './schema.js';
import { isIsoTimestamp } from './time.js';
import { isValidLatLon, type GeoBounds, type GeoPosition, type GeoRegion, type WorldGeometry } from './geo.js';
import type { Observation, ObservationQuality } from './observation.js';
import type { ObservationReference, Provenance } from './provenance.js';
import type { WorldEvent } from './event.js';
import type { WorldQuery } from './query.js';
import { parseObjectId } from './identifiers.js';

const iso = s.refine(s.string({ max: 40 }), (v) => (isIsoTimestamp(v) ? undefined : 'expected UTC ISO 8601 timestamp (…Z)'));
const idString = s.string({ min: 1, max: 512 });
const typeString = s.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ });

const coord2 = s.tuple([s.number({ min: -180, max: 180 }), s.number({ min: -90, max: 90 })]);
const coord3 = s.tuple([s.number({ min: -180, max: 180 }), s.number({ min: -90, max: 90 }), s.number()]);
const coordinate = s.union([coord2, coord3]);
const ring = s.array(coordinate, { min: 2, max: 100_000 });

export const geometrySchema: Schema<WorldGeometry> = s.union([
  s.object({ type: s.literal('Point'), coordinates: coordinate }),
  s.object({ type: s.literal('MultiPoint'), coordinates: s.array(coordinate, { max: 100_000 }) }),
  s.object({ type: s.literal('LineString'), coordinates: ring }),
  s.object({ type: s.literal('MultiLineString'), coordinates: s.array(ring, { max: 10_000 }) }),
  s.object({ type: s.literal('Polygon'), coordinates: s.array(ring, { min: 1, max: 1000 }) }),
  s.object({ type: s.literal('MultiPolygon'), coordinates: s.array(s.array(ring, { min: 1, max: 1000 }), { max: 10_000 }) }),
]) as Schema<WorldGeometry>;

export const positionSchema: Schema<GeoPosition> = s.refine(
  s.object({
    latitude: s.number({ min: -90, max: 90 }),
    longitude: s.number({ min: -180, max: 180 }),
    altitudeM: s.optional(s.number({ min: -1_000_000, max: 100_000_000 })), // deep-focus earthquakes reach ~700 km; GEO orbit ~36,000 km
    altitudeDatum: s.optional(s.enum(['ellipsoid', 'msl', 'barometric', 'ground', 'sea-surface', 'orbit'] as const)),
    accuracyM: s.optional(s.number({ min: 0 })),
  }),
  (p) => (isValidLatLon(p.latitude, p.longitude) ? undefined : 'invalid latitude/longitude'),
) as Schema<GeoPosition>;

export const boundsSchema: Schema<GeoBounds> = s.refine(
  s.object({ west: s.number({ min: -180, max: 180 }), south: s.number({ min: -90, max: 90 }), east: s.number({ min: -180, max: 180 }), north: s.number({ min: -90, max: 90 }) }),
  (b) => (b.south <= b.north ? undefined : 'south must be <= north'),
);

export const regionSchema: Schema<GeoRegion> = s.union([
  s.object({ kind: s.literal('bounds'), bounds: boundsSchema }),
  s.object({ kind: s.literal('circle'), center: positionSchema, radiusM: s.number({ min: 0, max: 40_000_000 }) }),
  s.object({ kind: s.literal('polygon'), polygon: s.array(coord2, { min: 3, max: 10_000 }) }),
  s.object({ kind: s.literal('admin'), regionId: s.string({ min: 1, max: 64 }), bounds: s.optional(boundsSchema) }),
]) as Schema<GeoRegion>;

export const observationReferenceSchema: Schema<ObservationReference> = s.object({ observationId: idString, providerId: typeString, observedAt: iso });

export const provenanceSchema: Schema<Provenance> = s.object({
  providerId: typeString,
  sourceName: s.string({ min: 1, max: 200 }),
  origin: s.enum(['live', 'cached', 'historical', 'recorded', 'local', 'derived', 'user'] as const),
  sourceRef: s.optional(s.string({ max: 2048 })),
  attribution: s.optional(s.string({ max: 500 })),
  licenseId: s.optional(s.string({ max: 100 })),
  termsUrl: s.optional(s.string({ max: 2048 })),
  receivedAt: iso,
  derivedFrom: s.optional(s.array(observationReferenceSchema, { max: 10_000 })),
});

export const qualitySchema: Schema<ObservationQuality> = s.object({
  positionAccuracyM: s.optional(s.number({ min: 0 })),
  complete: s.boolean(),
  sourceQuality: s.enum(['authoritative', 'crowdsourced', 'derived', 'unknown'] as const),
  flags: s.optional(s.array(s.string({ max: 64 }), { max: 32 })),
});

export const observationSchema: Schema<Observation> = s.refine(
  s.object({
    id: idString,
    providerId: typeString,
    externalId: s.optional(s.string({ min: 1, max: 256 })),
    objectType: typeString,
    observedAt: iso,
    receivedAt: iso,
    effectiveFrom: s.optional(iso),
    effectiveUntil: s.optional(iso),
    position: s.optional(positionSchema),
    geometry: s.optional(geometrySchema),
    payload: s.record(s.json({ maxDepth: 16 }), { max: 512 }),
    quality: qualitySchema,
    rawPayloadHash: s.optional(s.string({ pattern: /^[0-9a-f]{64}$/ })),
    provenance: provenanceSchema,
  }),
  (o) => {
    if (o.provenance.providerId !== o.providerId) return 'provenance.providerId must equal providerId';
    if (o.effectiveFrom && o.effectiveUntil && Date.parse(o.effectiveFrom) > Date.parse(o.effectiveUntil)) return 'effectiveFrom after effectiveUntil';
    return undefined;
  },
) as Schema<Observation>;

export const eventSchema: Schema<WorldEvent> = s.object({
  id: s.refine(idString, (v) => (v.startsWith('event:') ? undefined : 'event ids start with "event:"')),
  type: typeString,
  title: s.string({ min: 1, max: 300 }),
  startAt: iso,
  endAt: s.optional(iso),
  geometry: s.optional(geometrySchema),
  objectIds: s.array(s.refine(idString, (v) => (parseObjectId(v) ? undefined : 'invalid object id')), { max: 100_000 }),
  observationRefs: s.array(observationReferenceSchema, { max: 100_000 }),
  confidence: s.enum(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const),
  severity: s.optional(s.enum(['INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME'] as const)),
  summary: s.string({ max: 2000 }),
  properties: s.optional(s.record(s.json({ maxDepth: 8 }), { max: 256 })),
  provenance: provenanceSchema,
}) as Schema<WorldEvent>;

export const timeRangeSchema = s.refine(s.object({ start: iso, end: iso }), (r) => (Date.parse(r.start) <= Date.parse(r.end) ? undefined : 'start after end'));

export const worldQuerySchema: Schema<WorldQuery> = s.object({
  objectTypes: s.optional(s.array(typeString, { max: 64 })),
  eventTypes: s.optional(s.array(typeString, { max: 64 })),
  text: s.optional(s.string({ max: 500 })),
  region: s.optional(regionSchema),
  time: s.optional(timeRangeSchema),
  filters: s.optional(
    s.array(
      s.object({
        field: s.string({ min: 1, max: 128, pattern: /^[a-zA-Z0-9_.-]+$/ }),
        op: s.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists'] as const),
        value: s.optional(s.json({ maxDepth: 4 })),
      }),
      { max: 64 },
    ),
  ),
  sort: s.optional(s.object({ field: s.string({ min: 1, max: 128 }), direction: s.enum(['asc', 'desc'] as const) })),
  limit: s.optional(s.number({ min: 1, max: 100_000, integer: true })),
  providerIds: s.optional(s.array(typeString, { max: 64 })),
}) as Schema<WorldQuery>;
