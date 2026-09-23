import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeReferenceBorders, decodeReferenceLabels } from '@worldview/render-core';
// @ts-expect-error — a plain .mjs tool without declarations
import { buildBorders, buildLabels, encodeLine, simplify } from './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('reference build: simplification keeps the shape, encoding round-trips through the decoder', () => {
  const zigzag = [
    [0, 0],
    [1, 0.0001],
    [2, 0],
    [3, 1],
  ];
  assert.deepEqual(simplify(zigzag, 0.01), [
    [0, 0],
    [2, 0],
    [3, 1],
  ]);
  assert.deepEqual(
    encodeLine([
      [10.0004, 20],
      [10.0001, 20.0002],
      [10.5, 20.5],
    ]),
    [10000, 20000, 500, 500],
    'a repeat after rounding is dropped',
  );
  assert.equal(encodeLine([[1, 1]]), undefined);

  const { doc } = buildBorders(
    {
      features: [
        {
          properties: { FEATURECLA: 'International boundary (verify)', MIN_ZOOM: 0 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [-120, 49],
              [-110, 49],
            ],
          },
        },
        {
          properties: { FEATURECLA: 'Disputed (please verify)', MIN_ZOOM: 0 },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [74, 34],
                [75, 35],
              ],
            ],
          },
        },
        {
          properties: { FEATURECLA: 'Overlay limit', MIN_ZOOM: 0 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      ],
    },
    {
      features: [
        {
          properties: { FEATURECLA: 'Admin-1 boundary', MIN_ZOOM: 2 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [-100, 40],
              [-99, 41],
            ],
          },
        },
        {
          properties: { FEATURECLA: 'Admin-1 statistical boundary', MIN_ZOOM: 2 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [-120, 39],
              [-114.6, 35],
            ],
          },
        },
        {
          properties: { FEATURECLA: 'Admin-1 boundary indicator', MIN_ZOOM: 2 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      ],
    },
  );
  const lines = decodeReferenceBorders(doc);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.dashed, l.minZoom]),
    [
      ['country', false, 0],
      ['country', true, 0],
      ['state', false, 2],
      ['state', false, 2],
    ],
    'overlay limits and indicators are not borders; Natural Earth files real ones (California–Nevada) as statistical',
  );

  const labels = decodeReferenceLabels(
    buildLabels(
      {
        features: [
          {
            properties: {
              NAME: 'Zimbabwe',
              NAME_EN: 'Zimbabwe',
              LABEL_X: 29.9,
              LABEL_Y: -18.9,
              MIN_LABEL: 2.5,
              MAX_LABEL: 8,
              LABELRANK: 3,
            },
          },
        ],
      },
      {
        features: [
          {
            properties: {
              name: 'Kalimantan Timur',
              name_en: 'East Kalimantan',
              longitude: 116.35,
              latitude: 1.29,
              min_label: 5,
              max_label: 10,
              labelrank: 2,
              adm0_a3: 'IDN',
            },
          },
          { properties: { name: 'Never', longitude: 0, latitude: 0, min_label: 18 } },
        ],
      },
    ),
  );
  assert.deepEqual(
    labels.map((l) => l.name),
    ['Zimbabwe', 'East Kalimantan'],
    'English names; one Natural Earth never shows is dropped',
  );
});

test('reference build: the committed assets decode and cover the world', () => {
  const dir = path.join(root, 'apps', 'desktop', 'assets');
  const borders = decodeReferenceBorders(JSON.parse(readFileSync(path.join(dir, 'reference', 'borders.json'), 'utf8')));
  const countries = borders.filter((l) => l.kind === 'country');
  const states = borders.filter((l) => l.kind === 'state');
  assert.ok(countries.length > 5000, `${countries.length} country lines`);
  assert.ok(states.length > 20000, `${states.length} state lines`);
  const labels = decodeReferenceLabels(JSON.parse(readFileSync(path.join(dir, 'reference', 'labels.json'), 'utf8')));
  const names = new Set(labels.map((l) => `${l.kind}:${l.name}`));
  for (const n of [
    'country:United States of America',
    'country:Japan',
    'country:Brazil',
    'state:Hawaii',
    'state:California',
    'state:Ontario',
  ])
    assert.ok(names.has(n), `${n} is labelled`);
  // Natural Earth files this one as an "Admin-1 statistical boundary"; it must not be lost.
  const nearCaNv = states.filter((l) => l.bbox[0] < -119 && l.bbox[2] > -120.5 && l.bbox[1] < 39 && l.bbox[3] > 38);
  assert.ok(nearCaNv.length > 0, 'the California–Nevada line is there');
  for (const range of ['0-255', '256-511', '1024-1279'])
    assert.ok(existsSync(path.join(dir, 'fonts', 'Noto Sans Regular', `${range}.pbf`)), `glyph range ${range}`);
  assert.match(readFileSync(path.join(dir, 'fonts', 'OFL.txt'), 'utf8'), /SIL Open Font License, Version 1\.1/);
});
