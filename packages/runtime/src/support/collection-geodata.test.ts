import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionItem } from '@worldview/ipc-contract';
import { collectionGeodata, geoFormatFor, placesOf, xmlText } from './collection-geodata.js';

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
