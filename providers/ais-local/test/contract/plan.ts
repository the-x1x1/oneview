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
  'ais-local',
);
const lines = readFileSync(path.join(fixtures, 'stream.nmea'), 'utf8').split('\n').filter(Boolean);

/**
 * Subscription over a line stream: the checklist opens the provider's fixture stream and feeds
 * it the NMEA lines; batches are flushed per position (`flushIntervalMs: 0`). Loopback, the
 * default port.
 */
export const plan = definePlan({
  providerDir: 'ais-local',
  create: () => createProvider({ flushIntervalMs: 0 }),
  clockStartMs: Date.parse('2026-09-23T20:00:20.000Z'),
  fixtures: {
    // Not used by a subscription provider, but required by the plan shape.
    normal: () => ({ status: 200, body: '' }),
  },
  subscription: { lines, minObservations: 2 },
  expectations: {
    objectTypes: ['vessel'],
    minObservations: 2,
    expectObjectIds: ['vessel:mmsi:477553000', 'vessel:mmsi:338087471'],
    verify: (obs) => {
      if (obs.length !== 2) return `expected 2 positions, got ${obs.length}`;
      const a = obs.find((o) => o.externalId === '477553000');
      if (!a) return 'the Class A report is missing';
      if (a.provenance.origin !== 'local') return 'origin should be local';
      if (a.observedAt !== '2026-09-23T20:00:15.000Z') return `dated at its second (15), got ${a.observedAt}`;
      if (a.position?.latitude !== 47.582833 || a.position.longitude !== -122.345833) return 'position wrong';
      if (a.payload['navStatusText'] !== 'moored' || a.payload['headingDegrees'] !== 181) return 'status/heading wrong';
      if (a.provenance.sourceRef !== 'tcp://127.0.0.1:10110') return `sourceRef ${a.provenance.sourceRef}`;
      const b = obs.find((o) => o.externalId === '338087471');
      if (b?.payload['aisClass'] !== 'B' || b.payload['speedMps'] !== 0.05) return 'the Class B report is wrong';
      return undefined;
    },
  },
});
