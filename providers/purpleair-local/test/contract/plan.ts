import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider } from '../../src/index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'purpleair-local',
);
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
export const SENSOR_URL = 'http://192.168.1.60/json';

export const plan = definePlan({
  providerDir: 'purpleair-local',
  create: () => createProvider(),
  // The user named the sensor; it answers the detection probe. Its own position is used.
  settings: { host: '192.168.1.60', name: 'Porch' },
  local: { reachable: { [SENSOR_URL]: 200 } },
  clockStartMs: Date.parse('2026-09-23T20:00:00.000Z'),
  fixtures: {
    normal: () => ({ status: 200, body: body('normal.json'), headers: { 'content-type': 'application/json' } }),
    empty: () => ({ status: 200, body: body('empty.json') }),
    stale: () => ({ status: 200, body: body('stale.json') }),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.json') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['sensor'],
    minObservations: 1,
    expectObjectIds: ['sensor:purpleair-local:68c63a8e5a1b'],
    verify: (obs) => {
      if (obs.length !== 1) return `expected 1 sensor, got ${obs.length}`;
      const s = obs[0]!;
      const p = s.payload;
      if (s.provenance.origin !== 'local') return `origin should be local, got ${s.provenance.origin}`;
      if (s.observedAt !== '2026-09-23T19:58:10.000Z') return `observedAt should be DateTime, got ${s.observedAt}`;
      if (s.position?.latitude !== 21.3099 || s.position.longitude !== -157.8581) return 'the sensor’s own position';
      if (p['name'] !== 'Porch' || p['placement'] !== 'outdoor') return 'name/placement wrong';
      if (p['pm25Ugm3'] !== 4.9 || p['pmEstimate'] !== 'ATM' || p['channels'] !== 'agree') return 'PM2.5 wrong';
      if (p['pm10Ugm3'] !== 5.8 || p['pm1Ugm3'] !== 3.1 || p['aqiUs'] !== 20) return 'PM10/PM1/AQI wrong';
      if (p['temperatureC'] !== 31.1 || p['humidityPct'] !== 49 || p['pressureHpa'] !== 1012.4) return 'BME wrong';
      if ('ssid' in p || 'Geo' in p) return 'network details must not be kept';
      if (!s.rawPayloadHash) return 'rawPayloadHash missing (own data, raw retention allowed)';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 1 ? undefined : `objectCount ${h.objectCount}`),
  },
});
