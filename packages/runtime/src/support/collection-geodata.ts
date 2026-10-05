import { readGpx, readKml, type FeatureReadResult } from '@worldview/connector-runtime';
import type { Collection, CollectionItem } from '@worldview/ipc-contract';
import { splitAtAntimeridian } from '@worldview/render-core';
import type { WorldObject } from '@worldview/world-model';

/**
 * A collection's places as geodata other tools read: GPX waypoints (handheld GPS units, most
 * navigation apps), KML placemarks (Google Earth, ATAK) and GeoJSON points (QGIS and the
 * web). Only items with a position are written; the WorldView collection file (.json) keeps
 * everything. Which items may go out is the caller's choice (handlers.ts: the operator's own
 * places always, a collected object only when its sources allow export).
 */
export type CollectionGeoFormat = 'gpx' | 'kml' | 'geojson';

export interface GeoPlace {
  title: string;
  latitude: number;
  longitude: number;
  altitudeM?: number;
  createdAt: string;
  kind: CollectionItem['kind'];
  note?: string;
  tags?: string[];
  objectId?: string;
}

/** The format a file name asks for, by its extension; undefined for the collection file (.json) or anything else. */
export function geoFormatFor(fileName: string): CollectionGeoFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return ext === 'gpx' || ext === 'kml' || ext === 'geojson' ? ext : undefined;
}

/** The items with a usable position, as places. */
export function placesOf(items: readonly CollectionItem[]): GeoPlace[] {
  const out: GeoPlace[] = [];
  for (const item of items) {
    const p = item.position;
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    if (Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) continue;
    out.push({
      title: item.title,
      latitude: p.latitude,
      longitude: p.longitude,
      ...(p.altitudeM !== undefined && Number.isFinite(p.altitudeM) ? { altitudeM: p.altitudeM } : {}),
      createdAt: item.createdAt,
      kind: item.kind,
      ...(item.note ? { note: item.note } : {}),
      ...(item.tags?.length ? { tags: item.tags } : {}),
      ...(item.objectId ? { objectId: item.objectId } : {}),
    });
  }
  return out;
}

/** Text safe inside an XML element or attribute: the five entities, and no control characters XML forbids. */
export function xmlText(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex -- removing exactly the characters XML 1.0 forbids
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

/** Seven decimals (about a centimetre), never in exponent notation (GPX's xsd:decimal has none). */
const coord = (v: number) => {
  const s = (Math.round(v * 1e7) / 1e7).toFixed(7).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
/** A longitude for a file: −180 rather than 180 (GPX requires it below 180). */
const lonOf = (v: number) => (v >= 180 ? v - 360 : v);

function description(p: GeoPlace): string | undefined {
  const parts = [p.note, p.tags?.length ? `Tags: ${p.tags.join(', ')}` : undefined].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

function validTime(iso: string): string | undefined {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function toGpx(
  collection: Pick<Collection, 'name'>,
  places: readonly GeoPlace[],
  opts: { exportedAt: string; attribution: string[] },
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="WorldView" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${xmlText(collection.name)}</name>`,
    ...(opts.attribution.length ? [`    <desc>${xmlText(`Data: ${opts.attribution.join('; ')}`)}</desc>`] : []),
    `    <time>${xmlText(opts.exportedAt)}</time>`,
    '  </metadata>',
  ];
  for (const p of places) {
    const desc = description(p);
    const time = validTime(p.createdAt);
    lines.push(
      `  <wpt lat="${coord(p.latitude)}" lon="${coord(lonOf(p.longitude))}">`,
      ...(p.altitudeM !== undefined ? [`    <ele>${Math.round(p.altitudeM * 10) / 10}</ele>`] : []),
      ...(time ? [`    <time>${time}</time>`] : []),
      `    <name>${xmlText(p.title)}</name>`,
      ...(desc ? [`    <desc>${xmlText(desc)}</desc>`] : []),
      `    <type>${xmlText(p.kind)}</type>`,
      '  </wpt>',
    );
  }
  lines.push('</gpx>');
  return lines.join('\n');
}

export function toKml(
  collection: Pick<Collection, 'name'>,
  places: readonly GeoPlace[],
  opts: { exportedAt: string; attribution: string[] },
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${xmlText(collection.name)}</name>`,
    `    <description>${xmlText(
      [
        `Exported from WorldView ${opts.exportedAt}`,
        ...(opts.attribution.length ? [`Data: ${opts.attribution.join('; ')}`] : []),
      ].join('\n'),
    )}</description>`,
  ];
  for (const p of places) {
    const desc = description(p);
    const time = validTime(p.createdAt);
    const coordinates = `${coord(lonOf(p.longitude))},${coord(p.latitude)}${p.altitudeM !== undefined ? `,${Math.round(p.altitudeM * 10) / 10}` : ''}`;
    lines.push(
      '    <Placemark>',
      `      <name>${xmlText(p.title)}</name>`,
      ...(desc ? [`      <description>${xmlText(desc)}</description>`] : []),
      ...(time ? [`      <TimeStamp><when>${time}</when></TimeStamp>`] : []),
      // An altitude is above sea level; without one the point sits on the ground.
      `      <Point>${p.altitudeM !== undefined ? '<altitudeMode>absolute</altitudeMode>' : ''}<coordinates>${coordinates}</coordinates></Point>`,
      '    </Placemark>',
    );
  }
  lines.push('  </Document>', '</kml>');
  return lines.join('\n');
}

export function toCollectionGeoJson(
  collection: Pick<Collection, 'name'>,
  places: readonly GeoPlace[],
  opts: { exportedAt: string; attribution: string[] },
): string {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      name: collection.name,
      exportedAt: opts.exportedAt,
      ...(opts.attribution.length ? { attribution: opts.attribution } : {}),
      features: places.map((p) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [
            Number(coord(lonOf(p.longitude))),
            Number(coord(p.latitude)),
            ...(p.altitudeM !== undefined ? [Math.round(p.altitudeM * 10) / 10] : []),
          ],
        },
        properties: {
          title: p.title,
          kind: p.kind,
          createdAt: p.createdAt,
          ...(p.note ? { note: p.note } : {}),
          ...(p.tags ? { tags: p.tags } : {}),
          ...(p.objectId ? { objectId: p.objectId } : {}),
        },
      })),
    },
    null,
    2,
  );
}

export function collectionGeodata(
  format: CollectionGeoFormat,
  collection: Pick<Collection, 'name'>,
  places: readonly GeoPlace[],
  opts: { exportedAt: string; attribution: string[] },
): string {
  if (format === 'gpx') return toGpx(collection, places, opts);
  if (format === 'kml') return toKml(collection, places, opts);
  return toCollectionGeoJson(collection, places, opts);
}

// ---- reading places back in ------------------------------------------------------------

/** At most this many places become a collection (a collection holds 2,000 items). */
export const MAX_IMPORTED_PLACES = 2000;

type PointFeature = { name?: string; description?: string; time?: string; coordinates: number[] };

/** The point features of a GeoJSON text: Points, and each point of a MultiPoint. */
function geoJsonPoints(text: string): { points: PointFeature[]; skipped: number } | { malformed: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch {
    return { malformed: 'not GeoJSON: the file is not valid JSON' };
  }
  const d = doc as { type?: unknown; features?: unknown } | null;
  const features: unknown[] =
    d?.type === 'FeatureCollection' && Array.isArray(d.features) ? d.features : d?.type === 'Feature' ? [d] : [];
  if (d?.type !== 'FeatureCollection' && d?.type !== 'Feature')
    return { malformed: 'not GeoJSON: no Feature or FeatureCollection' };
  const points: PointFeature[] = [];
  let skipped = 0;
  for (const raw of features) {
    const f = raw as {
      geometry?: { type?: unknown; coordinates?: unknown };
      properties?: Record<string, unknown> | null;
    } | null;
    const props = f?.properties ?? {};
    const text = (k: string) => (typeof props[k] === 'string' ? (props[k] as string) : undefined);
    const name = text('title') ?? text('name');
    const description = text('note') ?? text('description');
    const time = text('createdAt') ?? text('time');
    const g = f?.geometry;
    const coords =
      g?.type === 'Point'
        ? [g.coordinates]
        : g?.type === 'MultiPoint' && Array.isArray(g.coordinates)
          ? g.coordinates
          : [];
    if (!coords.length) skipped++;
    for (const c of coords as unknown[])
      if (Array.isArray(c) && c.length >= 2 && c.slice(0, 3).every((v) => typeof v === 'number'))
        points.push({
          coordinates: c as number[],
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(time ? { time } : {}),
        });
      else skipped++;
  }
  return { points, skipped };
}

/** The point features a GPX or KML reader found (waypoints, placemarks); lines and shapes are counted, not kept. */
function readerPoints(result: FeatureReadResult): { points: PointFeature[]; skipped: number } {
  const points: PointFeature[] = [];
  let skipped = result.skipped.length;
  for (const f of result.features) {
    if (f.geometry?.type !== 'Point') {
      skipped++;
      continue;
    }
    points.push({
      coordinates: f.geometry.coordinates,
      ...(f.name ? { name: f.name } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.time ? { time: f.time } : {}),
    });
  }
  return { points, skipped };
}

/**
 * A GPX, KML or GeoJSON file as a new collection of places: each waypoint, placemark or point
 * one location, named as the file names it, its description the note, dated by its own time or
 * else the file's (`fileTime`), so the same file read twice gives the same collection. Tracks,
 * routes, lines and shapes are not places and are counted in `skipped`, as are points off the
 * globe.
 */
export function collectionFromGeodata(
  format: CollectionGeoFormat,
  text: string,
  opts: { name: string; nowIso: string; fileTime: string },
): { collection: Collection; skipped: number } | { malformed: string } {
  const read =
    format === 'geojson'
      ? geoJsonPoints(text)
      : (() => {
          const r = format === 'gpx' ? readGpx(text) : readKml(text);
          return 'malformed' in r ? r : readerPoints(r);
        })();
  if ('malformed' in read) return read;
  let skipped = read.skipped;
  const items: CollectionItem[] = [];
  for (const p of read.points) {
    const [lon, lat, alt] = p.coordinates as [number, number, number | undefined];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      skipped++;
      continue;
    }
    if (items.length >= MAX_IMPORTED_PLACES) {
      skipped++;
      continue;
    }
    const createdAt =
      p.time && Number.isFinite(Date.parse(p.time)) ? new Date(Date.parse(p.time)).toISOString() : opts.fileTime;
    items.push({
      id: `place-${items.length + 1}`,
      kind: 'location',
      title: (p.name?.trim() || `Place ${items.length + 1}`).slice(0, 200),
      createdAt,
      updatedAt: createdAt,
      position: {
        latitude: lat,
        longitude: lon,
        ...(typeof alt === 'number' && Number.isFinite(alt) ? { altitudeM: alt } : {}),
      },
      ...(p.description?.trim() ? { note: p.description.trim().slice(0, 4000) } : {}),
    });
  }
  // `places-` keeps a file's collection apart from one exported under the same name, so the same
  // file imported twice is recognised as the same collection rather than copied again.
  const slug = opts.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const id = `places-${slug || 'imported'}`;
  return {
    collection: {
      id,
      name: opts.name.slice(0, 200) || 'Imported places',
      createdAt: opts.nowIso,
      updatedAt: opts.nowIso,
      items,
    },
    skipped,
  };
}

// ---- the measure tool's line ---------------------------------------------------------------

export const MAX_LINE_EXPORT_POINTS = 500;

/**
 * The operator's measured line as GPX (a route — GPX has no shapes, so a closed shape is a
 * route back to its start), KML (a line on the ground, or a polygon when closed) or GeoJSON
 * (a LineString, or a Polygon when closed).
 */
export function lineGeodata(
  format: CollectionGeoFormat,
  name: string,
  points: ReadonlyArray<{ latitude: number; longitude: number }>,
  closed: boolean,
  exportedAt: string,
): string {
  const ring = closed && points.length >= 3 ? [...points, points[0]!] : [...points];
  if (format === 'gpx') {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="WorldView" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <metadata>',
      `    <name>${xmlText(name)}</name>`,
      `    <time>${xmlText(exportedAt)}</time>`,
      '  </metadata>',
      '  <rte>',
      `    <name>${xmlText(name)}</name>`,
      ...ring.map(
        (p, i) =>
          `    <rtept lat="${coord(p.latitude)}" lon="${coord(lonOf(p.longitude))}"><name>${i === points.length ? '1' : i + 1}</name></rtept>`,
      ),
      '  </rte>',
      '</gpx>',
    ].join('\n');
  }
  if (format === 'kml') {
    const coordinates = ring.map((p) => `${coord(lonOf(p.longitude))},${coord(p.latitude)}`).join(' ');
    const geometry =
      closed && points.length >= 3
        ? `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
        : `<LineString><tessellate>1</tessellate><coordinates>${coordinates}</coordinates></LineString>`;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      '  <Document>',
      `    <name>${xmlText(name)}</name>`,
      `    <description>${xmlText(`Measured in WorldView ${exportedAt}`)}</description>`,
      '    <Placemark>',
      `      <name>${xmlText(name)}</name>`,
      `      ${geometry}`,
      '    </Placemark>',
      '  </Document>',
      '</kml>',
    ].join('\n');
  }
  const pair = (p: { latitude: number; longitude: number }) => [
    Number(coord(lonOf(p.longitude))),
    Number(coord(p.latitude)),
  ];
  const coordinates = ring.map(pair);
  // RFC 7946 §3.1.9: a line that crosses the antimeridian is cut there, or readers draw it the
  // long way round. (A shape across it is written whole: cutting a polygon is not done here.)
  const pieces = closed && points.length >= 3 ? [] : splitAtAntimeridian(ring).filter((piece) => piece.length >= 2);
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      name,
      exportedAt,
      features: [
        {
          type: 'Feature',
          geometry:
            closed && points.length >= 3
              ? { type: 'Polygon', coordinates: [coordinates] }
              : pieces.length > 1
                ? { type: 'MultiLineString', coordinates: pieces.map((piece) => piece.map(pair)) }
                : { type: 'LineString', coordinates },
          properties: { name },
        },
      ],
    },
    null,
    2,
  );
}

// ---- objects on the map, as placemarks --------------------------------------------------------

/** What an object is called in a file: its callsign, name or title, else its id. */
function objectName(o: WorldObject): string {
  return o.labels['callsign'] ?? o.labels['name'] ?? o.labels['title'] ?? o.labels['registration'] ?? o.id;
}

/**
 * Objects with a position as KML placemarks (Google Earth, ATAK), one folder per type, each
 * named as the map names it, dated when it was observed, at its altitude when it has one; the
 * sources' credit in the document's description. Objects without a position are left out.
 */
export function objectsToKml(
  objects: readonly WorldObject[],
  attribution: readonly string[],
  exportedAt: string,
): string {
  const byType = new Map<string, WorldObject[]>();
  for (const o of objects) {
    if (!o.position || !Number.isFinite(o.position.latitude) || !Number.isFinite(o.position.longitude)) continue;
    const list = byType.get(o.type) ?? [];
    list.push(o);
    byType.set(o.type, list);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    '    <name>WorldView export</name>',
    `    <description>${xmlText(
      [
        `Exported from WorldView ${exportedAt}`,
        ...(attribution.length ? [`Data: ${attribution.join('; ')}`] : []),
      ].join('\n'),
    )}</description>`,
  ];
  for (const [type, list] of [...byType.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    lines.push('    <Folder>', `      <name>${xmlText(type)}</name>`);
    for (const o of list) {
      const p = o.position!;
      const alt =
        p.altitudeM !== undefined && Number.isFinite(p.altitudeM) ? Math.round(p.altitudeM * 10) / 10 : undefined;
      const time = validTime(o.observedAt);
      const desc = [
        `${o.type} · ${o.provenance.sourceName}`,
        time ? `observed ${time}` : undefined,
        o.provenance.attribution,
      ]
        .filter(Boolean)
        .join('\n');
      lines.push(
        '      <Placemark>',
        `        <name>${xmlText(objectName(o))}</name>`,
        `        <description>${xmlText(desc)}</description>`,
        ...(time ? [`        <TimeStamp><when>${time}</when></TimeStamp>`] : []),
        `        <Point>${alt !== undefined ? '<altitudeMode>absolute</altitudeMode>' : ''}<coordinates>${coord(lonOf(p.longitude))},${coord(p.latitude)}${alt !== undefined ? `,${alt}` : ''}</coordinates></Point>`,
        '      </Placemark>',
      );
    }
    lines.push('    </Folder>');
  }
  lines.push('  </Document>', '</kml>');
  return lines.join('\n');
}

// ---- a recorded track -------------------------------------------------------------------------

export interface TrackPointOut {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeM?: number;
}

/**
 * An object's recorded track as a GPX track (one segment, each point timed and, with an
 * altitude, its elevation — what GPS tools replay) or a KML line through the points at their
 * altitudes, spanning the track's times.
 */
export function trackGeodata(
  format: 'gpx' | 'kml',
  name: string,
  points: readonly TrackPointOut[],
  opts: { exportedAt: string; attribution: string[] },
): string {
  const alt = (p: TrackPointOut) =>
    p.altitudeM !== undefined && Number.isFinite(p.altitudeM) ? Math.round(p.altitudeM * 10) / 10 : undefined;
  if (format === 'gpx') {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="WorldView" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <metadata>',
      `    <name>${xmlText(name)}</name>`,
      ...(opts.attribution.length ? [`    <desc>${xmlText(`Data: ${opts.attribution.join('; ')}`)}</desc>`] : []),
      `    <time>${xmlText(opts.exportedAt)}</time>`,
      '  </metadata>',
      '  <trk>',
      `    <name>${xmlText(name)}</name>`,
      '    <trkseg>',
      ...points.map((p) => {
        const a = alt(p);
        const t = validTime(p.observedAt);
        return `      <trkpt lat="${coord(p.latitude)}" lon="${coord(lonOf(p.longitude))}">${a !== undefined ? `<ele>${a}</ele>` : ''}${t ? `<time>${t}</time>` : ''}</trkpt>`;
      }),
      '    </trkseg>',
      '  </trk>',
      '</gpx>',
    ].join('\n');
  }
  const withAlt = points.some((p) => alt(p) !== undefined);
  const coordinates = points
    .map((p) => `${coord(lonOf(p.longitude))},${coord(p.latitude)}${withAlt ? `,${alt(p) ?? 0}` : ''}`)
    .join(' ');
  const begin = validTime(points[0]?.observedAt ?? '');
  const end = validTime(points.at(-1)?.observedAt ?? '');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${xmlText(name)}</name>`,
    `    <description>${xmlText(
      [
        `Exported from WorldView ${opts.exportedAt}`,
        ...(opts.attribution.length ? [`Data: ${opts.attribution.join('; ')}`] : []),
      ].join('\n'),
    )}</description>`,
    '    <Placemark>',
    `      <name>${xmlText(name)}</name>`,
    ...(begin && end ? [`      <TimeSpan><begin>${begin}</begin><end>${end}</end></TimeSpan>`] : []),
    `      <LineString>${withAlt ? '<altitudeMode>absolute</altitudeMode>' : '<tessellate>1</tessellate>'}<coordinates>${coordinates}</coordinates></LineString>`,
    '    </Placemark>',
    '  </Document>',
    '</kml>',
  ].join('\n');
}
