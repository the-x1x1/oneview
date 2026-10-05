import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchZone } from '@worldview/ipc-contract';
import { haversineMeters } from '@worldview/world-model';
import { CIRCLE_VERTICES, zoneRing, zonesFromGeodata, zonesToGeodata } from './zone-geodata.js';

const at = '2026-10-05T00:00:00.000Z';
const zone = (over: Partial<WatchZone>): WatchZone => ({
  id: 'z',
  name: 'Zone',
  geometry: { kind: 'circle', center: { latitude: 19.41, longitude: -155.28 }, radiusM: 20_000 },
  eventTypes: ['earthquake'],
  notifications: { inApp: true, desktop: false },
  enabled: true,
  createdAt: at,
  ...over,
});
const zones: WatchZone[] = [
  zone({ id: 'a', name: 'Kīlauea & "summit"' }),
  zone({
    id: 'b',
    name: 'Big Island box',
    geometry: { kind: 'bounds', bounds: { west: -156.1, south: 18.9, east: -154.8, north: 20.3 } },
    enabled: false,
  }),
  zone({
    id: 'c',
    name: 'Saddle',
    geometry: {
      kind: 'polygon',
      polygon: [
        [-155.6, 19.7],
        [-155.3, 19.8],
        [-155.4, 19.6],
      ],
    },
    minimumSeverity: 'MODERATE',
  }),
  zone({ id: 'd', name: 'Hawaii (admin)', geometry: { kind: 'admin', regionId: 'iso3166-2:US-HI' } }),
];

test('a circle is drawn as a ring of points at its radius; a box as its corners', () => {
  const ring = zoneRing(zones[0]!.geometry)!;
  assert.equal(ring.length, CIRCLE_VERTICES);
  for (const [lon, lat] of ring)
    near(haversineMeters({ latitude: 19.41, longitude: -155.28 }, { latitude: lat, longitude: lon }), 20_000, 1);
  assert.deepEqual(zoneRing(zones[1]!.geometry), [
    [-156.1, 18.9],
    [-154.8, 18.9],
    [-154.8, 20.3],
    [-156.1, 20.3],
  ]);
  assert.equal(zoneRing(zones[3]!.geometry), undefined, 'an admin region without bounds has no outline');
});

test('KML: one closed polygon per zone, named and described; and the same shapes read back', () => {
  const out = zonesToGeodata('kml', zones, at);
  assert.equal(out.written, 3);
  assert.equal(out.skipped, 1);
  assert.match(out.text, /<name>Kīlauea &amp; &quot;summit&quot;<\/name>/);
  assert.match(out.text, /<description>Paused for earthquake<\/description>/);
  assert.match(out.text, /<description>Watching for earthquake from MODERATE<\/description>/);
  assert.match(out.text, /<coordinates>-155.6,19.7 -155.3,19.8 -155.4,19.6 -155.6,19.7<\/coordinates>/);
  const back = zonesFromGeodata('kml', out.text);
  assert.ok(!('malformed' in back));
  if ('malformed' in back) return;
  assert.deepEqual(
    back.zones.map((z) => [z.name, z.geometry.kind]),
    [
      ['Kīlauea & "summit"', 'polygon'],
      ['Big Island box', 'polygon'],
      ['Saddle', 'polygon'],
    ],
  );
  assert.deepEqual(
    back.zones[2]!.geometry,
    {
      kind: 'polygon',
      polygon: [
        [-155.6, 19.7],
        [-155.3, 19.8],
        [-155.4, 19.6],
      ],
    },
    'closing point dropped',
  );
  assert.deepEqual(back.issues, []);
});

test('GeoJSON: a circle keeps its centre and radius and comes back a circle', () => {
  const out = zonesToGeodata('geojson', zones, at);
  const doc = JSON.parse(out.text) as { features: Array<{ properties: Record<string, unknown> }> };
  assert.deepEqual(doc.features[0]!.properties['circle'], {
    center: { latitude: 19.41, longitude: -155.28 },
    radiusM: 20_000,
  });
  assert.equal(doc.features[1]!.properties['enabled'], false);
  const back = zonesFromGeodata('geojson', out.text);
  assert.ok(!('malformed' in back));
  if ('malformed' in back) return;
  assert.deepEqual(back.zones[0]!.geometry, {
    kind: 'circle',
    center: { latitude: 19.41, longitude: -155.28 },
    radiusM: 20_000,
  });
});

test('reading shapes: holes and points are not zones, a multipolygon is several, 180° is refused', () => {
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-155, 19] }, properties: { name: 'A point' } },
      {
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [-155, 19],
                [-154.9, 19],
                [-154.9, 19.1],
                [-155, 19],
              ],
              [
                [-154.97, 19.02],
                [-154.95, 19.02],
                [-154.95, 19.04],
                [-154.97, 19.02],
              ],
            ],
            [
              [
                [-156, 20],
                [-155.9, 20],
                [-155.9, 20.1],
                [-156, 20],
              ],
            ],
          ],
        },
        properties: { name: 'Two islands' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [179.5, -17],
              [-179.5, -17.5],
              [179.8, -18],
              [179.5, -17],
            ],
          ],
        },
        properties: { name: 'Fiji' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        properties: {},
      },
    ],
  });
  const read = zonesFromGeodata('geojson', geojson);
  assert.ok(!('malformed' in read));
  if ('malformed' in read) return;
  assert.deepEqual(
    read.zones.map((z) => z.name),
    ['Two islands (1)', 'Two islands (2)'],
  );
  assert.equal(
    (read.zones[0]!.geometry as { polygon: unknown[] }).polygon.length,
    3,
    'the outer ring only, closing point dropped',
  );
  assert.deepEqual(read.issues, [
    '1 points or lines left out: a zone is a shape',
    '1 shape across the 180° meridian left out: draw one each side',
    '1 shape with fewer than three points or a point off the globe left out',
  ]);
  assert.ok('malformed' in zonesFromGeodata('geojson', '[1,2'));
  assert.ok('malformed' in zonesFromGeodata('kml', '<kml'));
});

function near(a: number, b: number, tol: number) {
  assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
}
