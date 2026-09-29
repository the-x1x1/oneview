import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBrightnessFade, featherWeights } from './brightness-fade.js';

test('applyBrightnessFade: grey background goes, bright and coloured cloud stays, a ramp between', () => {
  const px = new Uint8ClampedArray([
    95,
    95,
    95,
    255, // clear sky / warm ground in GIBS clean infrared
    140,
    140,
    140,
    255, // halfway up a 110–170 ramp
    200,
    200,
    200,
    255, // bright cloud
    10,
    220,
    30,
    255, // a coloured cold cloud top: brightest channel counts
  ]);
  applyBrightnessFade(px, { from: 110, to: 170 });
  assert.equal(px[3], 0);
  assert.equal(px[7], 128);
  assert.equal(px[11], 255);
  assert.equal(px[15], 255);
  assert.deepEqual([...px.slice(0, 3)], [95, 95, 95], 'colour is untouched');
});

test('applyBrightnessFade: an existing partial alpha is scaled, not raised', () => {
  const px = new Uint8ClampedArray([140, 140, 140, 100]);
  applyBrightnessFade(px, { from: 110, to: 170 });
  assert.equal(px[3], 50);
});

test('monochrome: every source in one grey, light where the ramp starts, white past its end', () => {
  // A GIBS cold top in colour (yellow), a mid-ramp grey and a clear-sky pixel.
  const px = new Uint8ClampedArray([255, 220, 0, 255, 165, 165, 165, 255, 60, 60, 60, 255]);
  applyBrightnessFade(px, { from: 135, to: 195, monochrome: true });
  assert.deepEqual([...px.slice(0, 4)], [255, 255, 255, 255], 'coloured top: white, opaque');
  assert.deepEqual([...px.slice(4, 8)], [213, 213, 213, 128], 'half way: light grey, half seen');
  assert.equal(px[11], 0, 'clear sky gone');
});

test('featherWeights: two slices meeting at a seam cross-fade, summing to one', () => {
  const width = 256;
  // Zoom 3, column 3 spans 45° W to 0°: the 37.5° W seam of GOES-East and Meteosat is in it.
  const west = featherWeights({ z: 3, x: 3 }, width, { west: -106, east: -37.5 }, 5)!;
  const east = featherWeights({ z: 3, x: 3 }, width, { west: -37.5, east: 22.5 }, 5)!;
  assert.ok(west && east);
  const col = (lon: number) => Math.floor(((lon + 45) / 45) * width);
  assert.ok(
    Math.abs(west[col(-37.5)]! - 0.5) < 0.02 && Math.abs(east[col(-37.5)]! - 0.5) < 0.02,
    'half each at the seam',
  );
  assert.equal(west[col(-44)], 1);
  assert.equal(west[col(-30)], 0);
  for (let c = 0; c < width; c++) assert.ok(Math.abs(west[c]! + east[c]! - 1) < 1e-6, `column ${c} sums to one`);
  assert.equal(
    featherWeights({ z: 3, x: 2 }, width, { west: -106, east: -37.5 }, 5),
    undefined,
    'a tile inside: nothing to do',
  );
});

test('featherWeights: at the antimeridian Himawari and GOES-West meet edge to edge, unfaded', () => {
  // Neither is drawn past 180° (world-model drawnBounds), so neither fades towards it.
  assert.equal(featherWeights({ z: 3, x: 7 }, 128, { west: 93, east: 180 }, 5), undefined, 'Himawari whole to 180°');
  assert.equal(
    featherWeights({ z: 3, x: 0 }, 128, { west: -180, east: -106 }, 5),
    undefined,
    'GOES-West whole from 180°',
  );
  // Their other edges still cross-fade with their neighbours.
  const west = featherWeights({ z: 3, x: 6 }, 128, { west: 93, east: 180 }, 5)!;
  assert.ok(west && west[0] === 0 && west[127] === 1);
});

test('applyBrightnessFade: column weights multiply the alpha', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
  applyBrightnessFade(px, { from: 10, to: 20 }, new Float32Array([1, 0.5]), 2);
  assert.deepEqual([px[3], px[7]], [255, 128]);
});

test('latitudeWeights: a slice thins out over the last ten degrees inside its north and south edges, not in a line', async () => {
  const { latitudeWeights, LATITUDE_FADE_DEG } = await import('./brightness-fade.js');
  assert.equal(LATITUDE_FADE_DEG, 10);
  // Zoom 1, row 0 runs from 85° N to the equator; the slice to 60° N fades from 50° to 60°.
  const w = latitudeWeights({ z: 1, y: 0 }, 256, { south: -60, north: 60 })!;
  assert.ok(w);
  assert.equal(w[0], 0, 'beyond the edge: nothing');
  assert.equal(w[255], 1, 'at the equator: all of it');
  const latOf = (row: number) =>
    (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * ((row + 0.5) / 256)) / 2));
  const at55 = [...w.keys()].reduce((best, r) => (Math.abs(latOf(r) - 55) < Math.abs(latOf(best) - 55) ? r : best), 0);
  assert.ok(Math.abs(w[at55]! - 0.5) < 0.05, 'half way through the fade');
  for (let r = 1; r < 256; r++) assert.ok(w[r]! >= w[r - 1]!, 'no step back going south');
  // A tile wholly inside: nothing to do; a slice to the map's poles: never faded.
  assert.equal(latitudeWeights({ z: 3, y: 3 }, 256, { south: -60, north: 60 }), undefined);
  assert.equal(latitudeWeights({ z: 1, y: 0 }, 256, { south: -85.06, north: 85.06 }), undefined);
});

test('applyBrightnessFade: row weights multiply the alpha as column weights do', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
  applyBrightnessFade(px, { from: 10, to: 20 }, undefined, 1, new Float32Array([1, 0.5]));
  assert.deepEqual([px[3], px[7]], [255, 128]);
});

test('monochrome: a dark colour is cold cloud by its colour; near-grey is judged by brightness alone', () => {
  // GIBS draws its coldest tops in colour, many of them dark: a deep blue under the ramp.
  const px = new Uint8ClampedArray([0, 0, 110, 255, 60, 50, 70, 255, 100, 100, 104, 255]);
  applyBrightnessFade(px, { from: 135, to: 195, monochrome: true });
  assert.deepEqual([...px.slice(0, 4)], [255, 255, 255, 255], 'deep blue: white, opaque');
  assert.equal(px[7], 0, 'a dim, nearly grey pixel: still clear sky');
  assert.equal(px[11], 0, 'grey below the ramp: clear sky');
  // Without monochrome (true colour) colour counts for nothing.
  const tc = new Uint8ClampedArray([0, 0, 110, 255]);
  applyBrightnessFade(tc, { from: 135, to: 195 });
  assert.equal(tc[3], 0);
});
