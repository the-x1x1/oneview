import { isValidLatLon, type GeoPosition, type JsonValue, type WorldGeometry } from '@worldview/world-model';
import { parsePath, readPath, type PathSegment } from './path.js';
import { resolveTransform, type Transform } from './transforms.js';

/**
 * The mapping language: how a connector definition turns one source record into the parts
 * of an observation. Declarative, closed and small on purpose (directive §7, §90): field
 * paths, literals, fallbacks, a registry of named transforms, and a fixed set of shapes for
 * a position. A source that needs more than this needs a custom provider, not a bigger DSL.
 *
 * A `Field` is a path string, or an object:
 *   { path, fallback?: path | path[], literal?, transform?: name | name[], default?, required? }
 * The first of `path` and `fallback`s that has a value is taken, `transform`s applied in
 * order; when nothing is found, `default` (a literal) is used; `required` makes a missing
 * value reject the record instead of leaving the field out.
 */
export interface FieldSpec {
  path?: string;
  fallback?: string | string[];
  literal?: JsonValue;
  transform?: string | string[];
  default?: JsonValue;
  required?: boolean;
}
export type Field = string | FieldSpec;

export type PositionSpec =
  | { lat: Field; lon: Field; alt?: Field }
  /**
   * A GeoJSON geometry (Point: its coordinates; anything else: its first coordinate), or a
   * `[lon, lat]` (GeoJSON order) or `[lat, lon]` pair. A third coordinate is the altitude in
   * metres unless `altitude: false` (USGS puts the depth in kilometres there).
   */
  | { geometry: Field; altitude?: boolean }
  | { lonLat: Field; altitude?: boolean }
  | { latLon: Field; altitude?: boolean };

/** A record is kept only when every condition holds. */
export interface Condition {
  path: string;
  equals?: JsonValue;
  notEquals?: JsonValue;
  in?: JsonValue[];
  exists?: boolean;
  /** Numeric bounds, inclusive. */
  min?: number;
  max?: number;
}

export interface MappingSpec {
  externalId: Field;
  /** The observation's time; the fetch time when absent or unreadable (flagged `fetch-time`). */
  observedAt?: Field;
  position?: PositionSpec;
  /** A GeoJSON geometry for line and area objects. */
  geometry?: Field;
  labels?: Record<string, Field>;
  properties?: Record<string, Field>;
  /** Motion in SI: written to the properties the state engine reads. */
  motion?: { speedMps?: Field; headingDegrees?: Field; verticalSpeedMps?: Field };
  filter?: Condition[];
}

export const MAX_MAPPED_FIELDS = 128;
const LABEL_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

// ── compiled form ────────────────────────────────────────────────────────────

interface CompiledField {
  paths: PathSegment[][];
  literal: JsonValue | undefined;
  hasLiteral: boolean;
  transforms: Transform[];
  defaultValue: JsonValue | undefined;
  hasDefault: boolean;
  required: boolean;
  /** For messages. */
  name: string;
}

interface CompiledPosition {
  kind: 'latlon' | 'geometry' | 'lonLat' | 'latLon';
  lat?: CompiledField;
  lon?: CompiledField;
  alt?: CompiledField;
  one?: CompiledField;
  /** Whether a third coordinate is taken as the altitude. */
  altitude: boolean;
}

export interface CompiledMapping {
  externalId: CompiledField;
  observedAt?: CompiledField;
  position?: CompiledPosition;
  geometry?: CompiledField;
  labels: Array<[string, CompiledField]>;
  properties: Array<[string, CompiledField]>;
  filter: Array<Condition & { segments: PathSegment[] }>;
}

export class MappingError extends Error {
  constructor(
    message: string,
    readonly at: string,
  ) {
    super(`${at}: ${message}`);
    this.name = 'MappingError';
  }
}

function compileField(spec: Field | undefined, name: string, required = false): CompiledField {
  if (spec === undefined) throw new MappingError('missing', name);
  const f: FieldSpec = typeof spec === 'string' ? { path: spec } : spec;
  if (typeof f !== 'object' || f === null || Array.isArray(f))
    throw new MappingError('must be a path or an object', name);
  const paths: PathSegment[][] = [];
  const add = (p: unknown, what: string) => {
    if (typeof p !== 'string') throw new MappingError(`${what} must be a path string`, name);
    try {
      paths.push(parsePath(p));
    } catch (err) {
      throw new MappingError(`${what}: ${err instanceof Error ? err.message : String(err)}`, name);
    }
  };
  if (f.path !== undefined) add(f.path, 'path');
  if (f.fallback !== undefined)
    for (const p of Array.isArray(f.fallback) ? f.fallback : [f.fallback]) add(p, 'fallback');
  const hasLiteral = Object.prototype.hasOwnProperty.call(f, 'literal');
  if (!hasLiteral && paths.length === 0) throw new MappingError('needs a path or a literal', name);
  if (hasLiteral && paths.length) throw new MappingError('has both a literal and a path', name);
  const transforms: Transform[] = [];
  for (const t of f.transform === undefined ? [] : Array.isArray(f.transform) ? f.transform : [f.transform]) {
    if (typeof t !== 'string') throw new MappingError('transform names must be strings', name);
    const fn = resolveTransform(t);
    if (!fn) throw new MappingError(`unknown transform "${t}"`, name);
    transforms.push(fn);
  }
  if (transforms.length > 8) throw new MappingError('more than 8 transforms', name);
  return {
    paths,
    literal: f.literal,
    hasLiteral,
    transforms,
    defaultValue: f.default,
    hasDefault: Object.prototype.hasOwnProperty.call(f, 'default'),
    required: f.required === true || required,
    name,
  };
}

function compileMap(map: Record<string, Field> | undefined, what: string): Array<[string, CompiledField]> {
  if (map === undefined) return [];
  if (typeof map !== 'object' || map === null || Array.isArray(map)) throw new MappingError('must be an object', what);
  const out: Array<[string, CompiledField]> = [];
  for (const [key, spec] of Object.entries(map)) {
    if (!LABEL_KEY.test(key)) throw new MappingError(`bad key "${key}"`, what);
    out.push([key, compileField(spec, `${what}.${key}`)]);
  }
  return out;
}

export function compileMapping(spec: MappingSpec): CompiledMapping {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec))
    throw new MappingError('must be an object', 'mapping');
  const externalId = compileField(spec.externalId, 'mapping.externalId', true);
  const observedAt = spec.observedAt === undefined ? undefined : compileField(spec.observedAt, 'mapping.observedAt');
  let position: CompiledPosition | undefined;
  if (spec.position !== undefined) {
    const p = spec.position as Record<string, Field>;
    if (typeof p !== 'object' || p === null) throw new MappingError('must be an object', 'mapping.position');
    if ('lat' in p && 'lon' in p)
      position = {
        kind: 'latlon',
        lat: compileField(p['lat'], 'mapping.position.lat'),
        lon: compileField(p['lon'], 'mapping.position.lon'),
        ...(p['alt'] !== undefined ? { alt: compileField(p['alt'], 'mapping.position.alt') } : {}),
        altitude: true,
      };
    else {
      const altitude = (p as { altitude?: unknown })['altitude'] !== false;
      if ('geometry' in p)
        position = { kind: 'geometry', one: compileField(p['geometry'], 'mapping.position.geometry'), altitude };
      else if ('lonLat' in p)
        position = { kind: 'lonLat', one: compileField(p['lonLat'], 'mapping.position.lonLat'), altitude };
      else if ('latLon' in p)
        position = { kind: 'latLon', one: compileField(p['latLon'], 'mapping.position.latLon'), altitude };
      else throw new MappingError('needs lat+lon, geometry, lonLat or latLon', 'mapping.position');
    }
  }
  const geometry = spec.geometry === undefined ? undefined : compileField(spec.geometry, 'mapping.geometry');
  const labels = compileMap(spec.labels, 'mapping.labels');
  const properties = compileMap(spec.properties, 'mapping.properties');
  if (spec.motion !== undefined) {
    const m = spec.motion;
    if (typeof m !== 'object' || m === null) throw new MappingError('must be an object', 'mapping.motion');
    for (const key of ['speedMps', 'headingDegrees', 'verticalSpeedMps'] as const)
      if (m[key] !== undefined) properties.push([key, compileField(m[key], `mapping.motion.${key}`)]);
  }
  if (labels.length + properties.length > MAX_MAPPED_FIELDS)
    throw new MappingError(`more than ${MAX_MAPPED_FIELDS} fields`, 'mapping');
  const filter: CompiledMapping['filter'] = [];
  for (const [i, c] of (spec.filter ?? []).entries()) {
    if (typeof c !== 'object' || c === null || typeof c.path !== 'string')
      throw new MappingError('needs a path', `mapping.filter[${i}]`);
    let segments: PathSegment[];
    try {
      segments = parsePath(c.path);
    } catch (err) {
      throw new MappingError(err instanceof Error ? err.message : String(err), `mapping.filter[${i}]`);
    }
    filter.push({ ...c, segments });
  }
  return {
    externalId,
    ...(observedAt ? { observedAt } : {}),
    ...(position ? { position } : {}),
    ...(geometry ? { geometry } : {}),
    labels,
    properties,
    filter,
  };
}

// ── evaluation ───────────────────────────────────────────────────────────────

export class FieldMissing extends Error {
  constructor(readonly field: string) {
    super(`${field}: required value missing`);
    this.name = 'FieldMissing';
  }
}

export function readField(record: unknown, f: CompiledField): JsonValue | undefined {
  let value: JsonValue | undefined;
  if (f.hasLiteral) value = f.literal;
  else
    for (const p of f.paths) {
      const v = readPath(record, p);
      if (v !== undefined && v !== null) {
        value = v;
        break;
      }
    }
  if (value !== undefined && value !== null)
    for (const t of f.transforms) {
      value = t(value);
      if (value === undefined || value === null) break;
    }
  if (value === undefined || value === null) {
    if (f.hasDefault) return f.defaultValue;
    if (f.required) throw new FieldMissing(f.name);
    return undefined;
  }
  return value;
}

function conditionHolds(record: unknown, c: CompiledMapping['filter'][number]): boolean {
  const v = readPath(record, c.segments);
  if (c.exists !== undefined && (v !== undefined) !== c.exists) return false;
  if (c.equals !== undefined && !same(v, c.equals)) return false;
  if (c.notEquals !== undefined && same(v, c.notEquals)) return false;
  if (c.in !== undefined && !c.in.some((x) => same(v, x))) return false;
  if (c.min !== undefined || c.max !== undefined) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return false;
    if (c.min !== undefined && n < c.min) return false;
    if (c.max !== undefined && n > c.max) return false;
  }
  return true;
}

function same(a: JsonValue | undefined, b: JsonValue): boolean {
  if (a === undefined) return b === null;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  // A number in the record and its string in the definition (or the reverse) are the same value.
  return a === b || String(a) === String(b);
}

const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
]);

function firstCoordinate(coords: unknown): [number, number, number | undefined] | undefined {
  if (!Array.isArray(coords) || coords.length === 0) return undefined;
  if (typeof coords[0] === 'number') {
    const [lon, lat, alt] = coords as unknown[];
    return typeof lon === 'number' && typeof lat === 'number'
      ? [lon, lat, typeof alt === 'number' ? alt : undefined]
      : undefined;
  }
  return firstCoordinate(coords[0]);
}

function toPosition(lat: unknown, lon: unknown, alt: unknown): GeoPosition | undefined {
  const la = typeof lat === 'string' ? Number(lat) : lat;
  const lo = typeof lon === 'string' ? Number(lon) : lon;
  if (!isValidLatLon(la, lo)) return undefined;
  const out: GeoPosition = { latitude: la, longitude: lo as number };
  const a = typeof alt === 'string' ? Number(alt) : alt;
  if (typeof a === 'number' && Number.isFinite(a) && Math.abs(a) < 1_000_000) out.altitudeM = a;
  return out;
}

export function readPosition(record: unknown, p: CompiledPosition): GeoPosition | undefined {
  switch (p.kind) {
    case 'latlon':
      return toPosition(
        readField(record, p.lat!),
        readField(record, p.lon!),
        p.alt ? readField(record, p.alt) : undefined,
      );
    case 'geometry': {
      const g = readField(record, p.one!);
      if (!g || typeof g !== 'object' || Array.isArray(g)) return undefined;
      const c = firstCoordinate((g as { coordinates?: unknown }).coordinates);
      return c ? toPosition(c[1], c[0], p.altitude ? c[2] : undefined) : undefined;
    }
    case 'lonLat': {
      const c = firstCoordinate(readField(record, p.one!));
      return c ? toPosition(c[1], c[0], p.altitude ? c[2] : undefined) : undefined;
    }
    case 'latLon': {
      const c = firstCoordinate(readField(record, p.one!));
      return c ? toPosition(c[0], c[1], p.altitude ? c[2] : undefined) : undefined;
    }
  }
}

/** A GeoJSON geometry, checked to be one of the six types with numeric coordinates. */
export function readGeometry(record: unknown, f: CompiledField): WorldGeometry | undefined {
  const g = readField(record, f);
  if (!g || typeof g !== 'object' || Array.isArray(g)) return undefined;
  const type = (g as { type?: unknown }).type;
  const coordinates = (g as { coordinates?: unknown }).coordinates;
  if (typeof type !== 'string' || !GEOMETRY_TYPES.has(type) || !Array.isArray(coordinates)) return undefined;
  if (!finiteNumbers(coordinates, 0)) return undefined;
  return { type, coordinates } as WorldGeometry;
}

function finiteNumbers(v: unknown, depth: number): boolean {
  if (depth > 6) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (!Array.isArray(v)) return false;
  return v.every((x) => finiteNumbers(x, depth + 1));
}

export interface MappedRecord {
  externalId: string;
  observedAt?: string;
  position?: GeoPosition;
  geometry?: WorldGeometry;
  labels: Record<string, string>;
  properties: Record<string, JsonValue>;
}

export type MapResult =
  { ok: true; record: MappedRecord } | { ok: false; reason: string } | { ok: false; skipped: true };

/** Any non-blank string up to 256 characters; identity resolution encodes what the id grammar refuses (a URN's `:` included). */
const ID_VALUE = /^\S{1,256}$/;

/** One record through the mapping: a mapped record, a rejection with its reason, or a filtered-out skip. */
export function mapRecord(record: unknown, m: CompiledMapping): MapResult {
  if (record === null || typeof record !== 'object') return { ok: false, reason: 'record is not an object' };
  for (const c of m.filter) if (!conditionHolds(record, c)) return { ok: false, skipped: true };
  try {
    const idRaw = readField(record, m.externalId);
    const externalId = idRaw === undefined ? '' : String(idRaw).trim();
    if (!ID_VALUE.test(externalId))
      return { ok: false, reason: `externalId ${JSON.stringify(externalId).slice(0, 40)} is not usable` };
    const out: MappedRecord = { externalId, labels: {}, properties: {} };
    if (m.observedAt) {
      const t = readField(record, m.observedAt);
      if (typeof t === 'string' && Number.isFinite(Date.parse(t)))
        out.observedAt = new Date(Date.parse(t)).toISOString();
      else if (typeof t === 'number') {
        const iso = resolveTransform('unixSeconds')!(t > 1e11 ? t / 1000 : t);
        if (typeof iso === 'string') out.observedAt = iso;
      }
    }
    if (m.position) {
      const p = readPosition(record, m.position);
      if (p) out.position = p;
    }
    if (m.geometry) {
      const g = readGeometry(record, m.geometry);
      if (g) out.geometry = g;
    }
    for (const [key, f] of m.labels) {
      const v = readField(record, f);
      if (v !== undefined && v !== null && typeof v !== 'object') out.labels[key] = String(v).slice(0, 256);
    }
    for (const [key, f] of m.properties) {
      const v = readField(record, f);
      if (v !== undefined) out.properties[key] = v;
    }
    return { ok: true, record: out };
  } catch (err) {
    if (err instanceof FieldMissing) return { ok: false, reason: err.message };
    throw err;
  }
}
