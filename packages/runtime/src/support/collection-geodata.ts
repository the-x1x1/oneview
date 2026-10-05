import type { Collection, CollectionItem } from '@worldview/ipc-contract';

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

const coord = (v: number) => String(Math.round(v * 1e7) / 1e7);

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
      `  <wpt lat="${coord(p.latitude)}" lon="${coord(p.longitude)}">`,
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
    const coordinates = `${coord(p.longitude)},${coord(p.latitude)}${p.altitudeM !== undefined ? `,${Math.round(p.altitudeM * 10) / 10}` : ''}`;
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
            Number(coord(p.longitude)),
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
