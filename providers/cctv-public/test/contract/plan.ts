import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import {
  createProvider,
  CALGARY_CAMERAS_URL,
  DRIVEBC_WEBCAMS_URL,
  FINTRAFFIC_STATIONS_URL,
  NSW_CAMERAS_URL,
  ONTARIO_511_CAMERAS_URL,
  TFL_JAMCAM_URL,
} from '../../src/index.js';

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

const byUrl =
  (fintraffic: string, nsw: string, arrays: { tfl: string; ontario: string; drivebc: string; calgary: string }) =>
  (req: { url: string }) => {
    const json = (name: string) => ({ status: 200, body: body(name), headers: { 'content-type': 'application/json' } });
    if (req.url === FINTRAFFIC_STATIONS_URL)
      return { status: 200, body: body(fintraffic), headers: { 'content-type': 'application/geo+json' } };
    if (req.url === NSW_CAMERAS_URL) return json(nsw);
    if (req.url === TFL_JAMCAM_URL) return json(arrays.tfl);
    if (req.url === ONTARIO_511_CAMERAS_URL) return json(arrays.ontario);
    if (req.url === DRIVEBC_WEBCAMS_URL) return json(arrays.drivebc);
    if (req.url === CALGARY_CAMERAS_URL) return json(arrays.calgary);
    return { status: 404, body: '' };
  };

const FRAME_HOST: Record<string, string> = {
  fintraffic: 'weathercam.digitraffic.fi',
  nsw: 'webcams.transport.nsw.gov.au',
  tfl: 's3-eu-west-1.amazonaws.com',
  ontario: '511on.ca',
  drivebc: 'www.drivebc.ca',
  calgary: 'trafficcam.calgary.ca',
};
const ATTRIBUTION: Record<string, RegExp> = {
  fintraffic: /CC BY 4\.0/,
  nsw: /CC BY 4\.0/,
  tfl: /^Powered by TfL Open Data/,
  ontario: /Open Government Licence – Ontario/,
  drivebc: /Open Government Licence – British Columbia/,
  calgary: /Open Government Licence – City of Calgary/,
};

export const plan = definePlan({
  providerDir: 'cctv-public',
  aliases: ['public-cameras'],
  create: () => createProvider(),
  fixtures: {
    normal: byUrl('fintraffic-stations.geojson', 'nsw-traffic-cam.json', {
      tfl: 'tfl-jamcam.json',
      ontario: 'ontario-511-cameras.json',
      drivebc: 'drivebc-webcams.json',
      calgary: 'calgary-cameras.json',
    }),
    empty: byUrl('empty.geojson', 'empty.geojson', {
      tfl: 'empty-array.json',
      ontario: 'empty-array.json',
      drivebc: 'empty-array.json',
      calgary: 'empty-array.json',
    }),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.geojson') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['camera'],
    minObservations: 18,
    expectObjectIds: [
      'camera:public-cameras:fintraffic:C0150101',
      'camera:public-cameras:fintraffic:C1400301',
      'camera:public-cameras:nsw:1',
      'camera:public-cameras:nsw:4',
      'camera:public-cameras:tfl:00001.01101',
      'camera:public-cameras:ontario:4101',
      'camera:public-cameras:drivebc:682',
      'camera:public-cameras:calgary:loc142',
    ],
    verify: (obs) => {
      const fin = obs.filter((o) => o.payload['pack'] === 'fintraffic');
      const nsw = obs.filter((o) => o.payload['pack'] === 'nsw');
      if (fin.length !== 5) return `expected 5 Fintraffic presets, got ${fin.length}`;
      if (nsw.length !== 4) return `expected 4 NSW cameras, got ${nsw.length}`;
      const count = (pack: string) => obs.filter((o) => o.payload['pack'] === pack).length;
      for (const [pack, n] of [
        ['tfl', 3],
        ['ontario', 2],
        ['drivebc', 2],
        ['calgary', 2],
      ] as const)
        if (count(pack) !== n) return `expected ${n} ${pack} cameras, got ${count(pack)}`;
      if (obs.some((o) => o.externalId === 'tfl:00002.00205')) return 'a frame in another S3 bucket was admitted';
      if (obs.some((o) => o.externalId === 'fintraffic:C0999901' || o.externalId === 'fintraffic:C0150103'))
        return 'non-gathering station / out-of-collection preset leaked';
      if (obs.some((o) => o.externalId === 'nsw:5')) return 'off-host NSW frame URL was admitted';
      for (const o of obs) {
        const url = new URL(String(o.payload['frameUrl']));
        const pack = String(o.payload['pack']);
        if (url.protocol !== 'https:' || url.hostname !== FRAME_HOST[pack])
          return `${pack} frame off-host: ${url.host}`;
        if (pack === 'tfl' && !url.pathname.startsWith('/jamcams.tfl.gov.uk/')) return 'TfL frame outside its bucket';
        const media = o.payload['media'];
        if (!Array.isArray(media) || media.length !== 1) return `${o.externalId}: media ref missing`;
        const ref = (media[0] as { ref?: unknown }).ref;
        if (ref !== `public:${String(o.payload['pack'])}:${String(o.externalId).split(':')[1]}`)
          return `${o.externalId}: media ref ${String(ref)} malformed`;
        if (typeof o.payload['attribution'] !== 'string' || !ATTRIBUTION[pack]!.test(o.payload['attribution']))
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
    verifyHealth: (h) => (h.objectCount === 18 ? undefined : `objectCount ${h.objectCount}`),
  },
});
