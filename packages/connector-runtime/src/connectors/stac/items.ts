import type { JsonValue } from '@worldview/world-model';

/**
 * STAC items → records the mapping can read. A STAC item is a GeoJSON Feature with an `id`,
 * a `bbox`, a footprint `geometry`, `properties` (`datetime` or `start_datetime`,
 * `platform`, `eo:cloud_cover`, `gsd`, …), a `collection` and a map of `assets`. The mapping
 * language cannot compute, so the parts it cannot express are computed here, once, and
 * attached to the record under `_stac`:
 *
 *   _stac.centroid             [lon, lat] — the middle of the item's bbox, across the antimeridian when the bbox is
 *   _stac.bbox                 [west, south, east, north] — the item's bbox, or one computed from the footprint
 *   _stac.key                  `<collection>/<id>` — an id unique across collections
 *   _stac.thumbnail            the thumbnail asset's href, absolute, https only
 *   _stac.assets               the asset keys (at most 64)
 *   _stac.href                 where the item was read from
 *   _stac.footprintVertices    how many vertices the source footprint had
 *   _stac.footprintSimplified  true when the footprint was thinned to the vertex cap
 *   _stac.footprintDropped     why the footprint was left out, when it was
 *
 * The record's own `geometry` is replaced by the capped footprint (or null), so no mapping —
 * default or hand-written — can hand the renderer more than `MAX_FOOTPRINT_VERTICES`.
 */
export const STAC_RECORD_KEY = '_stac';
export const MAX_FOOTPRINT_VERTICES = 5000;
export const MAX_ASSET_KEYS = 64;
const MAX_HREF_LENGTH = 2048;
/** Coordinates this far outside the WGS 84 range are rounding, and are clamped; further out is an error. */
const COORD_TOLERANCE = 1e-6;

export type Bbox2D = [west: number, south: number, east: number, north: number];
type Position = [number, number];

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lon(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 180 + COORD_TOLERANCE) return undefined;
  return Math.max(-180, Math.min(180, v));
}

function lat(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 90 + COORD_TOLERANCE) return undefined;
  return Math.max(-90, Math.min(90, v));
}

/**
 * A STAC bbox — four numbers, or six with the heights — as west, south, east, north.
 * West greater than east is a box across the antimeridian (RFC 7946 §5.2), kept as it is.
 */
export function bbox2d(b: unknown): Bbox2D | undefined {
  if (!Array.isArray(b) || (b.length !== 4 && b.length !== 6)) return undefined;
  const [w, s, e, n] = b.length === 4 ? [b[0], b[1], b[2], b[3]] : [b[0], b[1], b[3], b[4]];
  const west = lon(w);
  const east = lon(e);
  const south = lat(s);
  const north = lat(n);
  if (west === undefined || east === undefined || south === undefined || north === undefined || south > north)
    return undefined;
  return [west, south, east, north];
}

/** The middle of a bbox as [lon, lat]; for a box across the antimeridian, the middle of the part that crosses it. */
export function bboxCentroid([west, south, east, north]: Bbox2D): Position {
  const width = west <= east ? east - west : east + 360 - west;
  let centre = west + width / 2;
  if (centre > 180) centre -= 360;
  return [round9(centre), round9((south + north) / 2)];
}

function round9(v: number): number {
  const r = Math.round(v * 1e9) / 1e9;
  return r === 0 ? 0 : r;
}

// ── footprints ───────────────────────────────────────────────────────────────

type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

/** A position as [lon, lat] (any height dropped), or undefined when it is not one. */
function position(v: unknown): Position | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const x = lon(v[0]);
  const y = lat(v[1]);
  return x === undefined || y === undefined ? undefined : [x, y];
}

function positions(v: unknown, min: number): Position[] | undefined {
  if (!Array.isArray(v) || v.length < min) return undefined;
  const out: Position[] = [];
  for (const p of v) {
    const q = position(p);
    if (!q) return undefined;
    out.push(q);
  }
  return out;
}

function nested<T>(v: unknown, read: (x: unknown) => T | undefined, min: number): T[] | undefined {
  if (!Array.isArray(v) || v.length < min) return undefined;
  const out: T[] = [];
  for (const x of v) {
    const r = read(x);
    if (r === undefined) return undefined;
    out.push(r);
  }
  return out;
}

const ring = (v: unknown) => positions(v, 4);
const line = (v: unknown) => positions(v, 2);

/** A GeoJSON geometry read strictly: one of the six types, every position in range. */
export function readFootprint(g: unknown): Geometry | undefined {
  if (!isRecord(g) || typeof g['type'] !== 'string') return undefined;
  const c = g['coordinates'];
  switch (g['type']) {
    case 'Point': {
      const p = position(c);
      return p ? { type: 'Point', coordinates: p } : undefined;
    }
    case 'MultiPoint': {
      const p = positions(c, 1);
      return p ? { type: 'MultiPoint', coordinates: p } : undefined;
    }
    case 'LineString': {
      const p = line(c);
      return p ? { type: 'LineString', coordinates: p } : undefined;
    }
    case 'MultiLineString': {
      const p = nested(c, line, 1);
      return p ? { type: 'MultiLineString', coordinates: p } : undefined;
    }
    case 'Polygon': {
      const p = nested(c, ring, 1);
      return p ? { type: 'Polygon', coordinates: p } : undefined;
    }
    case 'MultiPolygon': {
      const p = nested(c, (x) => nested(x, ring, 1), 1);
      return p ? { type: 'MultiPolygon', coordinates: p } : undefined;
    }
    default:
      return undefined;
  }
}

/** Every vertex of a geometry, in order. */
function allPositions(g: Geometry): Position[] {
  switch (g.type) {
    case 'Point':
      return [g.coordinates];
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates;
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.flat();
    case 'MultiPolygon':
      return g.coordinates.flat(2);
  }
}

export function countVertices(g: Geometry): number {
  switch (g.type) {
    case 'Point':
      return 1;
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates.length;
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.reduce((n, r) => n + r.length, 0);
    case 'MultiPolygon':
      return g.coordinates.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
  }
}

/**
 * The bbox of a geometry. When the longitudes span more than half the world, the same
 * points are also measured with the western hemisphere moved east by 360°; if that span is
 * smaller the footprint straddles the antimeridian and the bbox is written across it
 * (west > east) — which is how a scene split at ±180° gets its middle in the Pacific
 * rather than at 0°.
 */
export function footprintBbox(g: Geometry): Bbox2D {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minS = Infinity,
    maxS = -Infinity;
  for (const [x, y] of allPositions(g)) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const shifted = x < 0 ? x + 360 : x;
    if (shifted < minS) minS = shifted;
    if (shifted > maxS) maxS = shifted;
  }
  if (maxX - minX > 180 && maxS - minS < maxX - minX) {
    const west = minS > 180 ? minS - 360 : minS;
    const east = maxS > 180 ? maxS - 360 : maxS;
    return [west, minY, east, maxY];
  }
  return [minX, minY, maxX, maxY];
}

/** Keep every `step`-th vertex (and the last); a ring stays closed and keeps at least three corners. */
function thin(points: Position[], step: number, closed: boolean): Position[] {
  const floor = closed ? 4 : 2;
  if (step <= 1 || points.length <= floor) return points;
  const last = points.length - 1;
  const out: Position[] = [];
  for (let i = 0; i < last; i += step) out.push(points[i]!);
  if (closed) {
    if (out.length < 3) {
      // A ring thinned below a triangle: take three corners spread along it instead.
      const third = Math.floor(last / 3);
      out.length = 0;
      out.push(points[0]!, points[third]!, points[2 * third]!);
    }
    out.push(points[0]!);
  } else out.push(points[last]!);
  return out;
}

function thinGeometry(g: Geometry, step: number): Geometry {
  switch (g.type) {
    case 'Point':
      return g;
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: g.coordinates.filter((_, i) => i % step === 0) };
    case 'LineString':
      return { type: 'LineString', coordinates: thin(g.coordinates, step, false) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: g.coordinates.map((l) => thin(l, step, false)) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: g.coordinates.map((r) => thin(r, step, true)) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map((r) => thin(r, step, true))) };
  }
}

/** The fewest vertices thinning can leave: four per ring, two per line, one point. */
function thinnestPossible(g: Geometry): number {
  switch (g.type) {
    case 'Point':
    case 'MultiPoint':
      return 1;
    case 'LineString':
      return Math.min(2, g.coordinates.length);
    case 'MultiLineString':
      return g.coordinates.reduce((n, l) => n + Math.min(2, l.length), 0);
    case 'Polygon':
      return g.coordinates.reduce((n, r) => n + Math.min(4, r.length), 0);
    case 'MultiPolygon':
      return g.coordinates.reduce((n, p) => n + p.reduce((m, r) => m + Math.min(4, r.length), 0), 0);
  }
}

export interface Footprint {
  /** The footprint to keep: at most `max` vertices, positions in range, heights dropped. */
  geometry?: Geometry;
  /** Vertices in the source geometry. */
  vertices: number;
  simplified: boolean;
  /** Why no footprint is kept. */
  dropped?: string;
  /** The source footprint's bbox, for items that carry none. */
  bbox?: Bbox2D;
}

/**
 * Cap a footprint at `max` vertices (directive: never flood the renderer's line layer).
 * Over the cap it is thinned uniformly — every n-th vertex, rings kept closed — which keeps
 * the outline of a scene (they are smooth, if dense); a footprint that cannot be thinned
 * under the cap (thousands of rings) is left out with a reason and the item keeps its
 * centroid.
 */
export function capFootprint(g: unknown, max = MAX_FOOTPRINT_VERTICES): Footprint {
  const geometry = readFootprint(g);
  if (!geometry) return { vertices: 0, simplified: false, dropped: 'not a GeoJSON geometry within WGS 84 bounds' };
  const vertices = countVertices(geometry);
  const bbox = footprintBbox(geometry);
  if (vertices <= max) return { geometry, vertices, simplified: false, bbox };
  if (thinnestPossible(geometry) > max)
    return {
      vertices,
      simplified: false,
      bbox,
      dropped: `${vertices} vertices in too many parts to thin under ${max}`,
    };
  for (let step = Math.ceil(vertices / max); step <= vertices; step++) {
    const thinned = thinGeometry(geometry, step);
    if (countVertices(thinned) <= max) return { geometry: thinned, vertices, simplified: true, bbox };
  }
  return { vertices, simplified: false, bbox, dropped: `${vertices} vertices could not be thinned under ${max}` };
}

// ── assets and links ─────────────────────────────────────────────────────────

/** An href resolved against `base`, kept only when it is https with no credentials in it. */
export function httpsHref(href: unknown, base: string): string | undefined {
  if (typeof href !== 'string' || !href || href.length > MAX_HREF_LENGTH) return undefined;
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  return u.toString();
}

function roles(asset: Record<string, unknown>): string[] {
  const r = asset['roles'];
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

/** The thumbnail: the asset named `thumbnail`, else one with the `thumbnail` role, else a `thumbnail` link. */
export function thumbnailHref(item: Record<string, unknown>, base: string): string | undefined {
  const assets = isRecord(item['assets']) ? item['assets'] : {};
  const named = assets['thumbnail'];
  if (isRecord(named)) {
    const h = httpsHref(named['href'], base);
    if (h) return h;
  }
  for (const a of Object.values(assets))
    if (isRecord(a) && roles(a).includes('thumbnail')) {
      const h = httpsHref(a['href'], base);
      if (h) return h;
    }
  for (const l of Array.isArray(item['links']) ? item['links'] : [])
    if (isRecord(l) && l['rel'] === 'thumbnail') {
      const h = httpsHref(l['href'], base);
      if (h) return h;
    }
  return undefined;
}

export function assetKeys(item: Record<string, unknown>): string[] {
  const assets = item['assets'];
  if (!isRecord(assets)) return [];
  return Object.keys(assets)
    .filter((k) => isRecord(assets[k]) && k.length <= 128)
    .slice(0, MAX_ASSET_KEYS);
}

/** The first link with this `rel`, as the raw link object. */
export function linkOf(doc: Record<string, unknown>, rel: string): Record<string, unknown> | undefined {
  const links = doc['links'];
  if (!Array.isArray(links)) return undefined;
  for (const l of links) if (isRecord(l) && l['rel'] === rel && typeof l['href'] === 'string') return l;
  return undefined;
}

// ── the record ───────────────────────────────────────────────────────────────

export interface ItemRecord {
  /** The record the mapping reads: the item, its geometry capped, `_stac` attached. */
  record: unknown;
  footprint: 'kept' | 'simplified' | 'dropped' | 'none';
  /** Why the footprint was dropped. */
  reason?: string;
}

/**
 * One item as a mapping record. `base` is where the item was read (a static item's own
 * URL, or the search URL), against which relative hrefs resolve. Anything that is not an
 * object is passed through untouched for the mapping to reject with its reason.
 */
export function itemRecord(raw: unknown, base: string): ItemRecord {
  if (!isRecord(raw)) return { record: raw, footprint: 'none' };
  const fp = raw['geometry'] === null || raw['geometry'] === undefined ? undefined : capFootprint(raw['geometry']);
  const bbox = bbox2d(raw['bbox']) ?? fp?.bbox;
  const id = typeof raw['id'] === 'string' ? raw['id'] : undefined;
  const collection = typeof raw['collection'] === 'string' ? raw['collection'] : undefined;
  const stac: Record<string, JsonValue> = {};
  if (bbox) {
    stac['bbox'] = bbox;
    stac['centroid'] = bboxCentroid(bbox);
  }
  if (id) stac['key'] = collection ? `${collection}/${id}` : id;
  const thumbnail = thumbnailHref(raw, base);
  if (thumbnail) stac['thumbnail'] = thumbnail;
  const assets = assetKeys(raw);
  if (assets.length) stac['assets'] = assets;
  const self = linkOf(raw, 'self');
  stac['href'] = httpsHref(self?.['href'], base) ?? base;
  if (fp) {
    stac['footprintVertices'] = fp.vertices;
    if (fp.simplified) stac['footprintSimplified'] = true;
    if (fp.dropped) stac['footprintDropped'] = fp.dropped;
  }
  const record = { ...raw, geometry: (fp?.geometry ?? null) as JsonValue, [STAC_RECORD_KEY]: stac };
  const footprint = !fp ? 'none' : fp.dropped ? 'dropped' : fp.simplified ? 'simplified' : 'kept';
  return fp?.dropped ? { record, footprint, reason: fp.dropped } : { record, footprint };
}
