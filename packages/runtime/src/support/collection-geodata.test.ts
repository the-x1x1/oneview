import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionItem } from '@worldview/ipc-contract';
import {
  collectionFromGeodata,
  collectionGeodata,
  geoFormatFor,
  lineGeodata,
  placesOf,
  xmlText,
} from './collection-geodata.js';

const item = (over: Partial<CollectionItem>): CollectionItem => ({
  id: 'i',
  kind: 'location',
  title: 'Place',
  createdAt: '2026-10-05T17:00:00.000Z',
  updatedAt: '2026-10-05T17:00:00.000Z',
  ...over,
});

const items: CollectionItem[] = [
  item({
    id: 'a',
    title: 'Mauna Kea <summit> & "visitors"',
    position: { latitude: 19.8207, longitude: -155.468 },
    note: 'Road closes at dusk',
    tags: ['observatory', 'road'],
  }),
  item({
    id: 'b',
    kind: 'object',
    title: 'HAL123',
    objectId: 'aircraft:icao24:abc',
    position: { latitude: 21.3, longitude: -157.9, altitudeM: 3048 },
  }),
  item({ id: 'c', kind: 'note', title: 'No position' }),
  item({ id: 'd', title: 'Off the globe', position: { latitude: 95, longitude: 0 } }),
];
const opts = { exportedAt: '2026-10-05T17:30:00.000Z', attribution: ['adsb.lol (ODbL)'] };

test('only items with a position on the globe become places', () => {
  const places = placesOf(items);
  assert.deepEqual(
    places.map((p) => p.title),
    ['Mauna Kea <summit> & "visitors"', 'HAL123'],
  );
  assert.equal(places[1]!.altitudeM, 3048);
  assert.equal(geoFormatFor('trip.GPX'), 'gpx');
  assert.equal(geoFormatFor('trip.worldview-collection.json'), undefined);
});

test('GPX 1.1: one waypoint each, names escaped, notes and tags as the description, the data credited', () => {
  const gpx = collectionGeodata('gpx', { name: 'Big Island & Oʻahu' }, placesOf(items), opts);
  assert.match(
    gpx,
    /^<\?xml version="1.0" encoding="UTF-8"\?>\n<gpx version="1.1" creator="WorldView" xmlns="http:\/\/www.topografix.com\/GPX\/1\/1">/,
  );
  assert.match(gpx, /<name>Big Island &amp; Oʻahu<\/name>/);
  assert.match(gpx, /<desc>Data: adsb.lol \(ODbL\)<\/desc>/);
  assert.equal((gpx.match(/<wpt /g) ?? []).length, 2);
  assert.match(
    gpx,
    /<wpt lat="19.8207" lon="-155.468">\n {4}<time>2026-10-05T17:00:00.000Z<\/time>\n {4}<name>Mauna Kea &lt;summit&gt; &amp; &quot;visitors&quot;<\/name>\n {4}<desc>Road closes at dusk\nTags: observatory, road<\/desc>\n {4}<type>location<\/type>/,
  );
  assert.match(gpx, /<wpt lat="21.3" lon="-157.9">\n {4}<ele>3048<\/ele>/);
  assert.ok(gpx.trimEnd().endsWith('</gpx>'));
});

test('KML 2.2: placemarks with longitude first, an altitude only where there is one', () => {
  const kml = collectionGeodata('kml', { name: 'Trip' }, placesOf(items), opts);
  assert.match(kml, /<kml xmlns="http:\/\/www.opengis.net\/kml\/2.2">/);
  assert.match(kml, /<Point><coordinates>-155.468,19.8207<\/coordinates><\/Point>/);
  assert.match(
    kml,
    /<Point><altitudeMode>absolute<\/altitudeMode><coordinates>-157.9,21.3,3048<\/coordinates><\/Point>/,
  );
  assert.match(kml, /<TimeStamp><when>2026-10-05T17:00:00.000Z<\/when><\/TimeStamp>/);
  assert.match(
    kml,
    /<description>Exported from WorldView 2026-10-05T17:30:00.000Z\nData: adsb.lol \(ODbL\)<\/description>/,
  );
});

test('GeoJSON: points with the title, kind, note and tags; the credit at the top', () => {
  const doc = JSON.parse(collectionGeodata('geojson', { name: 'Trip' }, placesOf(items), opts)) as {
    type: string;
    attribution: string[];
    features: Array<{ geometry: { coordinates: number[] }; properties: Record<string, unknown> }>;
  };
  assert.equal(doc.type, 'FeatureCollection');
  assert.deepEqual(doc.attribution, ['adsb.lol (ODbL)']);
  assert.deepEqual(doc.features[0]!.geometry.coordinates, [-155.468, 19.8207]);
  assert.deepEqual(doc.features[0]!.properties['tags'], ['observatory', 'road']);
  assert.deepEqual(doc.features[1]!.geometry.coordinates, [-157.9, 21.3, 3048]);
  assert.equal(doc.features[1]!.properties['objectId'], 'aircraft:icao24:abc');
});

test('XML text: the five entities, and the control characters XML 1.0 forbids dropped', () => {
  assert.equal(xmlText(`a&b<c>"d"'e'\u0001\u0007f\tg`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;f\tg');
});

test('reading places back: what was exported comes back as the same places, in each format', () => {
  const places = placesOf(items);
  for (const format of ['gpx', 'kml', 'geojson'] as const) {
    const text = collectionGeodata(format, { name: 'Trip' }, places, opts);
    const read = collectionFromGeodata(format, text, {
      name: 'Big Island trip',
      nowIso: '2026-10-05T18:00:00.000Z',
      fileTime: '2026-10-05T17:45:00.000Z',
    });
    assert.ok(!('malformed' in read), format);
    if ('malformed' in read) continue;
    assert.equal(read.collection.id, 'places-big-island-trip');
    assert.equal(read.skipped, 0, format);
    const back = read.collection.items;
    assert.deepEqual(
      back.map((i) => [i.kind, i.title, i.position?.latitude, i.position?.longitude]),
      [
        ['location', 'Mauna Kea <summit> & "visitors"', 19.8207, -155.468],
        ['location', 'HAL123', 21.3, -157.9],
      ],
      format,
    );
    assert.equal(back[1]!.position?.altitudeM, 3048, `${format}: the altitude`);
    assert.equal(back[0]!.createdAt, '2026-10-05T17:00:00.000Z', `${format}: the time in the file`);
    assert.match(back[0]!.note ?? '', /Road closes at dusk/, format);
  }
});

test('reading places: lines and shapes are not places; nothing readable is said so', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
    <wpt lat="19.72" lon="-155.09"><name>Hilo</name></wpt>
    <wpt lat="99" lon="0"><name>Nowhere</name></wpt>
    <trk><name>Drive</name><trkseg><trkpt lat="19.7" lon="-155.1"/><trkpt lat="19.8" lon="-155.4"/></trkseg></trk>
  </gpx>`;
  const read = collectionFromGeodata('gpx', gpx, { name: 'x', nowIso: 'n', fileTime: '2026-10-01T00:00:00.000Z' });
  assert.ok(!('malformed' in read));
  if ('malformed' in read) return;
  assert.deepEqual(
    read.collection.items.map((i) => i.title),
    ['Hilo'],
  );
  assert.equal(read.collection.items[0]!.createdAt, '2026-10-01T00:00:00.000Z', 'no time of its own: the file’s');
  assert.equal(read.skipped, 2, 'the waypoint off the globe and the track');
  assert.ok('malformed' in collectionFromGeodata('kml', 'not xml at all <', { name: 'x', nowIso: 'n', fileTime: 'f' }));
  assert.ok(
    'malformed' in collectionFromGeodata('geojson', '{"type":"Topology"}', { name: 'x', nowIso: 'n', fileTime: 'f' }),
  );
});

test("the measure tool's line: a GPX route, a KML line or polygon, GeoJSON — and it reads back as nothing but shapes", () => {
  const pts = [
    { latitude: 19.72, longitude: -155.09 },
    { latitude: 19.82, longitude: -155.47 },
    { latitude: 20.02, longitude: -155.67 },
  ];
  const gpx = lineGeodata('gpx', 'Hilo to Waimea', pts, false, '2026-10-05T18:00:00.000Z');
  assert.match(
    gpx,
    /<rte>\n {4}<name>Hilo to Waimea<\/name>\n {4}<rtept lat="19.72" lon="-155.09"><name>1<\/name><\/rtept>/,
  );
  assert.equal((gpx.match(/<rtept /g) ?? []).length, 3);
  const loop = lineGeodata('gpx', 'Loop', pts, true, '2026-10-05T18:00:00.000Z');
  assert.equal((loop.match(/<rtept /g) ?? []).length, 4, 'a closed shape is a route back to its start');
  const kml = lineGeodata('kml', 'Area', pts, true, '2026-10-05T18:00:00.000Z');
  assert.match(
    kml,
    /<Polygon><tessellate>1<\/tessellate><outerBoundaryIs><LinearRing><coordinates>-155.09,19.72 -155.47,19.82 -155.67,20.02 -155.09,19.72<\/coordinates>/,
  );
  assert.match(
    lineGeodata('kml', 'Line', pts, false, 'x'),
    /<LineString><tessellate>1<\/tessellate><coordinates>-155.09,19.72 /,
  );
  const gj = JSON.parse(lineGeodata('geojson', 'Area', pts, true, 'x')) as {
    features: Array<{ geometry: { type: string; coordinates: number[][][] } }>;
  };
  assert.equal(gj.features[0]!.geometry.type, 'Polygon');
  assert.deepEqual(gj.features[0]!.geometry.coordinates[0]!.at(-1), [-155.09, 19.72]);
  // Across the antimeridian a GeoJSON line is cut there (RFC 7946); KML and GPX keep it whole.
  const across = JSON.parse(
    lineGeodata(
      'geojson',
      'Across',
      [
        { latitude: -17, longitude: 178 },
        { latitude: -18, longitude: -178 },
      ],
      false,
      'x',
    ),
  ) as { features: Array<{ geometry: { type: string; coordinates: number[][][] } }> };
  assert.equal(across.features[0]!.geometry.type, 'MultiLineString');
  assert.equal(across.features[0]!.geometry.coordinates.length, 2);
  // Plain decimals, and −180 rather than 180 (GPX wants a longitude below 180).
  const edge = lineGeodata(
    'gpx',
    'Edge',
    [
      { latitude: 0.0000001, longitude: 180 },
      { latitude: 1, longitude: 179 },
    ],
    false,
    'x',
  );
  assert.match(edge, /<rtept lat="0.0000001" lon="-180">/);
  // Imported as a collection, a line has no places in it.
  const back = collectionFromGeodata('kml', kml, { name: 'x', nowIso: 'n', fileTime: '2026-10-05T00:00:00.000Z' });
  assert.ok(!('malformed' in back) && back.collection.items.length === 0 && back.skipped === 1);
});
