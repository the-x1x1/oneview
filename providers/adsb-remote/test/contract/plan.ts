import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'adsb-lol');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

export const plan = definePlan({
  providerDir: 'adsb-remote',
  aliases: ['adsb-lol'],
  create: () => createProvider(),
  // The checklist queries without viewport bounds; the provider falls back to the home position.
  settings: { homePosition: { latitude: 21.32, longitude: -157.92, radiusNm: 150 } },
  // Ten seconds after the snapshot so aircraft classify as LIVE (aircraft policy: live ≤ 30 s).
  clockStartMs: Date.parse('2026-09-21T08:00:10.000Z'),
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
    objectTypes: ['aircraft'],
    minObservations: 8,
    expectObjectIds: ['aircraft:icao24:a4b2c3', 'aircraft:icao24:ae1234', 'aircraft:adsb-lol:nonicao-a5b5c5'],
    verify: (obs) => {
      const hal = obs.find((o) => o.externalId === 'a4b2c3');
      if (!hal) return 'HAL457 missing';
      if (hal.payload['callsign'] !== 'HAL457' || hal.payload['registration'] !== 'N383HA' || hal.payload['typeCode'] !== 'A332') return 'HAL457 identity payload wrong';
      if (hal.position?.altitudeDatum !== 'barometric' || Math.abs((hal.position.altitudeM ?? 0) - 10668) > 1) return 'barometric altitude not converted to metres';
      if (hal.payload['speedMps'] !== 241.89 || hal.payload['headingDegrees'] !== 92.4 || hal.payload['verticalSpeedMps'] !== -0.33) return `HAL457 motion payload wrong (${String(hal.payload['speedMps'])}, ${String(hal.payload['headingDegrees'])}, ${String(hal.payload['verticalSpeedMps'])})`;
      if (hal.observedAt !== '2026-09-21T07:59:59.200Z') return `observedAt should be now − seen_pos, got ${hal.observedAt}`;
      if (hal.quality.sourceQuality !== 'crowdsourced' || hal.quality.positionAccuracyM !== 100) return 'quality wrong';
      const ground = obs.find((o) => o.externalId === 'a9d8c7');
      if (!ground || ground.payload['onGround'] !== true || ground.position?.altitudeM !== 0 || ground.position.altitudeDatum !== 'ground') return 'on-ground row not mapped to ground datum';
      const mil = obs.find((o) => o.externalId === 'ae1234');
      if (!mil || mil.payload['military'] !== true) return 'military flag (dbFlags & 1) missing';
      if (obs.some((o) => o.externalId !== 'ae1234' && o.payload['military'] !== false)) return 'civil rows must carry military=false';
      const stale = obs.find((o) => o.externalId === 'a7b6c5');
      if (!stale?.quality.flags?.includes('stale-position')) return 'stale-position flag missing for seen_pos > 60 s';
      const tisb = obs.find((o) => o.externalId === 'nonicao-a5b5c5');
      if (!tisb || tisb.payload['icao24'] !== undefined || !tisb.quality.flags?.includes('non-icao-address')) return 'TIS-B non-ICAO address must not carry icao24';
      if (obs.some((o) => o.externalId === 'a6c6d6')) return 'Mode S row without position leaked';
      const heli = obs.find((o) => o.externalId === 'a2b2c2');
      if (!heli?.quality.flags?.includes('emergency:general') || heli.payload['squawk'] !== '7700') return 'emergency flag/squawk missing';
      if (!obs.every((o) => o.rawPayloadHash && /^[0-9a-f]{64}$/.test(o.rawPayloadHash))) return 'rawPayloadHash missing (raw retention allowed)';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 8 ? undefined : `objectCount ${h.objectCount}`),
  },
});
