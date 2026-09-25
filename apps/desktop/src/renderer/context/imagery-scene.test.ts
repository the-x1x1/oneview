import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { formatObjectType } from '@worldview/ui';
import { sceneSummary } from './sections.js';

test('an imagery scene says what it is in plain words', () => {
  const scene = { properties: { platform: 'sentinel-2c' } } as unknown as WorldObject;
  const text = sceneSummary(scene, '2026-09-19T21:19:33Z', 9.4, 10);
  assert.match(text, /^A photo of this area taken from orbit by Sentinel-2C on 2026-09-19 21:19/);
  assert.match(text, /\(9 % cloud, 10 m per pixel\)/);
  assert.match(text, /the ground the image covers/);
  assert.equal(formatObjectType('imagery-scene'), 'Satellite image');
  assert.equal(formatObjectType('fire-detection'), 'Fire detection');
});
