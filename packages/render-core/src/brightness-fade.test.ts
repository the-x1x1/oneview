import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBrightnessFade } from './brightness-fade.js';

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
