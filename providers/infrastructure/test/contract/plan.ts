import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider, SEED_AIRPORTS_FILE } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'airports');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

/**
 * Filesystem provider plan: the bundled dataset is served through the granted-file double;
 * the runner routes empty/stale/malformed scenarios through the responders below as file
 * contents (see tools/provider-validator `scenarioLocalAccess`).
 */
export const plan = definePlan({
  providerDir: 'infrastructure',
  aliases: ['worldview-seed-airports'],
  create: () => createProvider(),
  local: { files: { [SEED_AIRPORTS_FILE]: body('seed-airports.geojson') } },
  fixtures: {
    normal: () => ({ status: 200, body: body('seed-airports.geojson') }),
    empty: () => ({ status: 200, body: body('empty.geojson') }),
    stale: () => ({ status: 200, body: body('stale.geojson') }),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.geojson') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['airport'],
    minObservations: 80,
    expectObjectIds: ['airport:icao:PHNL', 'airport:icao:EGLL', 'airport:icao:NZAA'],
    verify: (obs) => {
      const hnl = obs.find((o) => o.externalId === 'PHNL');
      if (!hnl) return 'PHNL missing';
      if (hnl.observedAt !== '2026-09-01T00:00:00.000Z') return `observedAt should be the dataset date, got ${hnl.observedAt}`;
      if (hnl.provenance.origin !== 'local') return 'origin should be local';
      if (hnl.payload['iata'] !== 'HNL' || hnl.payload['icao'] !== 'PHNL' || hnl.payload['countryCode'] !== 'US' || hnl.payload['municipality'] !== 'Honolulu' || hnl.payload['type'] !== 'large_airport') return 'PHNL payload wrong';
      if (hnl.position?.latitude !== 21.32 || hnl.position.longitude !== -157.92) return 'PHNL position wrong';
      for (const code of ['PHOG', 'PHKO', 'PHTO', 'KLAX', 'KSFO', 'KJFK', 'EGLL', 'RJAA', 'RJTT', 'YSSY', 'OMDB', 'WSSS', 'EDDF', 'LFPG', 'EHAM', 'KORD', 'KDFW', 'KATL', 'KDEN', 'KSEA', 'CYVR', 'MMMX', 'SBGR', 'SAEZ', 'FAOR', 'HECA', 'VABB', 'VIDP', 'ZBAA', 'ZSPD', 'VHHH', 'RKSI', 'NZAA']) {
        if (!obs.some((o) => o.externalId === code)) return `${code} missing from the seed dataset`;
      }
      if (!obs.every((o) => o.quality.sourceQuality === 'authoritative' && o.rawPayloadHash)) return 'quality/hash wrong';
      const icao = new Set(obs.map((o) => o.externalId));
      if (icao.size !== obs.length) return 'duplicate ICAO codes';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 87 ? undefined : `objectCount ${h.objectCount}`),
  },
});
