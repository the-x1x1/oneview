import type { JsonValue, WorldGeometry } from '@worldview/world-model';
import {
  MAX_LINE_POINTS,
  clip,
  coordinate,
  isoTime,
  lengthMetres,
  lineGeometry,
  type Coordinate,
  type FeatureReadResult,
  type FileFeature,
} from './features.js';
import { child, childText, childrenNamed, parseXml, type XmlElement } from './xml.js';

/**
 * KML 2.2 Placemarks, wherever they sit (Document, Folder, nested Folders), each one
 * feature. Geometry: Point, LineString, LinearRing, Polygon (outer and inner boundaries),
 * MultiGeometry, `gx:Track` and `gx:MultiTrack` (`<when>`/`<gx:coord>` pairs — the last
 * point is the position and its time the time, as for a GPX track) and Model (its Location).
 * `<coordinates>` are `lon,lat[,alt]` tuples separated by white space; a tuple that does not
 * parse makes the whole geometry unusable rather than silently changing its shape.
 *
 * A MultiGeometry of one kind becomes a Multi* geometry. A mixed one — commonly a polygon
 * with a label point — keeps its highest dimension (polygons, else lines) as the geometry and
 * a single Point member as the position; `mixedGeometry: true` says something was left out.
 *
 * `ExtendedData` (`<Data name><value>` and `<SchemaData><SimpleData name>`) becomes the
 * feature's properties, as strings (the mapping's transforms type them); the enclosing
 * Folder's name is `folder`, and `<address>` is kept as text and never geocoded (product
 * boundary). A NetworkLink is not followed — a file source never fetches — and is reported.
 */
export function readKml(text: string): FeatureReadResult | { malformed: string } {
  const parsed = parseXml(text);
  if ('malformed' in parsed) return { malformed: `not KML: ${parsed.malformed}` };
  const root = parsed.root;
  const rootName = root.name.toLowerCase();
  if (rootName !== 'kml' && rootName !== 'document' && rootName !== 'folder')
    return { malformed: `not KML: the root element is <${root.qname}>` };
  const out: FeatureReadResult = { features: [], skipped: [], notes: [] };
  const found: Array<{ placemark: XmlElement; folder: string | undefined }> = [];
  let networkLinks = 0;
  const walk = (el: XmlElement, folder: string | undefined) => {
    for (const c of el.children) {
      const name = c.name.toLowerCase();
      if (name === 'placemark') found.push({ placemark: c, folder });
      else if (name === 'networklink') networkLinks++;
      else if (name === 'folder') walk(c, childText(c, 'name') ?? folder);
      else if (name === 'document' || name === 'kml') walk(c, folder);
    }
  };
  walk(root, rootName === 'folder' ? childText(root, 'name') : undefined);
  if (networkLinks)
    out.notes.push(`${networkLinks} NetworkLink(s) not followed: a file source reads only the file it names`);

  found.forEach(({ placemark, folder }, i) => {
    const ownId = placemark.attrs['id']?.trim();
    const id = ownId && /^[^\s:]{1,200}$/.test(ownId) ? ownId : `placemark-${i + 1}`;
    const g = readGeometryOf(placemark);
    if ('reason' in g) {
      out.skipped.push({ id, reason: g.reason });
      return;
    }
    const properties: Record<string, JsonValue> = { ...extendedData(placemark) };
    if (folder) properties['folder'] = clip(folder, 256);
    const address = childText(placemark, 'address');
    if (address) properties['address'] = clip(address, 512);
    const styleUrl = childText(placemark, 'styleUrl');
    if (styleUrl) properties['styleUrl'] = clip(styleUrl, 512);
    const stamp = child(placemark, 'TimeStamp');
    const span = child(placemark, 'TimeSpan');
    const when = stamp ? isoTime(childText(stamp, 'when')) : undefined;
    const begin = span ? isoTime(childText(span, 'begin')) : undefined;
    const end = span ? isoTime(childText(span, 'end')) : undefined;
    if (begin) properties['begin'] = begin;
    if (end) properties['end'] = end;
    for (const [k, v] of Object.entries(g.extra)) properties[k] = v;
    const f: FileFeature = { type: 'Feature', id, kind: 'placemark', geometry: g.geometry, properties };
    const name = childText(placemark, 'name');
    const description = clip(childText(placemark, 'description'));
    if (name) f.name = clip(name, 256);
    if (description) f.description = description;
    const time = g.time ?? when ?? begin;
    if (time) f.time = time;
    if (g.point) f.point = { type: 'Point', coordinates: g.point };
    out.features.push(f);
  });
  return out;
}

type Geom = { kind: 'point' | 'line' | 'polygon'; geometry: WorldGeometry; point?: Coordinate; time?: string };
type GeomResult =
  { geometry: WorldGeometry; point?: Coordinate; time?: string; extra: Record<string, JsonValue> } | { reason: string };

const GEOMETRY_ELEMENTS = new Set([
  'point',
  'linestring',
  'linearring',
  'polygon',
  'multigeometry',
  'track',
  'multitrack',
  'model',
]);

function readGeometryOf(placemark: XmlElement): GeomResult {
  const el = placemark.children.find((c) => GEOMETRY_ELEMENTS.has(c.name.toLowerCase()));
  if (!el) return { reason: 'the placemark has no geometry' };
  const g = readGeometry(el, 0);
  if ('reason' in g) return g;
  const extra: Record<string, JsonValue> = {};
  const lower = el.name.toLowerCase();
  if (lower === 'track' || lower === 'multitrack') {
    const lines =
      g.geometry.type === 'LineString'
        ? [g.geometry.coordinates]
        : g.geometry.type === 'MultiLineString'
          ? g.geometry.coordinates
          : [];
    extra['pointCount'] = lines.reduce((n, l) => n + l.length, 0);
    extra['lengthM'] = Math.round(lines.reduce((m, l) => m + lengthMetres(l), 0) * 10) / 10;
    const times = trackTimes(el);
    if (times.first) extra['startTime'] = times.first;
    if (times.last) extra['endTime'] = times.last;
  }
  if (lower === 'multigeometry' && g.mixed) extra['mixedGeometry'] = true;
  return {
    geometry: g.geometry,
    ...(g.point ? { point: g.point } : {}),
    ...(g.time ? { time: g.time } : {}),
    extra,
  };
}

function readGeometry(el: XmlElement, depth: number): (Geom & { mixed?: boolean }) | { reason: string } {
  if (depth > 8) return { reason: 'MultiGeometry nested deeper than 8' };
  switch (el.name.toLowerCase()) {
    case 'point': {
      const c = coordinates(el);
      if ('reason' in c) return c;
      if (c.list.length === 0) return { reason: 'a Point has no coordinates' };
      return { kind: 'point', geometry: { type: 'Point', coordinates: c.list[0]! } };
    }
    case 'linestring': {
      const c = coordinates(el);
      if ('reason' in c) return c;
      if (c.list.length < 2) return { reason: 'a LineString has fewer than two points' };
      if (c.list.length > MAX_LINE_POINTS) return { reason: `a LineString has more than ${MAX_LINE_POINTS} points` };
      return { kind: 'line', geometry: { type: 'LineString', coordinates: c.list } };
    }
    case 'linearring': {
      const ring = readRing(el);
      if ('reason' in ring) return ring;
      return { kind: 'polygon', geometry: { type: 'Polygon', coordinates: [ring.ring] } };
    }
    case 'polygon': {
      const outer = child(el, 'outerBoundaryIs');
      const outerRing = outer ? child(outer, 'LinearRing') : undefined;
      if (!outerRing) return { reason: 'a Polygon has no outer boundary' };
      const rings: Coordinate[][] = [];
      const first = readRing(outerRing);
      if ('reason' in first) return first;
      rings.push(first.ring);
      for (const inner of childrenNamed(el, 'innerBoundaryIs'))
        for (const lr of childrenNamed(inner, 'LinearRing')) {
          const r = readRing(lr);
          if ('reason' in r) return r;
          rings.push(r.ring);
        }
      if (rings.length > 1000) return { reason: 'a Polygon has more than 1000 rings' };
      return { kind: 'polygon', geometry: { type: 'Polygon', coordinates: rings } };
    }
    case 'model': {
      const loc = child(el, 'Location');
      const lon = Number(loc ? childText(loc, 'longitude') : NaN);
      const lat = Number(loc ? childText(loc, 'latitude') : NaN);
      const altText = loc ? childText(loc, 'altitude') : undefined;
      const c = coordinate(lon, lat, altText === undefined ? undefined : Number(altText));
      if (!c) return { reason: 'a Model has no valid Location' };
      return { kind: 'point', geometry: { type: 'Point', coordinates: c } };
    }
    case 'track': {
      const t = readTrack(el);
      if ('reason' in t) return t;
      const geometry = lineGeometry([t.points]);
      if (!geometry) return { reason: 'a gx:Track has no valid points' };
      return { kind: 'line', geometry, point: t.points[t.points.length - 1]!, ...(t.time ? { time: t.time } : {}) };
    }
    case 'multitrack': {
      const segments: Coordinate[][] = [];
      let last: { point: Coordinate; time?: string } | undefined;
      for (const tr of childrenNamed(el, 'Track')) {
        const t = readTrack(tr);
        if ('reason' in t) return t;
        segments.push(t.points);
        last = { point: t.points[t.points.length - 1]!, ...(t.time ? { time: t.time } : {}) };
      }
      const geometry = lineGeometry(segments);
      if (!geometry || !last) return { reason: 'a gx:MultiTrack has no valid points' };
      return { kind: 'line', geometry, point: last.point, ...(last.time ? { time: last.time } : {}) };
    }
    case 'multigeometry': {
      const parts: Geom[] = [];
      for (const c of el.children) {
        if (!GEOMETRY_ELEMENTS.has(c.name.toLowerCase())) continue;
        const g = readGeometry(c, depth + 1);
        if ('reason' in g) return g;
        parts.push(g);
      }
      return combine(parts);
    }
    default:
      return { reason: `unsupported geometry <${el.qname}>` };
  }
}

/** A MultiGeometry's parts as one geometry (see the header for mixed kinds). */
function combine(parts: Geom[]): (Geom & { mixed?: boolean }) | { reason: string } {
  if (parts.length === 0) return { reason: 'an empty MultiGeometry' };
  const kinds = new Set(parts.map((p) => p.kind));
  const top = kinds.has('polygon') ? 'polygon' : kinds.has('line') ? 'line' : 'point';
  const chosen = parts.filter((p) => p.kind === top);
  const points = parts.filter((p) => p.kind === 'point');
  const labelPoint =
    top !== 'point' && points.length === 1 && points[0]!.geometry.type === 'Point'
      ? points[0]!.geometry.coordinates
      : undefined;
  const mixed = kinds.size > 1;
  const flat = <T>(f: (g: WorldGeometry) => T[]): T[] => chosen.flatMap((p) => f(p.geometry));
  let geometry: WorldGeometry;
  if (top === 'point')
    geometry = {
      type: 'MultiPoint',
      coordinates: flat((g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [])),
    };
  else if (top === 'line')
    geometry = {
      type: 'MultiLineString',
      coordinates: flat((g) =>
        g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [],
      ),
    };
  else
    geometry = {
      type: 'MultiPolygon',
      coordinates: flat((g) =>
        g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [],
      ),
    };
  const lastTimed = [...chosen].reverse().find((p) => p.time);
  const trackPoint = [...chosen].reverse().find((p) => p.point)?.point;
  return {
    kind: top,
    geometry,
    ...(labelPoint ? { point: labelPoint } : trackPoint ? { point: trackPoint } : {}),
    ...(lastTimed?.time ? { time: lastTimed.time } : {}),
    ...(mixed ? { mixed } : {}),
  };
}

function readRing(el: XmlElement): { ring: Coordinate[] } | { reason: string } {
  const c = coordinates(el);
  if ('reason' in c) return c;
  const ring = c.list;
  if (ring.length > MAX_LINE_POINTS) return { reason: `a ring has more than ${MAX_LINE_POINTS} points` };
  const [a, b] = [ring[0], ring[ring.length - 1]];
  if (a && b && (a[0] !== b[0] || a[1] !== b[1])) ring.push(a);
  if (ring.length < 4) return { reason: 'a ring has fewer than three distinct points' };
  return { ring };
}

/** `lon,lat[,alt]` tuples, white-space separated (spaces around the commas tolerated). */
export function parseKmlCoordinates(text: string): { list: Coordinate[] } | { reason: string } {
  const tokens = text
    .replace(/\s*,\s*/g, ',')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const list: Coordinate[] = [];
  for (const token of tokens) {
    const parts = token.split(',');
    if (parts.length < 2 || parts.length > 3)
      return { reason: `the coordinate "${token.slice(0, 40)}" is not lon,lat[,alt]` };
    const [lon, lat, alt] = parts.map(Number) as [number, number, number | undefined];
    if (parts.some((p) => p === '' || !Number.isFinite(Number(p))))
      return { reason: `the coordinate "${token.slice(0, 40)}" is not numbers` };
    const c = coordinate(lon, lat, parts.length === 3 ? alt : undefined);
    if (!c) return { reason: `the coordinate "${token.slice(0, 40)}" is out of range` };
    list.push(c);
  }
  return { list };
}

function coordinates(el: XmlElement): { list: Coordinate[] } | { reason: string } {
  const text = childText(el, 'coordinates');
  if (text === undefined) return { reason: `a <${el.qname}> has no coordinates` };
  return parseKmlCoordinates(text);
}

/** gx:Track: `<when>` and `<gx:coord>` ("lon lat alt") in pairs, by position. */
function readTrack(el: XmlElement): { points: Coordinate[]; time?: string } | { reason: string } {
  const coords = childrenNamed(el, 'coord');
  const whens = childrenNamed(el, 'when');
  if (coords.length === 0) return { reason: 'a gx:Track has no gx:coord' };
  if (coords.length > MAX_LINE_POINTS) return { reason: `a gx:Track has more than ${MAX_LINE_POINTS} points` };
  if (whens.length && whens.length !== coords.length)
    return { reason: `a gx:Track has ${whens.length} <when> for ${coords.length} <gx:coord>` };
  const points: Coordinate[] = [];
  for (const c of coords) {
    const [lon, lat, alt] = c.text.trim().split(/\s+/).map(Number) as [number, number, number | undefined];
    const p = coordinate(lon, lat, alt);
    if (!p) return { reason: `the gx:coord "${c.text.trim().slice(0, 40)}" is out of range` };
    points.push(p);
  }
  const time = whens.length ? isoTime(whens[whens.length - 1]!.text) : undefined;
  return { points, ...(time ? { time } : {}) };
}

function trackTimes(el: XmlElement): { first?: string; last?: string } {
  const whens: string[] = [];
  const collect = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.name.toLowerCase() === 'when') {
        const t = isoTime(c.text);
        if (t) whens.push(t);
      } else if (c.name.toLowerCase() === 'track') collect(c);
    }
  };
  collect(el);
  return { ...(whens[0] ? { first: whens[0] } : {}), ...(whens.length ? { last: whens[whens.length - 1]! } : {}) };
}

/** `<Data name><value>` and `<SchemaData><SimpleData name>` as string properties. */
function extendedData(placemark: XmlElement): Record<string, JsonValue> {
  const ext = child(placemark, 'ExtendedData');
  const out: Record<string, JsonValue> = {};
  if (!ext) return out;
  let n = 0;
  const put = (name: string | undefined, value: string | undefined) => {
    if (!name || value === undefined || n >= 256) return;
    out[name.slice(0, 64)] = clip(value);
    n++;
  };
  for (const d of childrenNamed(ext, 'Data')) put(d.attrs['name'], childText(d, 'value') ?? '');
  for (const sd of childrenNamed(ext, 'SchemaData'))
    for (const simple of childrenNamed(sd, 'SimpleData')) put(simple.attrs['name'], simple.text.trim());
  return out;
}
