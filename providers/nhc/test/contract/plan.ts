import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider } from '../../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fixtures = path.join(root, 'fixtures', 'nhc');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

export const plan = definePlan({
  providerDir: 'nhc',
  aliases: ['nhc-storms'],
  create: () => createProvider(),
  clockStartMs: Date.parse('2026-09-23T04:00:00.000Z'),
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
    objectTypes: ['storm'],
    minObservations: 2,
    expectObjectIds: ['storm:nhc-storms:ep162026', 'storm:nhc-storms:al092026'],
    verify: (obs) => {
      if (obs.length !== 2) return `expected 2 storms, got ${obs.length}`;
      const odalys = obs.find((o) => o.externalId === 'ep162026');
      if (!odalys) return 'Odalys missing';
      const p = odalys.payload;
      if (p['intensityKt'] !== 60 || p['pressureMb'] !== 994) return 'intensity/pressure not mapped';
      if (p['movementDirDeg'] !== 70 || p['movementSpeedMph'] !== 9) return 'motion not mapped';
      if (p['classificationLabel'] !== 'Tropical Storm' || p['basin'] !== 'Eastern Pacific') return 'labels wrong';
      if (odalys.position?.latitude !== 15.5 || odalys.position.longitude !== -129) return 'position wrong';
      const sample = obs.find((o) => o.externalId === 'al092026');
      if (sample?.payload['graphicsUrl'] !== undefined) return 'an off-host link was kept';
      if (!obs.every((o) => o.rawPayloadHash)) return 'raw hash missing (public domain allows it)';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 2 ? undefined : `objectCount ${h.objectCount}`),
  },
});
