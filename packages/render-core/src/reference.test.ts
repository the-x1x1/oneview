import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_BORDERS_FORMAT,
  REFERENCE_LABELS_FORMAT,
  decodeReferenceBorders,
  decodeReferenceLabels,
  labelVisibleAt,
  lineVisibleAt,
  referenceLabelsGeoJSON,
  referenceLinesGeoJSON,
} from './reference.js';

// Rows as tools/dev/reference-data/build.mjs writes them: [z, flags, x0, y0, dx, dy, …] in 1/1000°.
const borders = {
  format: REFERENCE_BORDERS_FORMAT,
  quantisation: 0.001,
  countries: [
    [0, 0, -120000, 49000, 5000, 0, 5000, 1],
    [0, 1, 74000, 34000, 100, 200],
    [0, 0, 1, 2], // too short: skipped
    [0, 0, 999999, 0, 1, 1], // off the globe: skipped
  ],
  states: [[2, 0, -155500, 19500, 250, 250]],
};

test('reference: borders decode to degrees with bounds, dashed flag and min zoom', () => {
  const lines = decodeReferenceBorders(borders);
  assert.equal(lines.length, 3);
  const [us, kashmir, hawaii] = lines;
  assert.equal(us!.kind, 'country');
  assert.deepEqual([...us!.coords], [-120, 49, -115, 49, -110, 49.001]);
  assert.deepEqual(us!.bbox, [-120, 49, -110, 49.001]);
  assert.equal(us!.dashed, false);
  assert.equal(kashmir!.dashed, true);
  assert.equal(hawaii!.kind, 'state');
  assert.equal(hawaii!.minZoom, 2);
  assert.equal(lineVisibleAt(hawaii!, 1.9), false);
  assert.equal(lineVisibleAt(hawaii!, 2), true);
  assert.throws(() => decodeReferenceBorders({ format: 'something-else' }));
});

test('reference: labels decode, keep their zoom range, and skip what is malformed', () => {
  const labels = decodeReferenceLabels({
    format: REFERENCE_LABELS_FORMAT,
    countries: [
      ['United States of America', -97.5, 39.5, 1.7, 5.7, 2],
      ['', 0, 0, 1, 5, 1],
      ['Nowhere', 500, 0, 1, 5, 1],
    ],
    states: [['Hawaii', -157, 20.5, 3.5, 9, 2, 'USA']],
  });
  assert.deepEqual(
    labels.map((l) => [l.kind, l.name, l.country]),
    [
      ['country', 'United States of America', undefined],
      ['state', 'Hawaii', 'USA'],
    ],
  );
  const usa = labels[0]!;
  assert.equal(labelVisibleAt(usa, 1.5), false);
  assert.equal(labelVisibleAt(usa, 3), true);
  assert.equal(labelVisibleAt(usa, 6), false, 'past its max zoom the country name is not information');
});

test('reference: GeoJSON for a 2D renderer', () => {
  const lines = decodeReferenceBorders(borders);
  const fc = referenceLinesGeoJSON(lines);
  assert.equal(fc.features.length, 3);
  assert.deepEqual(fc.features[0]!.geometry.coordinates[0], [-120, 49]);
  assert.deepEqual(fc.features[1]!.properties, { kind: 'country', minZoom: 0, dashed: true });
  assert.equal(referenceLinesGeoJSON(lines, 'state').features.length, 1);
  const labels = referenceLabelsGeoJSON([
    { kind: 'state', name: 'Hawaii', lon: -157, lat: 20.5, minZoom: 3.5, maxZoom: 9, rank: 2 },
  ]);
  assert.deepEqual(labels.features[0]!.geometry.coordinates, [-157, 20.5]);
  assert.equal(labels.features[0]!.properties.name, 'Hawaii');
});
