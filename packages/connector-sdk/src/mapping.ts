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
  /**
   * Several paths read and joined into one text with `separator` (default ":"), for an id
   * no single field carries — a storm's slot and forecast hour, which stay the same from one
   * advisory to the next where the service's row number does not. Missing if any part is.
   */
  concat?: string[];
  separator?: string;
  transform?: string | string[];
  default?: JsonValue;
  required?: boolean;
}
export type Field = string | FieldSpec;

export type PositionSpec =
  | { lat: Field; lon: Field; alt?: Field }
  /**
   * A GeoJSON geometry (a Point's coordinates; half-way along a line; inside an area; the
   * first of several points), or a
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
  /** `concat`: every one read and joined, instead of the first of `paths` found. */
  parts?: PathSegment[][];
  separator: string;
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
  let parts: PathSegment[][] | undefined;
  if (f.concat !== undefined) {
    if (!Array.isArray(f.concat) || f.concat.length < 2 || f.concat.length > 8)
      throw new MappingError('concat must list 2 to 8 paths', name);
    if (paths.length) throw new MappingError('has both concat and a path', name);
    for (const p of f.concat) add(p, 'concat');
    parts = paths.splice(0);
  }
  if (f.separator !== undefined && (typeof f.separator !== 'string' || f.separator.length > 8))
    throw new MappingError('separator must be text of at most 8 characters', name);
  const hasLiteral = Object.prototype.hasOwnProperty.call(f, 'literal');
  if (!hasLiteral && paths.length === 0 && !parts) throw new MappingError('needs a path or a literal', name);
  if (hasLiteral && (paths.length || parts)) throw new MappingError('has both a literal and a path', name);
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
    ...(parts ? { parts } : {}),
    separator: f.separator ?? ':',
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
  else if (f.parts) {
    const got: string[] = [];
    for (const p of f.parts) {
      const v = readPath(record, p);
      if (v === undefined || v === null || typeof v === 'object') {
        got.length = 0;
        break;
      }
      got.push(String(v));
    }
    value = got.length === f.parts.length ? got.join(f.separator) : undefined;
  } else
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

type Pt = [number, number];

function points(v: unknown): Pt[] {
  if (!Array.isArray(v)) return [];
  const out: Pt[] = [];
  for (const c of v)
    if (
      Array.isArray(c) &&
      typeof c[0] === 'number' &&
      typeof c[1] === 'number' &&
      Number.isFinite(c[0]) &&
      Number.isFinite(c[1])
    )
      out.push([c[0], c[1]]);
  return out;
}

/** Longitudes of a part crossing the antimeridian made continuous (east of 180 rather than west of -180). */
function unwrap(pts: Pt[]): Pt[] {
  let min = Infinity;
  let max = -Infinity;
  for (const [x] of pts) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return max - min > 180 ? pts.map(([x, y]) => [x < 0 ? x + 360 : x, y]) : pts;
}

function wrapLon(x: number): number {
  return x > 180 ? x - 360 : x < -180 ? x + 360 : x;
}

/** Half-way along a line by length (longitude scaled by the cosine of the latitude), on the line itself. */
function lineMiddle(line: Pt[]): { at: Pt; length: number } | undefined {
  if (line.length === 0) return undefined;
  const pts = unwrap(line);
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
    const d = Math.hypot((x1 - x0) * k, y1 - y0);
    seg.push(d);
    total += d;
  }
  if (!(total > 0)) return { at: [wrapLon(pts[0]![0]), pts[0]![1]], length: 0 };
  let left = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i]! || i === seg.length - 1) {
      const t = seg[i]! > 0 ? Math.min(1, left / seg[i]!) : 0;
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      return { at: [wrapLon(x0 + (x1 - x0) * t), y0 + (y1 - y0) * t], length: total };
    }
    left -= seg[i]!;
  }
  return undefined;
}

function inRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A point inside a polygon's outer ring: the ring's centroid when it falls inside (most
 * shapes), otherwise the middle of the widest stretch of the ring along the centroid's
 * latitude (a crescent or an L-shaped warning, whose centroid lies outside it). Holes are
 * not avoided. The area comes back too, for choosing the largest part of a MultiPolygon.
 */
function areaPoint(ring0: Pt[]): { at: Pt; area: number } | undefined {
  if (ring0.length < 3) return undefined;
  const ring = unwrap(ring0);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const f = xj * yi - xi * yj;
    a += f;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  if (Math.abs(a) < 1e-12) return undefined;
  cx /= 3 * a;
  cy /= 3 * a;
  const area = Math.abs(a / 2);
  if (inRing(cx, cy, ring)) return { at: [wrapLon(cx), cy], area };
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > cy !== yj > cy) xs.push(((xj - xi) * (cy - yi)) / (yj - yi) + xi);
  }
  xs.sort((p, q) => p - q);
  let best: Pt | undefined;
  let width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2)
    if (xs[i + 1]! - xs[i]! > width) {
      width = xs[i + 1]! - xs[i]!;
      best = [wrapLon((xs[i]! + xs[i + 1]!) / 2), cy];
    }
  return best ? { at: best, area } : undefined;
}

/**
 * Where a line or an area's marker goes: half-way along a line (the longest, of several),
 * inside an area (the largest, of several), the first of several points. It used to be the
 * first coordinate, which put a forecast cone's marker at its tip, a warning's on one corner
 * and a fire perimeter's on its edge (docs/connectors/hazards.md).
 */
function representativePoint(type: unknown, coords: unknown): [number, number, undefined] | undefined {
  let at: Pt | undefined;
  if (type === 'LineString') at = lineMiddle(points(coords))?.at;
  else if (type === 'MultiLineString' && Array.isArray(coords)) {
    let longest = -1;
    for (const part of coords) {
      const m = lineMiddle(points(part));
      if (m && m.length > longest) {
        longest = m.length;
        at = m.at;
      }
    }
  } else if (type === 'Polygon' && Array.isArray(coords)) at = areaPoint(points(coords[0]))?.at;
  else if (type === 'MultiPolygon' && Array.isArray(coords)) {
    let largest = -1;
    for (const poly of coords) {
      const m = Array.isArray(poly) ? areaPoint(points(poly[0])) : undefined;
      if (m && m.area > largest) {
        largest = m.area;
        at = m.at;
      }
    }
  }
  // To about a decimetre: the arithmetic leaves noise in the last digits (21.30000000017).
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return at ? [round(at[0]), round(at[1]), undefined] : undefined;
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
      const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
      if (type === 'Point' || type === undefined) {
        const c = firstCoordinate(coordinates);
        return c ? toPosition(c[1], c[0], p.altitude ? c[2] : undefined) : undefined;
      }
      const c = representativePoint(type, coordinates) ?? firstCoordinate(coordinates);
      return c ? toPosition(c[1], c[0], undefined) : undefined;
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
