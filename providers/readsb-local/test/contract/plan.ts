import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider, DEFAULT_READSB_ENDPOINT } from '../../src/index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'readsb-local',
);
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

export const plan = definePlan({
  providerDir: 'readsb-local',
  create: () => createProvider(),
  // The receiver is "running": the default loopback endpoint answers the detection probe.
  local: { reachable: { [DEFAULT_READSB_ENDPOINT]: 200 } },
  clockStartMs: Date.parse('2026-09-21T08:00:10.000Z'),
  fixtures: {
    normal: () => ({ status: 200, body: body('aircraft.json'), headers: { 'content-type': 'application/json' } }),
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
    expectObjectIds: ['aircraft:icao24:a12b34', 'aircraft:icao24:ae0f23', 'aircraft:readsb-local:nonicao-a90b12'],
    verify: (obs) => {
      const hal = obs.find((o) => o.externalId === 'a12b34');
      if (!hal) return 'HAL9 missing';
      if (hal.provenance.origin !== 'local') return `origin should be local, got ${hal.provenance.origin}`;
      if (hal.quality.sourceQuality !== 'authoritative') return 'own receiver is authoritative';
      if (hal.observedAt !== '2026-09-21T07:59:59.700Z')
        return `observedAt should be now − seen_pos (seconds), got ${hal.observedAt}`;
      if (hal.payload['rssiDb'] !== -9.8 || hal.payload['callsign'] !== 'HAL9' || hal.payload['typeCode'] !== 'A21N')
        return 'HAL9 payload wrong';
      if (hal.position?.altitudeDatum !== 'barometric' || hal.position.altitudeM !== 3665.2)
        return 'barometric altitude wrong';
      if (hal.provenance.sourceRef !== DEFAULT_READSB_ENDPOINT) return 'sourceRef should be the endpoint';
      const ground = obs.find((o) => o.externalId === 'a9e0f1');
      if (!ground || ground.payload['onGround'] !== true || ground.position?.altitudeDatum !== 'ground')
        return 'ground row wrong';
      const mil = obs.find((o) => o.externalId === 'ae0f23');
      if (!mil || mil.payload['military'] !== true) return 'military bit missing';
      const stale = obs.find((o) => o.externalId === 'a34d56');
      if (!stale?.quality.flags?.includes('stale-position')) return 'stale-position flag missing';
      if (obs.some((o) => o.externalId === 'ab1c2d')) return 'Mode S row without position leaked';
      if (!obs.every((o) => o.rawPayloadHash)) return 'rawPayloadHash missing (own data, raw retention allowed)';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 8 ? undefined : `objectCount ${h.objectCount}`),
  },
});
