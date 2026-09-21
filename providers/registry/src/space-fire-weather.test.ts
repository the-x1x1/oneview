import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestSchema } from '@worldview/provider-sdk';
import { createSpaceFireWeatherProviders, spaceFireWeatherFactories } from './space-fire-weather.js';

test('space/fire/weather factories produce providers whose manifest ids match their keys', () => {
  for (const [id, factory] of Object.entries(spaceFireWeatherFactories)) {
    const provider = factory();
    assert.equal(provider.manifest.id, id);
    assert.ok(manifestSchema.parse(provider.manifest).ok, `${id} manifest invalid`);
  }
  assert.deepEqual(createSpaceFireWeatherProviders().map((p) => p.manifest.id), ['celestrak', 'nasa-firms', 'nws-alerts']);
});
