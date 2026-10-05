import { readKml } from '@worldview/connector-runtime';
import type { WatchZone } from '@worldview/ipc-contract';
import { simplifyRing, type GeoRegion } from '@worldview/world-model';
import { xmlText } from './collection-geodata.js';

/**
 * Watch zones as shapes other tools read and draw — KML (Google Earth, ATAK) and GeoJSON
 * (QGIS) — and shapes drawn there read back as zones. A circle goes out as a polygon of
 * CIRCLE_VERTICES points (GeoJSON also keeps its centre and radius, so it comes back a circle);
 * a box as its four corners; an admin region only when it carries bounds.
 */
export type ZoneGeoFormat = 'kml' | 'geojson';

export const CIRCLE_VERTICES = 72;
export const MAX_IMPORTED_ZONES = 200;
/** The most points a zone's outline may have (the region schema's limit). */
export const MAX_ZONE_POINTS = 10_000;
/** The largest circle a zone may be (the region schema's limit). */
export const MAX_ZONE_RADIUS_M = 40_000_000;

/**
 * A ring of more than MAX_ZONE_POINTS points made smaller, a tolerance at a time (Douglas–
 * Peucker, from about a centimetre), so a detailed boundary from QGIS still makes a zone.
 */
function withinPointLimit(ring: Array<[number, number]>): { ring: Array<[number, number]>; simplified: boolean } {
  if (ring.length <= MAX_ZONE_POINTS) return { ring, simplified: false };
  const closed: Array<[number, number]> = [...ring, ring[0]!];
  for (let tolerance = 1e-7; tolerance < 1; tolerance *= 2) {
    const smaller = simplifyRing(closed, tolerance, 7);
    if (smaller.length - 1 <= MAX_ZONE_POINTS) return { ring: smaller.slice(0, -1), simplified: true };
  }
  return { ring: ring.slice(0, MAX_ZONE_POINTS), simplified: true };
}
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** The point `distanceM` from `center` along `bearingDeg`, on a sphere. */
function along(lat: number, lon: number, bearingDeg: number, distanceM: number): [number, number] {
  const φ1 = lat * DEG;
  const λ1 = lon * DEG;
  const θ = bearingDeg * DEG;
  const δ = distanceM / EARTH_RADIUS_M;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [((((λ2 / DEG + 180) % 360) + 360) % 360) - 180, φ2 / DEG];
}

/** A zone's outline as [longitude, latitude] pairs, not closed; undefined when it has none. */
export function zoneRing(region: GeoRegion): Array<[number, number]> | undefined {
  switch (region.kind) {
    case 'polygon':
      return region.polygon.length >= 3 ? region.polygon.map(([lon, lat]) => [lon, lat]) : undefined;
    case 'circle': {
      const out: Array<[number, number]> = [];
      // Counterclockwise, as RFC 7946 asks of an outer ring: the bearing runs back from north.
      for (let i = 0; i < CIRCLE_VERTICES; i++)
        out.push(
          along(
            region.center.latitude,
            region.center.longitude,
            i === 0 ? 0 : 360 - (360 * i) / CIRCLE_VERTICES,
            region.radiusM,
          ),
        );
      return out;
    }
    case 'bounds':
    case 'admin': {
      const b = region.kind === 'bounds' ? region.bounds : region.bounds;
      if (!b) return undefined;
      return [
        [b.west, b.south],
        [b.east, b.south],
        [b.east, b.north],
        [b.west, b.north],
      ];
    }
  }
}

const num = (v: number) => {
  const s = (Math.round(v * 1e7) / 1e7).toFixed(7).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

function describe(z: WatchZone): string {
  return [
    z.enabled ? 'Watching' : 'Paused',
    z.eventTypes.length ? `for ${z.eventTypes.join(', ')}` : undefined,
    z.minimumSeverity ? `from ${z.minimumSeverity}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

export function zonesToGeodata(
  format: ZoneGeoFormat,
  zones: readonly WatchZone[],
  exportedAt: string,
): { text: string; written: number; skipped: number } {
  let skipped = 0;
  const shapes: Array<{ zone: WatchZone; ring: Array<[number, number]> }> = [];
  for (const zone of zones) {
    const ring = zoneRing(zone.geometry);
    if (ring) shapes.push({ zone, ring });
    else skipped++;
  }
  if (format === 'kml') {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      '  <Document>',
      '    <name>WorldView watch zones</name>',
      `    <description>${xmlText(`Exported from WorldView ${exportedAt}`)}</description>`,
    ];
    for (const { zone, ring } of shapes) {
      const closed = [...ring, ring[0]!].map(([lon, lat]) => `${num(lon)},${num(lat)}`).join(' ');
      lines.push(
        '    <Placemark>',
        `      <name>${xmlText(zone.name)}</name>`,
        `      <description>${xmlText(describe(zone))}</description>`,
        `      <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${closed}</coordinates></LinearRing></outerBoundaryIs></Polygon>`,
        '    </Placemark>',
      );
    }
    lines.push('  </Document>', '</kml>');
    return { text: lines.join('\n'), written: shapes.length, skipped };
  }
  const features = shapes.map(({ zone, ring }) => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[...ring, ring[0]!].map(([lon, lat]) => [Number(num(lon)), Number(num(lat))])],
    },
    properties: {
      name: zone.name,
      enabled: zone.enabled,
      eventTypes: zone.eventTypes,
      ...(zone.minimumSeverity ? { minimumSeverity: zone.minimumSeverity } : {}),
      ...(zone.geometry.kind === 'circle'
        ? { circle: { center: zone.geometry.center, radiusM: zone.geometry.radiusM } }
        : {}),
    },
  }));
  return {
    text: JSON.stringify({ type: 'FeatureCollection', name: 'WorldView watch zones', exportedAt, features }, null, 2),
    written: shapes.length,
    skipped,
  };
}

export interface ZoneDraft {
  name: string;
  geometry: GeoRegion;
}

/** A ring of [lon, lat] as a zone outline: closing point dropped, at least three points, not across 180°. */
function outline(coords: unknown): Array<[number, number]> | 'antimeridian' | undefined {
  if (!Array.isArray(coords)) return undefined;
  const ring: Array<[number, number]> = [];
  for (const c of coords) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return undefined;
    const [lon, lat] = c as [number, number];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
    ring.push([lon, lat]);
  }
  const first = ring[0];
  const last = ring.at(-1);
  if (first && last && ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
  if (ring.length < 3) return undefined;
  for (let i = 0; i < ring.length; i++)
    if (Math.abs(ring[(i + 1) % ring.length]![0] - ring[i]![0]) > 180) return 'antimeridian';
  return ring;
}

/**
 * The shapes of a KML or GeoJSON file as zone drafts: each polygon's outer ring (holes are not
 * kept), each part of a multipolygon its own zone; a GeoJSON feature WorldView wrote with a
 * `circle` comes back as that circle. Points and lines are not zones; they, shapes across the
 * 180° meridian and bad rings are counted in `issues`.
 */
export function zonesFromGeodata(
  format: ZoneGeoFormat,
  text: string,
): { zones: ZoneDraft[]; issues: string[] } | { malformed: string } {
  const shapes: Array<{ name?: string; rings: unknown[]; circle?: unknown }> = [];
  let notShapes = 0;
  if (format === 'kml') {
    const read = readKml(text);
    if ('malformed' in read) return read;
    notShapes += read.skipped.length;
    for (const f of read.features) {
      const g = f.geometry;
      if (g?.type === 'Polygon') shapes.push({ ...(f.name ? { name: f.name } : {}), rings: [g.coordinates[0]] });
      else if (g?.type === 'MultiPolygon')
        shapes.push({ ...(f.name ? { name: f.name } : {}), rings: g.coordinates.map((p) => p[0]) });
      else notShapes++;
    }
  } else {
    let doc: unknown;
    try {
      doc = JSON.parse(text) as unknown;
    } catch {
      return { malformed: 'not GeoJSON: the file is not valid JSON' };
    }
    const d = doc as { type?: unknown; features?: unknown } | null;
    if (d?.type !== 'FeatureCollection' && d?.type !== 'Feature')
      return { malformed: 'not GeoJSON: no Feature or FeatureCollection' };
    const features = d.type === 'Feature' ? [d] : Array.isArray(d.features) ? (d.features as unknown[]) : [];
    for (const raw of features) {
      const f = raw as {
        geometry?: { type?: unknown; coordinates?: unknown };
        properties?: Record<string, unknown> | null;
      };
      const props = f?.properties ?? {};
      const name =
        typeof props['name'] === 'string'
          ? props['name']
          : typeof props['title'] === 'string'
            ? props['title']
            : undefined;
      const g = f?.geometry;
      const coords = Array.isArray(g?.coordinates) ? (g.coordinates as unknown[]) : [];
      if (g?.type === 'Polygon')
        shapes.push({
          ...(name ? { name } : {}),
          rings: [coords[0]],
          ...(props['circle'] ? { circle: props['circle'] } : {}),
        });
      else if (g?.type === 'MultiPolygon')
        shapes.push({ ...(name ? { name } : {}), rings: coords.map((p) => (Array.isArray(p) ? p[0] : undefined)) });
      else notShapes++;
    }
  }
  const zones: ZoneDraft[] = [];
  let across = 0;
  let bad = 0;
  let simplified = 0;
  for (const shape of shapes) {
    const c = shape.circle as { center?: { latitude?: unknown; longitude?: unknown }; radiusM?: unknown } | undefined;
    if (
      c &&
      typeof c.center?.latitude === 'number' &&
      typeof c.center.longitude === 'number' &&
      typeof c.radiusM === 'number' &&
      c.radiusM > 0 &&
      c.radiusM <= MAX_ZONE_RADIUS_M &&
      Math.abs(c.center.latitude) <= 90 &&
      Math.abs(c.center.longitude) <= 180
    ) {
      zones.push({
        name: (shape.name?.trim() || `Zone ${zones.length + 1}`).slice(0, 200),
        geometry: {
          kind: 'circle',
          center: { latitude: c.center.latitude, longitude: c.center.longitude },
          radiusM: c.radiusM,
        },
      });
      continue;
    }
    shape.rings.forEach((r, i) => {
      const ring = outline(r);
      if (ring === 'antimeridian') across++;
      else if (!ring) bad++;
      else {
        const base = shape.name?.trim() || `Zone ${zones.length + 1}`;
        const fit = withinPointLimit(ring);
        if (fit.simplified) simplified++;
        zones.push({
          name: (shape.rings.length > 1 ? `${base} (${i + 1})` : base).slice(0, 200),
          geometry: { kind: 'polygon', polygon: fit.ring },
        });
      }
    });
  }
  const kept = zones.slice(0, MAX_IMPORTED_ZONES);
  const issues = [
    notShapes ? `${notShapes} points or lines left out: a zone is a shape` : undefined,
    across
      ? `${across} shape${across === 1 ? '' : 's'} across the 180° meridian left out: draw one each side`
      : undefined,
    bad
      ? `${bad} shape${bad === 1 ? '' : 's'} with fewer than three points or a point off the globe left out`
      : undefined,
    zones.length > kept.length ? `only the first ${MAX_IMPORTED_ZONES} shapes read` : undefined,
    simplified
      ? `${simplified} outline${simplified === 1 ? '' : 's'} of more than ${MAX_ZONE_POINTS.toLocaleString('en-US')} points simplified to fit`
      : undefined,
  ].filter((x): x is string => Boolean(x));
  return { zones: kept, issues };
}
