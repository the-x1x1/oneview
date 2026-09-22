import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'usgs');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

export const plan = definePlan({
  providerDir: 'usgs',
  create: () => createProvider(),
  fixtures: {
    normal: () => ({ status: 200, body: body('normal.geojson'), headers: { 'content-type': 'application/geo+json' } }),
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
    objectTypes: ['earthquake'],
    minObservations: 8,
    expectObjectIds: ['earthquake:usgs:us7000wv02', 'earthquake:usgs:hv74012345', 'earthquake:usgs:us7000wv04'],
    verify: (obs) => {
      const japan = obs.find((o) => o.externalId === 'us7000wv02');
      if (!japan) return 'Japan event missing';
      if (japan.payload['magnitude'] !== 6.2 || japan.payload['tsunami'] !== true) return 'Japan event payload wrong';
      if (japan.position?.altitudeM !== -32_000 || japan.position.altitudeDatum !== 'msl')
        return 'depth not mapped to negative MSL altitude';
      const blast = obs.find((o) => o.externalId === 'nc75012345');
      if (!blast?.quality.flags?.includes('event-type:quarry blast')) return 'quarry blast flag missing';
      const auto = obs.find((o) => o.externalId === 'ci40912345');
      if (!auto?.quality.flags?.includes('automatic')) return 'automatic status flag missing';
      if (!obs.every((o) => o.rawPayloadHash && /^[0-9a-f]{64}$/.test(o.rawPayloadHash)))
        return 'rawPayloadHash missing (public domain data allows raw retention)';
      if (obs.some((o) => !o.payload['detailUrl'])) return 'detailUrl missing';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 8 ? undefined : `objectCount ${h.objectCount}`),
  },
});
