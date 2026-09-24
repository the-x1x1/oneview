import type { JsonValue, WorldGeometry } from '@worldview/world-model';
import { MAX_LINE_POINTS, coordinate, type Coordinate, type FeatureReadResult, type FileFeature } from './features.js';

/**
 * TopoJSON (topology specification 1.0) to features — the small converter the brief asks
 * for, without the topojson-client dependency. Arcs are decoded once (delta-decoded and
 * scaled when the topology is quantized), a negative index `~i` is arc `i` reversed, and a
 * line or ring is its arcs joined with each shared end point kept once. Points are scaled
 * but not delta-encoded, as the specification says.
 *
 * Every object in `objects` is read, or only those `file.layers` names; a
 * GeometryCollection contributes each of its geometries. A feature's id is the geometry's
 * `id` when it has one, otherwise `<object>-<n>`; its `kind` is the object's name; its
 * properties are the geometry's `properties`. TopoJSON carries no coordinate system, so the
 * coordinates must already be longitude/latitude — a projected topology is refused with that
 * reason rather than drawn in the wrong place.
 */
interface TopoGeometry {
  type?: unknown;
  id?: unknown;
  properties?: unknown;
  coordinates?: unknown;
  arcs?: unknown;
  geometries?: unknown;
}

class TopoError extends Error {}

export function readTopoJson(
  text: string,
  opts: { layers?: string[] } = {},
): FeatureReadResult | { malformed: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { malformed: 'not TopoJSON: the file is not valid JSON' };
  }
  return readTopologyDocument(doc, opts);
}

/** The same, from an already-parsed document (a `.json` file is parsed once to tell Topology from GeoJSON). */
export function readTopologyDocument(
  doc: unknown,
  opts: { layers?: string[] } = {},
): FeatureReadResult | { malformed: string } {
  if (!isObject(doc) || doc['type'] !== 'Topology') return { malformed: 'not TopoJSON: no "type": "Topology"' };
  const objects = doc['objects'];
  if (!isObject(objects)) return { malformed: 'not TopoJSON: "objects" is not an object' };
  const rawArcs = doc['arcs'] ?? [];
  if (!Array.isArray(rawArcs)) return { malformed: 'not TopoJSON: "arcs" is not an array' };
  let transform: { scale: [number, number]; translate: [number, number] } | undefined;
  if (doc['transform'] !== undefined) {
    const t = doc['transform'];
    if (!isObject(t) || !isPair(t['scale']) || !isPair(t['translate']))
      return { malformed: 'not TopoJSON: "transform" needs numeric scale and translate pairs' };
    transform = { scale: t['scale'], translate: t['translate'] };
  }
  const names = Object.keys(objects);
  const wanted = opts.layers?.length ? opts.layers : names;
  const missing = wanted.filter((n) => !names.includes(n));
  if (missing.length)
    return {
      malformed: `the topology has no object named ${missing.join(', ')} (it has ${names.join(', ') || 'none'})`,
    };

  let arcs: Array<Array<[number, number]>>;
  try {
    arcs = rawArcs.map((arc, i) => decodeArc(arc, i, transform));
  } catch (err) {
    return { malformed: `not TopoJSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const out: FeatureReadResult = { features: [], skipped: [], notes: [] };
  for (const name of wanted) {
    let n = 0;
    const visit = (g: unknown, depth: number) => {
      if (!isObject(g)) return;
      const geom = g as TopoGeometry;
      if (geom.type === 'GeometryCollection') {
        if (depth > 8) throw new TopoError('GeometryCollections nested deeper than 8');
        if (Array.isArray(geom.geometries)) for (const child of geom.geometries) visit(child, depth + 1);
        return;
      }
      n++;
      const ownId = typeof geom.id === 'string' || typeof geom.id === 'number' ? String(geom.id).trim() : '';
      const id = /^[^\s:]{1,200}$/.test(ownId) ? ownId : `${name.replace(/[\s:]/g, '_')}-${n}`;
      const properties: Record<string, JsonValue> = isObject(geom.properties)
        ? (geom.properties as Record<string, JsonValue>)
        : {};
      let geometry: WorldGeometry | undefined;
      try {
        geometry = toGeometry(geom, arcs, transform);
      } catch (err) {
        out.skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!geometry) {
        out.skipped.push({ id, reason: 'the geometry is null' });
        return;
      }
      const f: FileFeature = { type: 'Feature', id, kind: name, geometry, properties };
      out.features.push(f);
    };
    try {
      visit(objects[name], 0);
    } catch (err) {
      return { malformed: `not TopoJSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return out;
}

function decodeArc(
  arc: unknown,
  index: number,
  transform: { scale: [number, number]; translate: [number, number] } | undefined,
): Array<[number, number]> {
  if (!Array.isArray(arc)) throw new TopoError(`arc ${index} is not an array`);
  let x = 0;
  let y = 0;
  return arc.map((p, j) => {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number')
      throw new TopoError(`arc ${index} position ${j} is not a pair of numbers`);
    if (!transform) return [p[0], p[1]];
    x += p[0];
    y += p[1];
    return [
      dequantize(x, transform.scale[0], transform.translate[0]),
      dequantize(y, transform.scale[1], transform.translate[1]),
    ];
  });
}

/** A quantized value back in degrees, with the float noise of the multiplication rounded away (1e-9°, 0.1 mm). */
function dequantize(q: number, scale: number, translate: number): number {
  return Math.round((q * scale + translate) * 1e9) / 1e9;
}

function toGeometry(
  g: TopoGeometry,
  arcs: Array<Array<[number, number]>>,
  transform: { scale: [number, number]; translate: [number, number] } | undefined,
): WorldGeometry | undefined {
  const point = (p: unknown): Coordinate => {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number')
      throw new TopoError('a position is not a pair of numbers');
    const lon = transform ? dequantize(p[0], transform.scale[0], transform.translate[0]) : p[0];
    const lat = transform ? dequantize(p[1], transform.scale[1], transform.translate[1]) : p[1];
    const c = coordinate(lon, lat);
    if (!c) throw new TopoError(`(${lon}, ${lat}) is not a longitude/latitude — a projected topology?`);
    return c;
  };
  const arc = (i: unknown): Array<[number, number]> => {
    if (typeof i !== 'number' || !Number.isInteger(i)) throw new TopoError('an arc index is not an integer');
    const k = i >= 0 ? i : ~i;
    const a = arcs[k];
    if (!a) throw new TopoError(`arc ${k} does not exist`);
    return i >= 0 ? a : [...a].reverse();
  };
  const line = (indexes: unknown): Coordinate[] => {
    if (!Array.isArray(indexes)) throw new TopoError('arcs is not a list of indexes');
    const out: Coordinate[] = [];
    for (const i of indexes) {
      const pts = arc(i);
      for (let j = out.length ? 1 : 0; j < pts.length; j++) {
        const [lon, lat] = pts[j]!;
        const c = coordinate(lon, lat);
        if (!c) throw new TopoError(`(${lon}, ${lat}) is not a longitude/latitude — a projected topology?`);
        out.push(c);
      }
      if (out.length > MAX_LINE_POINTS) throw new TopoError(`a line has more than ${MAX_LINE_POINTS} points`);
    }
    return out;
  };
  const rings = (list: unknown): Coordinate[][] => {
    if (!Array.isArray(list)) throw new TopoError('a polygon is not a list of rings');
    const out = list.map(line);
    for (const r of out) if (r.length < 4) throw new TopoError('a ring has fewer than four positions');
    return out;
  };
  const list = (v: unknown): unknown[] => {
    if (!Array.isArray(v)) throw new TopoError(`a ${String(g.type)} has no list of arcs or coordinates`);
    return v;
  };
  switch (g.type) {
    case null:
    case undefined:
      return undefined;
    case 'Point':
      return { type: 'Point', coordinates: point(g.coordinates) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: list(g.coordinates).map(point) };
    case 'LineString': {
      const l = line(g.arcs);
      if (l.length < 2) throw new TopoError('a LineString has fewer than two positions');
      return { type: 'LineString', coordinates: l };
    }
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: list(g.arcs).map(line) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: rings(g.arcs) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: list(g.arcs).map(rings) };
    default:
      throw new TopoError(`unsupported geometry type ${JSON.stringify(g.type).slice(0, 40)}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}
