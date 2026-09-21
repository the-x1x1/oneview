import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'weather');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

const ETAG = '"nws-fixture-etag-1"';

export const plan = definePlan({
  providerDir: 'weather',
  aliases: ['nws-alerts'],
  create: () => createProvider(),
  settings: { contact: 'ops@example.invalid' },
  fixtures: {
    normal: () => ({ status: 200, body: body('normal.geojson'), headers: { 'content-type': 'application/geo+json', etag: ETAG } }),
    empty: () => ({ status: 200, body: body('empty.geojson'), headers: { etag: '"nws-fixture-etag-empty"' } }),
    stale: () => ({ status: 200, body: body('stale.geojson') }),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.geojson') }),
      () => ({ status: 200, body: body('malformed-allbad.geojson') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['weather-alert'],
    minObservations: 7,
    expectObjectIds: [
      'weather-alert:nws-alerts:urn:oid:2.49.0.1.840.0.8ea5b47ac7ab2ff0f8f3d5d6c9c0d5c8f4e3b4b6.001.1',
      'weather-alert:nws-alerts:urn:oid:2.49.0.1.840.0.1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d.001.1',
    ],
    verify: (obs) => {
      if (obs.length !== 7) return `expected the 7 polygon alerts (2 zone-only/no-geometry skipped), got ${obs.length}`;
      const flood = obs.find((o) => o.externalId === 'urn:oid:2.49.0.1.840.0.8ea5b47ac7ab2ff0f8f3d5d6c9c0d5c8f4e3b4b6.001.1');
      if (!flood) return 'Flash Flood Warning missing';
      if (flood.observedAt !== '2026-09-21T07:45:00.000Z') return `sent (CDT) not normalized to UTC: ${flood.observedAt}`;
      if (flood.effectiveFrom !== '2026-09-21T07:45:00.000Z' || flood.effectiveUntil !== '2026-09-21T10:45:00.000Z') return 'effective window wrong';
      if (flood.geometry?.type !== 'Polygon' || !flood.position || Math.abs(flood.position.latitude - 30.35) > 0.1 || Math.abs(flood.position.longitude + 97.72) > 0.1) return 'polygon/centroid wrong';
      if (flood.payload['severity'] !== 'SEVERE' || flood.payload['event'] !== 'Flash Flood Warning' || flood.payload['certainty'] !== 'Likely' || flood.payload['urgency'] !== 'Immediate') return 'CAP fields wrong';
      if (JSON.stringify(flood.payload['sameCodes']) !== '["048453","048491"]' || JSON.stringify(flood.payload['ugcCodes']) !== '["TXC453","TXC491"]') return 'geocode lists wrong';
      if (typeof flood.payload['instruction'] !== 'string' || flood.payload['senderName'] !== 'NWS Austin/San Antonio TX') return 'instruction/sender missing';
      const tornado = obs.find((o) => o.payload['event'] === 'Tornado Warning');
      if (tornado?.payload['severity'] !== 'EXTREME') return 'Extreme not mapped';
      const svr = obs.find((o) => o.payload['event'] === 'Severe Thunderstorm Warning');
      if (svr?.payload['messageType'] !== 'Update' || !svr.quality.flags?.includes('update')) return 'Update message type not flagged';
      const advisory = obs.find((o) => o.payload['event'] === 'Flood Advisory');
      if (advisory?.payload['severity'] !== 'MINOR') return 'Minor not mapped';
      const redFlag = obs.find((o) => o.payload['event'] === 'Red Flag Warning');
      if (redFlag?.effectiveFrom !== '2026-09-21T18:00:00.000Z' || redFlag.effectiveUntil !== '2026-09-23T03:00:00.000Z') return 'onset/ends precedence wrong';
      if (obs.some((o) => (o.payload['description'] as string).length > 2000)) return 'description not truncated';
      if (!obs.every((o) => o.quality.sourceQuality === 'authoritative' && o.rawPayloadHash)) return 'quality/hash missing';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 7 ? undefined : `objectCount ${h.objectCount}`),
  },
});
