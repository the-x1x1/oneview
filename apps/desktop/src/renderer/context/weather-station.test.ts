import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { feelsLike, formatTemperature, stationPressure, stationRain, stationWind } from './sections.js';

const station = (properties: Record<string, number>) => ({ properties }) as unknown as WorldObject;

test('a local station reads in SI with the US figure beside it', () => {
  assert.equal(formatTemperature(29), '29.0 °C (84.2 °F)');
  assert.equal(formatTemperature(-40), '-40.0 °C (-40.0 °F)');
  assert.equal(formatTemperature(undefined), undefined);
  assert.equal(stationWind(5, 71), '5.0 m/s (11 mph) from ENE (71°)');
  assert.equal(stationWind(9.4, undefined), '9.4 m/s (21 mph)');
  assert.equal(stationWind(0, 180), 'Calm');
  assert.equal(stationPressure(1014.8, -1), '1014.8 hPa · falling 1.0 hPa in 3 h');
  assert.equal(stationPressure(1014.8, 0.2), '1014.8 hPa · steady in 3 h');
  assert.equal(stationPressure(1014.8, undefined), '1014.8 hPa');
  assert.equal(stationRain(0, 1, 5.8), '0.0 mm/h · 1.0 mm today · 5.8 mm in 24 h');
  assert.equal(stationRain(undefined, undefined, undefined), undefined);
});

test('"feels like" only when it differs by a degree or more', () => {
  assert.equal(feelsLike(station({ temperatureC: 29, heatIndexC: 31.6, windChillC: 29 })), '31.6 °C (88.9 °F)');
  assert.equal(feelsLike(station({ temperatureC: 5, heatIndexC: 5, windChillC: 1.5 })), '1.5 °C (34.7 °F)');
  assert.equal(feelsLike(station({ temperatureC: 20, heatIndexC: 20.4, windChillC: 20 })), undefined);
  assert.equal(feelsLike(station({})), undefined);
});
