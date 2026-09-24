import type { JsonValue } from '@worldview/world-model';

/**
 * esriJSON, the ArcGIS REST API's own feature format, read into GeoJSON features so that one
 * definition maps the same records whichever format the server answered in (`f=geojson` on
 * 10.4 and later, `f=json` before that or when `supportedQueryFormats` lacks geoJSON).
 *
 * - Points (`x`, `y`, `z`), multipoints (`points`), polylines (`paths`) and polygons
 *   (`rings`) become the GeoJSON geometry of the same kind; one path is a LineString, several
 *   a MultiLineString; rings are grouped into polygons by orientation (esriJSON: exterior
 *   rings clockwise, holes counter-clockwise), each hole assigned to the smallest exterior
 *   that contains it, and written back in RFC 7946 order (exterior counter-clockwise, holes
 *   clockwise). A hole that no exterior contains is taken as an exterior, as the ArcGIS
 *   clients do.
 * - M values are dropped; Z is kept only when the geometry says it has Z.
 * - `spatialReference` must be WGS 84 (4326) or NAD83 (4269) — the connector always asks for
 *   `outSR=4326`, and a server that answers in another system is reported, not reprojected.
 * - Fields of type `esriFieldTypeDate` hold epoch milliseconds; they become ISO 8601 strings.
 *
 * Nothing here reaches the network or runs anything from the response: it is a pure function
 * of a parsed JSON body.
 */
export interface EsriField {
  name: string;
  type: string;
  alias?: string;
}

export type Position = number[];
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

export interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJsonGeometry | null;
  properties: Record<string, JsonValue>;
}

/** What a query answered: GeoJSON features, whether the server holds more, and what it could not read. */
export interface FeatureSet {
  format: 'geojson' | 'esrijson';
  features: GeoJsonFeature[];
  /** `exceededTransferLimit`, if the server said; undefined when the body did not carry it. */
  exceededTransferLimit: boolean | undefined;
  /** Geometries that could not be read (the feature is kept with a null geometry), a sample with reasons. */
  problems: string[];
}

export const ESRI_DATE_FIELD = 'esriFieldTypeDate';
export const ESRI_OID_FIELD = 'esriFieldTypeOID';
/** WGS 84 and NAD83: the only geographic systems read as longitude/latitude. */
export const SUPPORTED_WKIDS: readonly number[] = Object.freeze([4326, 4269]);
const MAX_PROBLEMS = 5;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── the error envelope ───────────────────────────────────────────────────────

export interface ArcGisErrorBody {
  code: number | undefined;
  message: string;
  details: string[];
}

/**
 * ArcGIS answers many failures with HTTP 200 and `{ "error": { "code", "message", "details" } }`.
 * Returns the error when the body is one.
 */
export function arcgisError(body: unknown): ArcGisErrorBody | undefined {
  if (!isObj(body) || !isObj(body['error'])) return undefined;
  const e = body['error'];
  const code = typeof e['code'] === 'number' ? e['code'] : typeof e['code'] === 'string' ? Number(e['code']) : NaN;
  const details = Array.isArray(e['details'])
    ? e['details'].filter((d): d is string => typeof d === 'string' && d.trim() !== '').slice(0, 3)
    : [];
  return {
    code: Number.isFinite(code) ? code : undefined,
    message: typeof e['message'] === 'string' && e['message'].trim() ? e['message'].trim() : 'no message',
    details,
  };
}

export function describeArcGisError(e: ArcGisErrorBody): string {
  const detail = e.details.filter((d) => d !== e.message).join('; ');
  return `ArcGIS error${e.code !== undefined ? ` ${e.code}` : ''}: ${e.message}${detail ? ` (${detail})` : ''}`;
}

// ── spatial reference ────────────────────────────────────────────────────────

/** Undefined when the spatial reference is absent or WGS 84 / NAD83; otherwise why it is refused. */
export function spatialReferenceProblem(sr: unknown): string | undefined {
  if (sr === undefined || sr === null) return undefined;
  if (!isObj(sr)) return 'spatialReference is not an object';
  const ids = [sr['latestWkid'], sr['wkid']].filter(finite);
  if (ids.some((id) => SUPPORTED_WKIDS.includes(id))) return undefined;
  if (ids.length) return `spatialReference wkid ${ids[0]} is not 4326 or 4269 (outSR=4326 was asked for)`;
  if (typeof sr['wkt'] === 'string') return 'spatialReference is given as WKT, not as wkid 4326 or 4269';
  return undefined;
}

/** The old GeoJSON `crs` member: absent, CRS84, EPSG 4326 or 4269 are fine; anything else is refused. */
export function geoJsonCrsProblem(crs: unknown): string | undefined {
  if (crs === undefined || crs === null) return undefined;
  const name = isObj(crs) && isObj(crs['properties']) ? crs['properties']['name'] : undefined;
  if (typeof name !== 'string') return 'crs member has no name';
  if (/(?:^|[:/])(?:CRS84|4326|4269)$/i.test(name.trim())) return undefined;
  return `crs ${name.slice(0, 80)} is not WGS 84 (outSR=4326 was asked for)`;
}

// ── dates ────────────────────────────────────────────────────────────────────

/** Names of the date fields in a field list. */
export function dateFields(fields: readonly EsriField[] | undefined): Set<string> {
  return new Set((fields ?? []).filter((f) => f.type === ESRI_DATE_FIELD).map((f) => f.name));
}

/** Epoch milliseconds in the named date fields → ISO 8601 (strings and nulls are left as they are). */
export function normalizeDates(properties: Record<string, JsonValue>, dates: ReadonlySet<string>): void {
  if (!dates.size) return;
  for (const name of dates) {
    const v = properties[name];
    // ±8.64e15 ms is the Date range; anything outside it is not a date.
    if (finite(v) && Math.abs(v) <= 8.64e15) properties[name] = new Date(v).toISOString();
  }
}

// ── geometry ─────────────────────────────────────────────────────────────────

/** Whether coordinates carry Z and M; undefined when neither the geometry nor the response says. */
export interface Dims {
  hasZ?: boolean | undefined;
  hasM?: boolean | undefined;
}

/** A third coordinate is a height when the response says Z, or says nothing and does not say M. */
const thirdIsZ = (dims: Dims): boolean => dims.hasZ === true || (dims.hasZ === undefined && dims.hasM !== true);

function position(c: unknown, dims: Dims): Position | undefined {
  if (!Array.isArray(c) || c.length < 2 || !finite(c[0]) || !finite(c[1])) return undefined;
  // [x, y, z?, m?]: with M and no Z the third value is the measure, not a height.
  if (thirdIsZ(dims) && finite(c[2])) return [c[0], c[1], c[2]];
  return [c[0], c[1]];
}

function positions(list: unknown, dims: Dims): Position[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: Position[] = [];
  for (const c of list) {
    const p = position(c, dims);
    if (!p) return undefined;
    out.push(p);
  }
  return out;
}

/** Twice the signed area: positive for a clockwise ring (x east, y north). */
function signedArea2(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    sum += (x2! - x1!) * (y2! + y1!);
  }
  return sum;
}

function closed(ring: Position[]): Position[] {
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/** Ray casting on x/y. A point on an edge may count as either side; `holeInside` avoids asking about one. */
function inside(point: Position, ring: Position[]): boolean {
  const [x, y] = point as [number, number];
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function onBoundary(point: Position, ring: Position[]): boolean {
  const [x, y] = point as [number, number];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i] as [number, number];
    const [x2, y2] = ring[i + 1] as [number, number];
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    const scale = Math.max(1, Math.abs(x2 - x1) + Math.abs(y2 - y1));
    if (
      Math.abs(cross) <= 1e-12 * scale * scale &&
      x >= Math.min(x1, x2) &&
      x <= Math.max(x1, x2) &&
      y >= Math.min(y1, y2) &&
      y <= Math.max(y1, y2)
    )
      return true;
  }
  return false;
}

/**
 * Whether a hole lies in an exterior. Holes may touch their exterior at a vertex (valid in
 * esriJSON, common where a fire perimeter has an unburned island), and a point on the
 * boundary answers either way — so the test uses a vertex of the hole that is not on the
 * exterior, or, when every vertex is, the average of the hole's vertices.
 */
function holeInside(hole: Position[], ring: Position[]): boolean {
  for (const p of hole) if (!onBoundary(p, ring)) return inside(p, ring);
  const n = hole.length - 1;
  const mean = [0, 1].map((k) => hole.slice(0, n).reduce((sum, p) => sum + p[k]!, 0) / n);
  return inside(mean, ring);
}

function ringsToGeometry(raw: unknown, dims: Dims): GeoJsonGeometry | null | string {
  if (!Array.isArray(raw)) return 'rings is not an array';
  const outers: Array<{ ring: Position[]; area: number; holes: Position[][] }> = [];
  const holes: Array<{ ring: Position[]; area: number }> = [];
  for (const r of raw) {
    const ring = positions(r, dims);
    if (!ring) return 'a ring has a coordinate that is not a pair of numbers';
    if (ring.length < 3) continue;
    const c = closed(ring);
    if (c.length < 4) continue;
    const area = signedArea2(c);
    if (area === 0) continue;
    if (area > 0) outers.push({ ring: c, area, holes: [] });
    else holes.push({ ring: c, area: -area });
  }
  for (const hole of holes) {
    let best: (typeof outers)[number] | undefined;
    for (const o of outers)
      if (o.area > hole.area && holeInside(hole.ring, o.ring) && (!best || o.area < best.area)) best = o;
    // A hole no exterior contains is an exterior drawn the other way round.
    if (best) best.holes.push(hole.ring.slice().reverse());
    else outers.push({ ring: hole.ring.slice().reverse(), area: hole.area, holes: [] });
  }
  if (!outers.length) return null;
  // RFC 7946: exterior counter-clockwise, holes clockwise. esriJSON exteriors are clockwise.
  const polygons = outers.map((o) => [o.ring.slice().reverse(), ...o.holes]);
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0]! }
    : { type: 'MultiPolygon', coordinates: polygons };
}

/**
 * One esriJSON geometry as GeoJSON: the geometry, null for an empty one, or a string saying
 * why it cannot be read.
 */
export function esriGeometryToGeoJson(g: unknown, defaults: Dims = {}): GeoJsonGeometry | null | string {
  if (g === undefined || g === null) return null;
  if (!isObj(g)) return 'geometry is not an object';
  if (Object.keys(g).length === 0) return null;
  const dims: Dims = {
    hasZ: typeof g['hasZ'] === 'boolean' ? g['hasZ'] : defaults.hasZ,
    hasM: typeof g['hasM'] === 'boolean' ? g['hasM'] : defaults.hasM,
  };
  if ('curvePaths' in g || 'curveRings' in g) return 'true curves are not supported (returnTrueCurves must be false)';
  if ('x' in g) {
    // An empty point is written { "x": "NaN" } or { "x": null }.
    if (!finite(g['x']) || !finite(g['y'])) return g['x'] === null || g['x'] === 'NaN' ? null : 'point x/y not numbers';
    return {
      type: 'Point',
      coordinates: finite(g['z']) && dims.hasZ !== false ? [g['x'], g['y'], g['z']] : [g['x'], g['y']],
    };
  }
  if ('points' in g) {
    const pts = positions(g['points'], dims);
    if (!pts) return 'multipoint has a coordinate that is not a pair of numbers';
    return pts.length ? { type: 'MultiPoint', coordinates: pts } : null;
  }
  if ('paths' in g) {
    if (!Array.isArray(g['paths'])) return 'paths is not an array';
    const paths: Position[][] = [];
    for (const p of g['paths']) {
      const line = positions(p, dims);
      if (!line) return 'a path has a coordinate that is not a pair of numbers';
      if (line.length >= 2) paths.push(line);
    }
    if (!paths.length) return null;
    return paths.length === 1
      ? { type: 'LineString', coordinates: paths[0]! }
      : { type: 'MultiLineString', coordinates: paths };
  }
  if ('rings' in g) return ringsToGeometry(g['rings'], dims);
  if ('xmin' in g) {
    const [x0, y0, x1, y1] = [g['xmin'], g['ymin'], g['xmax'], g['ymax']];
    if (!finite(x0) || !finite(y0) || !finite(x1) || !finite(y1))
      return x0 === null || x0 === 'NaN' ? null : 'bad envelope';
    return {
      type: 'Polygon',
      coordinates: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ],
      ],
    };
  }
  return 'unrecognised geometry (no x/y, points, paths or rings)';
}

// ── a whole response ─────────────────────────────────────────────────────────

/** A body is esriJSON when it has a `features` array and is not a GeoJSON FeatureCollection. */
export function isEsriFeatureSet(body: unknown): boolean {
  return isObj(body) && body['type'] !== 'FeatureCollection' && Array.isArray(body['features']);
}

export function parseEsriFields(raw: unknown): EsriField[] {
  if (!Array.isArray(raw)) return [];
  const out: EsriField[] = [];
  for (const f of raw)
    if (isObj(f) && typeof f['name'] === 'string' && typeof f['type'] === 'string')
      out.push({
        name: f['name'],
        type: f['type'],
        ...(typeof f['alias'] === 'string' ? { alias: f['alias'] } : {}),
      });
  return out;
}

export interface EsriReadOptions {
  /** The layer's object id field, when the response does not name it. */
  objectIdField?: string;
  /** Date fields known from the layer (the response's own `fields` are read too). */
  dates?: ReadonlySet<string>;
}

/** An esriJSON FeatureSet as GeoJSON features, or why it cannot be read. */
export function esriFeatureSetToGeoJson(body: unknown, opts: EsriReadOptions = {}): FeatureSet | { malformed: string } {
  if (!isEsriFeatureSet(body)) return { malformed: 'not an esriJSON feature set (no features array)' };
  const b = body as Obj;
  const srProblem = spatialReferenceProblem(b['spatialReference']);
  if (srProblem) return { malformed: srProblem };
  const fields = parseEsriFields(b['fields']);
  const dates = new Set([...(opts.dates ?? []), ...dateFields(fields)]);
  const oid =
    (typeof b['objectIdFieldName'] === 'string' && b['objectIdFieldName']) ||
    opts.objectIdField ||
    fields.find((f) => f.type === ESRI_OID_FIELD)?.name;
  const defaults: Dims = {
    hasZ: typeof b['hasZ'] === 'boolean' ? b['hasZ'] : undefined,
    hasM: typeof b['hasM'] === 'boolean' ? b['hasM'] : undefined,
  };
  const features: GeoJsonFeature[] = [];
  const problems: string[] = [];
  for (const [i, raw] of (b['features'] as unknown[]).entries()) {
    if (!isObj(raw)) {
      if (problems.length < MAX_PROBLEMS) problems.push(`feature ${i}: not an object`);
      continue;
    }
    const properties: Record<string, JsonValue> = isObj(raw['attributes'])
      ? { ...(raw['attributes'] as Record<string, JsonValue>) }
      : {};
    normalizeDates(properties, dates);
    const g = esriGeometryToGeoJson(raw['geometry'], defaults);
    if (typeof g === 'string' && problems.length < MAX_PROBLEMS) problems.push(`feature ${i}: ${g}`);
    const feature: GeoJsonFeature = { type: 'Feature', geometry: typeof g === 'string' ? null : g, properties };
    const id = oid ? properties[oid] : undefined;
    if (typeof id === 'number' || (typeof id === 'string' && id !== '')) feature.id = id;
    features.push(feature);
  }
  return {
    format: 'esrijson',
    features,
    exceededTransferLimit: typeof b['exceededTransferLimit'] === 'boolean' ? b['exceededTransferLimit'] : undefined,
    problems,
  };
}

/**
 * A GeoJSON FeatureCollection as ArcGIS writes it: `exceededTransferLimit` at the top level
 * or, as ArcGIS Online does, under the collection's `properties`; date fields (known from the
 * layer) as epoch milliseconds, turned into ISO 8601 here as in the esriJSON path.
 */
export function readGeoJsonFeatureSet(
  body: unknown,
  dates: ReadonlySet<string> = new Set(),
): FeatureSet | { malformed: string } {
  if (!isObj(body) || body['type'] !== 'FeatureCollection') return { malformed: 'not a GeoJSON FeatureCollection' };
  if (!Array.isArray(body['features'])) return { malformed: 'FeatureCollection has no features array' };
  const crsProblem = geoJsonCrsProblem(body['crs']);
  if (crsProblem) return { malformed: crsProblem };
  const top = body['exceededTransferLimit'];
  const nested = isObj(body['properties']) ? body['properties']['exceededTransferLimit'] : undefined;
  const exceeded = top === true || nested === true ? true : top === false || nested === false ? false : undefined;
  const features: GeoJsonFeature[] = [];
  const problems: string[] = [];
  for (const [i, raw] of (body['features'] as unknown[]).entries()) {
    if (!isObj(raw)) {
      if (problems.length < MAX_PROBLEMS) problems.push(`feature ${i}: not an object`);
      continue;
    }
    const properties: Record<string, JsonValue> = isObj(raw['properties'])
      ? { ...(raw['properties'] as Record<string, JsonValue>) }
      : {};
    normalizeDates(properties, dates);
    const feature: GeoJsonFeature = {
      type: 'Feature',
      geometry: isObj(raw['geometry']) ? (raw['geometry'] as unknown as GeoJsonGeometry) : null,
      properties,
    };
    const id = raw['id'];
    if (typeof id === 'number' || (typeof id === 'string' && id !== '')) feature.id = id;
    features.push(feature);
  }
  return { format: 'geojson', features, exceededTransferLimit: exceeded, problems };
}

/** Whichever format the body is in. */
export function readFeatureSet(body: unknown, opts: EsriReadOptions = {}): FeatureSet | { malformed: string } {
  if (isObj(body) && body['type'] === 'FeatureCollection') return readGeoJsonFeatureSet(body, opts.dates);
  if (isEsriFeatureSet(body)) return esriFeatureSetToGeoJson(body, opts);
  return { malformed: 'neither a GeoJSON FeatureCollection nor an esriJSON feature set' };
}
