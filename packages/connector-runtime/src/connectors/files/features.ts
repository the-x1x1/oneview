import type { JsonValue, WorldGeometry } from '@worldview/world-model';

/**
 * What the GPX, KML and TopoJSON readers produce: GeoJSON features, so that one mapping
 * vocabulary covers every file format (and GeoJSON files need no conversion at all). A few
 * members sit beside `properties`, where GeoJSON allows foreign members, so that nothing a
 * file's own data calls `name` or `time` can collide with them:
 *
 * - `id` — stable within the file: the element's own id when it has one, otherwise its kind
 *   and position in the file (`track-1`, `waypoint-3`, `placemark-12`).
 * - `kind` — what it was in the file (`track`, `route`, `waypoint`, `placemark`, a TopoJSON
 *   object's name).
 * - `name`, `description`, `time` (ISO 8601, when the file dates it).
 * - `point` — where the object is when that is not the geometry's first coordinate: a
 *   track's last point (the brief: "a track is one object with the last point as position").
 *
 * The default mapping (formats.ts) reads `point` and falls back to `geometry`.
 */
export type Coordinate = [number, number] | [number, number, number];

export interface FileFeature {
  type: 'Feature';
  id: string;
  kind: string;
  name?: string;
  description?: string;
  time?: string;
  geometry: WorldGeometry | null;
  point?: { type: 'Point'; coordinates: Coordinate };
  properties: Record<string, JsonValue>;
}

export interface FeatureReadResult {
  features: FileFeature[];
  /** Elements that could not become a feature, with the reason (reported like rejected records). */
  skipped: Array<{ id: string; reason: string }>;
  /** Things in the file this reader does not follow (a KML NetworkLink), for the log. */
  notes: string[];
}

export type FeatureReader = (text: string, opts: { layers?: string[] }) => FeatureReadResult | { malformed: string };

/** A description kept for the payload: long HTML descriptions are cut, not dropped. */
export const MAX_DESCRIPTION_CHARS = 4096;
/** The world model's line limit (validate.ts: a ring holds at most 100,000 coordinates). */
export const MAX_LINE_POINTS = 100_000;

export function clip(text: string, max?: number): string;
export function clip(text: string | undefined, max?: number): string | undefined;
export function clip(text: string | undefined, max = MAX_DESCRIPTION_CHARS): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A longitude/latitude pair (and altitude) the world model accepts, or undefined. */
export function coordinate(lon: number, lat: number, alt?: number): Coordinate | undefined {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return undefined;
  return alt !== undefined && Number.isFinite(alt) && Math.abs(alt) < 1_000_000 ? [lon, lat, alt] : [lon, lat];
}

const TIME_TEXT = /^(\d{4}-\d{2}(?:-\d{2})?)(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * An ISO 8601 instant from a file's time text, normalised; undefined when it does not parse.
 * A date alone is midnight UTC. A time with no zone is read as UTC — GPX says its times are
 * UTC, and reading them as the machine's local time would date the same file differently on
 * two computers.
 */
export function isoTime(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = TIME_TEXT.exec(text.trim());
  if (!m) return undefined;
  let iso = m[1]!;
  if (m[2]) {
    const zone = m[3] ?? 'Z';
    iso += `T${m[2]}${zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`}`;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle length of a line, in metres (the mean-radius sphere; within 0.5 % of the ellipsoid). */
export function lengthMetres(line: readonly Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const [lon1, lat1] = line[i - 1]!;
    const [lon2, lat2] = line[i]!;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = p2 - p1;
    const dl = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    total += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}

/**
 * A line geometry from segments: one segment of two or more points is a LineString, several
 * are a MultiLineString, a single point is a Point. Segments of one point cannot be lines and
 * are left out of a multi-segment geometry. Undefined when nothing is left.
 */
export function lineGeometry(segments: Coordinate[][]): WorldGeometry | undefined {
  const lines = segments.filter((s) => s.length >= 2);
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0]! };
  if (lines.length > 1) return { type: 'MultiLineString', coordinates: lines };
  const single = segments.find((s) => s.length === 1);
  return single ? { type: 'Point', coordinates: single[0]! } : undefined;
}
