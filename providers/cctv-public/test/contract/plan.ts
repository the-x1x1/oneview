import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider, FINTRAFFIC_STATIONS_URL, NSW_CAMERAS_URL } from '../../src/index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'cctv-public',
);
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

const byUrl = (fintraffic: string, nsw: string) => (req: { url: string }) => {
  if (req.url === FINTRAFFIC_STATIONS_URL)
    return { status: 200, body: body(fintraffic), headers: { 'content-type': 'application/geo+json' } };
  if (req.url === NSW_CAMERAS_URL)
    return { status: 200, body: body(nsw), headers: { 'content-type': 'application/json' } };
  return { status: 404, body: '' };
};

export const plan = definePlan({
  providerDir: 'cctv-public',
  aliases: ['public-cameras'],
  create: () => createProvider(),
  fixtures: {
    normal: byUrl('fintraffic-stations.geojson', 'nsw-traffic-cam.json'),
    empty: byUrl('empty.geojson', 'empty.geojson'),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.geojson') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['camera'],
    minObservations: 9,
    expectObjectIds: [
      'camera:public-cameras:fintraffic:C0150101',
      'camera:public-cameras:fintraffic:C1400301',
      'camera:public-cameras:nsw:1',
      'camera:public-cameras:nsw:4',
    ],
    verify: (obs) => {
      const fin = obs.filter((o) => o.payload['pack'] === 'fintraffic');
      const nsw = obs.filter((o) => o.payload['pack'] === 'nsw');
      if (fin.length !== 5) return `expected 5 Fintraffic presets, got ${fin.length}`;
      if (nsw.length !== 4) return `expected 4 NSW cameras, got ${nsw.length}`;
      if (obs.some((o) => o.externalId === 'fintraffic:C0999901' || o.externalId === 'fintraffic:C0150103'))
        return 'non-gathering station / out-of-collection preset leaked';
      if (obs.some((o) => o.externalId === 'nsw:5')) return 'off-host NSW frame URL was admitted';
      for (const o of obs) {
        const url = String(o.payload['frameUrl']);
        const host = new URL(url).hostname;
        if (o.payload['pack'] === 'fintraffic' && host !== 'weathercam.digitraffic.fi')
          return `Fintraffic frame off-host: ${host}`;
        if (o.payload['pack'] === 'nsw' && host !== 'webcams.transport.nsw.gov.au')
          return `NSW frame off-host: ${host}`;
        const media = o.payload['media'];
        if (!Array.isArray(media) || media.length !== 1) return `${o.externalId}: media ref missing`;
        const ref = (media[0] as { ref?: unknown }).ref;
        if (ref !== `public:${String(o.payload['pack'])}:${String(o.externalId).split(':')[1]}`)
          return `${o.externalId}: media ref ${String(ref)} malformed`;
        if (typeof o.payload['attribution'] !== 'string' || !/CC BY 4\.0/.test(o.payload['attribution']))
          return `${o.externalId}: pack attribution missing`;
        if (o.quality.sourceQuality !== 'authoritative') return 'sourceQuality must be authoritative';
        if (!o.rawPayloadHash) return 'rawPayloadHash missing (CC BY allows raw retention)';
      }
      const espoo = obs.find((o) => o.externalId === 'fintraffic:C0150102');
      if (espoo?.payload['headingDegrees'] !== 95) return 'numeric preset direction not mapped to headingDegrees';
      if (espoo.payload['refreshSeconds'] !== 600) return 'Fintraffic refresh must be 600 s';
      if (espoo.position?.altitudeM !== 45) return 'station altitude not carried';
      const noHeading = obs.find((o) => o.externalId === 'fintraffic:C0150201');
      if (!noHeading?.quality.flags?.includes('heading-unknown')) return 'heading-unknown flag missing';
      const bridge = obs.find((o) => o.externalId === 'nsw:1');
      if (bridge?.payload['headingDegrees'] !== 0 || bridge.payload['direction'] !== 'N')
        return 'NSW direction N not mapped';
      const m4 = obs.find((o) => o.externalId === 'nsw:2');
      if (m4?.payload['headingDegrees'] !== 45) return 'NSW direction N-E not mapped to 45';
      const ousley = obs.find((o) => o.externalId === 'nsw:3');
      if (ousley?.payload['headingDegrees'] !== 225 || ousley.payload['region'] !== 'WOLLONGONG')
        return 'NSW S-W / region not mapped';
      const hexham = obs.find((o) => o.externalId === 'nsw:4');
      if (hexham?.payload['headingDegrees'] !== undefined || hexham?.payload['name'] !== 'Pacific Highway Hexham')
        return 'NSW camera without direction must fall back to title';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 9 ? undefined : `objectCount ${h.objectCount}`),
  },
});
