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
  'weatherlink-local',
);
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
export const STATION_URL = 'http://192.168.1.50/v1/current_conditions';

export const plan = definePlan({
  providerDir: 'weatherlink-local',
  create: () => createProvider(),
  // The user named the device and where it stands; the device answers the detection probe.
  settings: { host: '192.168.1.50', latitude: 21.3069, longitude: -157.8583, name: 'Backyard' },
  local: { reachable: { [STATION_URL]: 200 } },
  clockStartMs: Date.parse('2026-09-23T20:00:00.000Z'),
  fixtures: {
    normal: () => ({ status: 200, body: body('normal.json'), headers: { 'content-type': 'application/json' } }),
    empty: () => ({ status: 200, body: body('empty.json') }),
    stale: () => ({ status: 200, body: body('stale.json') }),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.json') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: body('error.json') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['weather-station'],
    minObservations: 1,
    expectObjectIds: ['weather-station:weatherlink-local:001d0a71a3f2-1'],
    verify: (obs) => {
      if (obs.length !== 1) return `expected 1 station, got ${obs.length}`;
      const s = obs[0]!;
      const p = s.payload;
      if (s.provenance.origin !== 'local') return `origin should be local, got ${s.provenance.origin}`;
      if (s.observedAt !== '2026-09-23T19:59:30.000Z') return `observedAt should be the device ts, got ${s.observedAt}`;
      if (s.position?.latitude !== 21.3069 || s.position.longitude !== -157.8583)
        return 'position is not the configured one';
      if (p['name'] !== 'Backyard') return 'name setting not applied';
      if (p['temperatureC'] !== 29 || p['humidityPct'] !== 62.3 || p['dewPointC'] !== 21)
        return 'temperature/humidity wrong';
      if (p['windSpeedMps'] !== 5 || p['windDirDeg'] !== 71 || p['windGustMps'] !== 9.4) return 'wind wrong';
      if (p['pressureSeaLevelHpa'] !== 1014.8 || p['pressureTrend3hHpa'] !== -1) return 'pressure wrong';
      if (p['rainTodayMm'] !== 1 || p['rain24hMm'] !== 5.8 || p['rainRateMmH'] !== 0) return 'rain wrong';
      if (p['solarRadiationWm2'] !== 747 || p['uvIndex'] !== 8.4) return 'solar/UV wrong';
      if ('temp_in' in p || 'indoorTemperatureC' in p) return 'indoor readings must not leave the house';
      if (s.provenance.sourceRef !== 'http://192.168.1.50/v1/current_conditions')
        return 'sourceRef should be the endpoint';
      if (!s.rawPayloadHash) return 'rawPayloadHash missing (own data, raw retention allowed)';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 1 ? undefined : `objectCount ${h.objectCount}`),
  },
});
