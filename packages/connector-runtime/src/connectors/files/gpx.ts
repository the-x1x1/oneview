import type { JsonValue } from '@worldview/world-model';
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
 * GPX 1.0 and 1.1: waypoints, routes and tracks, each one feature.
 *
 * - A waypoint (`<wpt lat lon>`) is a Point, with its elevation, time, name, description,
 *   symbol and type.
 * - A route (`<rte>`) is a line through its `<rtept>`s — a plan, so it carries no time.
 * - A track (`<trk>`) is one object, not one per point: its geometry is the whole track (a
 *   LineString, or a MultiLineString when it has several `<trkseg>`s), its position is the
 *   last point and its time that point's time. The first and last times, the number of
 *   points and the length go into its properties.
 *
 * Coordinates are WGS 84 by the GPX schema. Times without a zone are UTC (features.ts).
 * A point with a latitude or longitude that is missing or out of range is left out of its
 * track and counted (`invalidPoints`); a waypoint like that is skipped with a reason.
 */
export function readGpx(text: string): FeatureReadResult | { malformed: string } {
  const parsed = parseXml(text);
  if ('malformed' in parsed) return { malformed: `not GPX: ${parsed.malformed}` };
  const root = parsed.root;
  if (root.name.toLowerCase() !== 'gpx') return { malformed: `not GPX: the root element is <${root.qname}>` };
  const out: FeatureReadResult = { features: [], skipped: [], notes: [] };

  childrenNamed(root, 'wpt').forEach((wpt, i) => {
    const id = `waypoint-${i + 1}`;
    const p = readPoint(wpt);
    if (!p) {
      out.skipped.push({ id, reason: 'the waypoint has no valid lat/lon' });
      return;
    }
    const properties: Record<string, JsonValue> = {};
    setIf(properties, 'ele', p.coordinate[2]);
    setIf(properties, 'sym', childText(wpt, 'sym'));
    setIf(properties, 'type', childText(wpt, 'type'));
    setIf(properties, 'comment', clip(childText(wpt, 'cmt')));
    setIf(properties, 'link', linkOf(wpt));
    out.features.push(
      feature(id, 'waypoint', wpt, { type: 'Point', coordinates: p.coordinate }, properties, p.time, undefined),
    );
  });

  childrenNamed(root, 'rte').forEach((rte, i) => {
    const id = `route-${i + 1}`;
    const points: Coordinate[] = [];
    let invalid = 0;
    for (const rtept of childrenNamed(rte, 'rtept')) {
      const p = readPoint(rtept);
      if (p) points.push(p.coordinate);
      else invalid++;
    }
    if (points.length > MAX_LINE_POINTS) {
      out.skipped.push({ id, reason: `the route has more than ${MAX_LINE_POINTS} points` });
      return;
    }
    const geometry = lineGeometry([points]);
    if (!geometry) {
      out.skipped.push({ id, reason: 'the route has no valid points' });
      return;
    }
    const properties: Record<string, JsonValue> = { pointCount: points.length, lengthM: round1(lengthMetres(points)) };
    if (invalid) properties['invalidPoints'] = invalid;
    setIf(properties, 'type', childText(rte, 'type'));
    setIf(properties, 'number', numberOf(childText(rte, 'number')));
    setIf(properties, 'link', linkOf(rte));
    out.features.push(feature(id, 'route', rte, geometry, properties, undefined, undefined));
  });

  childrenNamed(root, 'trk').forEach((trk, i) => {
    const id = `track-${i + 1}`;
    const segments: Coordinate[][] = [];
    let invalid = 0;
    let firstTime: string | undefined;
    let last: { coordinate: Coordinate; time: string | undefined } | undefined;
    let total = 0;
    for (const seg of childrenNamed(trk, 'trkseg')) {
      const points: Coordinate[] = [];
      for (const trkpt of childrenNamed(seg, 'trkpt')) {
        const p = readPoint(trkpt);
        if (!p) {
          invalid++;
          continue;
        }
        points.push(p.coordinate);
        firstTime ??= p.time;
        last = p;
      }
      total += points.length;
      if (points.length > MAX_LINE_POINTS) {
        out.skipped.push({ id, reason: `a segment of the track has more than ${MAX_LINE_POINTS} points` });
        return;
      }
      if (points.length) segments.push(points);
    }
    const geometry = lineGeometry(segments);
    if (!geometry || !last) {
      out.skipped.push({ id, reason: 'the track has no valid points' });
      return;
    }
    const properties: Record<string, JsonValue> = {
      pointCount: total,
      segmentCount: segments.length,
      lengthM: round1(segments.reduce((sum, s) => sum + lengthMetres(s), 0)),
    };
    if (invalid) properties['invalidPoints'] = invalid;
    setIf(properties, 'startTime', firstTime);
    setIf(properties, 'endTime', last.time);
    setIf(properties, 'type', childText(trk, 'type'));
    setIf(properties, 'number', numberOf(childText(trk, 'number')));
    setIf(properties, 'link', linkOf(trk));
    out.features.push(
      feature(id, 'track', trk, geometry, properties, last.time, { type: 'Point', coordinates: last.coordinate }),
    );
  });

  return out;
}

function feature(
  id: string,
  kind: string,
  el: XmlElement,
  geometry: FileFeature['geometry'],
  properties: Record<string, JsonValue>,
  time: string | undefined,
  point: FileFeature['point'],
): FileFeature {
  const f: FileFeature = { type: 'Feature', id, kind, geometry, properties };
  const name = childText(el, 'name');
  const description = clip(childText(el, 'desc') ?? childText(el, 'cmt'));
  if (name) f.name = clip(name, 256);
  if (description) f.description = description;
  if (time) f.time = time;
  if (point) f.point = point;
  return f;
}

function readPoint(el: XmlElement): { coordinate: Coordinate; time: string | undefined } | undefined {
  const lat = numberOf(el.attrs['lat']);
  const lon = numberOf(el.attrs['lon']);
  if (lat === undefined || lon === undefined) return undefined;
  const c = coordinate(lon, lat, numberOf(childText(el, 'ele')));
  return c ? { coordinate: c, time: isoTime(childText(el, 'time')) } : undefined;
}

function linkOf(el: XmlElement): string | undefined {
  const link = child(el, 'link');
  const href = link?.attrs['href']?.trim() ?? childText(el, 'url');
  return href && /^https?:\/\//i.test(href) ? href.slice(0, 2048) : undefined;
}

function numberOf(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function setIf(target: Record<string, JsonValue>, key: string, value: JsonValue | undefined): void {
  if (value !== undefined) target[key] = value;
}
