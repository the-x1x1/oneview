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
  'nmea2000-local',
);
const lines = readFileSync(path.join(fixtures, 'stream.ydraw'), 'utf8').split('\n').filter(Boolean);

/**
 * Subscription over a line stream: the checklist opens the provider's fixture stream and feeds
 * it the RAW lines (fixtures/nmea2000-local/README.md) at one frozen instant, as fast as it
 * can. The boat is sent once per flush and dated by its newest reading, so the flush is kept
 * (1 ms, inside the checklist's 10 ms wait) rather than turned off: every reading of the boat
 * arrives at the same instant here, and one observation of it per instant is the rule.
 * Loopback, the default port.
 */
export const plan = definePlan({
  providerDir: 'nmea2000-local',
  create: () => createProvider({ flushIntervalMs: 1 }),
  clockStartMs: Date.parse('2026-10-05T17:33:20.000Z'),
  fixtures: {
    // Not used by a subscription provider, but required by the plan shape.
    normal: () => ({ status: 200, body: '' }),
  },
  subscription: { lines, minObservations: 3 },
  expectations: {
    objectTypes: ['vessel'],
    minObservations: 3,
    verify: (obs) => {
      const own = obs.filter((o) => o.externalId === 'own-vessel').at(-1);
      if (!own) return 'the boat itself is missing';
      if (own.provenance.origin !== 'local') return 'origin should be local';
      if (own.provenance.sourceRef !== 'tcp://127.0.0.1:1457') return `sourceRef ${own.provenance.sourceRef}`;
      if (own.payload['depthM'] !== 12.34) return `depth ${String(own.payload['depthM'])}`;
      const a = obs.find((o) => o.externalId === '366123456');
      if (!a || a.payload['aisClass'] !== 'A') return 'the class A ship is missing';
      const b = obs.find((o) => o.externalId === '338234567');
      if (!b || b.payload['aisClass'] !== 'B') return 'the class B ship is missing';
      return undefined;
    },
  },
});
