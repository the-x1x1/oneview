import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import {
  createProvider,
  createUnverifiedProvider,
  createSingaporeProvider,
  SINGAPORE_TRAFFIC_IMAGES_URL,
  caltransUrl,
  AUSTIN_CAMERAS_URL,
  IOWA_CAMERAS_URL,
  NYC_CAMERAS_URL,
  NZTA_CAMERAS_URL,
  CALGARY_CAMERAS_URL,
  DRIVEBC_WEBCAMS_URL,
  FINTRAFFIC_STATIONS_URL,
  HONG_KONG_CAMERAS_URL,
  ICELAND_CAMERAS_URL,
  NSW_CAMERAS_URL,
  QLD_WEBCAMS_URL,
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
  (
    fintraffic: string,
    nsw: string,
    arrays: { tfl: string; ontario: string; drivebc: string; calgary: string },
    more: { hongkong: string; iceland: string; queensland: string },
  ) =>
  (req: { url: string }) => {
    const json = (name: string) => ({ status: 200, body: body(name), headers: { 'content-type': 'application/json' } });
    if (req.url === FINTRAFFIC_STATIONS_URL)
      return { status: 200, body: body(fintraffic), headers: { 'content-type': 'application/geo+json' } };
    if (req.url === NSW_CAMERAS_URL) return json(nsw);
    if (req.url === TFL_JAMCAM_URL) return json(arrays.tfl);
    if (req.url === ONTARIO_511_CAMERAS_URL) return json(arrays.ontario);
    if (req.url === DRIVEBC_WEBCAMS_URL) return json(arrays.drivebc);
    if (req.url === CALGARY_CAMERAS_URL) return json(arrays.calgary);
    if (req.url === HONG_KONG_CAMERAS_URL)
      return { status: 200, body: body(more.hongkong), headers: { 'content-type': 'application/xml' } };
    if (req.url === ICELAND_CAMERAS_URL) return json(more.iceland);
    if (req.url === QLD_WEBCAMS_URL) return json(more.queensland);
    return { status: 404, body: '' };
  };

const FRAME_HOST: Record<string, string> = {
  fintraffic: 'weathercam.digitraffic.fi',
  nsw: 'webcams.transport.nsw.gov.au',
  tfl: 's3-eu-west-1.amazonaws.com',
  ontario: '511on.ca',
  drivebc: 'www.drivebc.ca',
  calgary: 'trafficcam.calgary.ca',
  hongkong: 'tdcctv.data.one.gov.hk',
  iceland: 'www.vegagerdin.is',
  queensland: 'cameras.qldtraffic.qld.gov.au',
};
const ATTRIBUTION: Record<string, RegExp> = {
  fintraffic: /CC BY 4\.0/,
  nsw: /CC BY 4\.0/,
  tfl: /^Powered by TfL Open Data/,
  ontario: /Open Government Licence – Ontario/,
  drivebc: /Open Government Licence – British Columbia/,
  calgary: /Open Government Licence – City of Calgary/,
  hongkong: /DATA\.GOV\.HK$/,
  iceland: /^Based on information provided by the Icelandic Road and Coastal Administration \(IRCA\)$/,
  queensland: /CC BY 4\.0 AU$/,
};

export const plan = definePlan({
  providerDir: 'cctv-public',
  aliases: ['public-cameras'],
  create: () => createProvider(),
  fixtures: {
    normal: byUrl(
      'fintraffic-stations.geojson',
      'nsw-traffic-cam.json',
      {
        tfl: 'tfl-jamcam.json',
        ontario: 'ontario-511-cameras.json',
        drivebc: 'drivebc-webcams.json',
        calgary: 'calgary-cameras.json',
      },
      { hongkong: 'hongkong-cameras.xml', iceland: 'iceland-webcams.json', queensland: 'qldtraffic-webcams.geojson' },
    ),
    empty: byUrl(
      'empty.geojson',
      'empty.geojson',
      {
        tfl: 'empty-array.json',
        ontario: 'empty-array.json',
        drivebc: 'empty-array.json',
        calgary: 'empty-array.json',
      },
      { hongkong: 'hongkong-empty.xml', iceland: 'empty-array.json', queensland: 'empty.geojson' },
    ),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.geojson') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['camera'],
    minObservations: 27,
    expectObjectIds: [
      'camera:public-cameras:fintraffic:C0150101',
      'camera:public-cameras:fintraffic:C1400301',
      'camera:public-cameras:nsw:1',
      'camera:public-cameras:nsw:4',
      'camera:public-cameras:tfl:00001.01101',
      'camera:public-cameras:ontario:4101',
      'camera:public-cameras:drivebc:682',
      'camera:public-cameras:calgary:loc142',
      'camera:public-cameras:hongkong:H109F',
      'camera:public-cameras:iceland:hellisheidi_1',
      'camera:public-cameras:queensland:1',
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
        ['hongkong', 3],
        ['iceland', 3],
        ['queensland', 3],
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
        if (pack === 'iceland' && !url.pathname.startsWith('/vgdata/vefmyndavelar/'))
          return 'Iceland frame outside the webcam directory';
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
      if (obs.some((o) => o.externalId === 'queensland:77')) return 'a third-party QLDTraffic image was admitted';
      const hk = obs.find((o) => o.externalId === 'hongkong:TC560F');
      if (hk?.payload['frameUrl'] !== 'https://tdcctv.data.one.gov.hk/TC560F.JPG')
        return 'Hong Kong frame URL must be rebuilt from the key, not taken from the file';
      const qld = obs.find((o) => o.externalId === 'queensland:1');
      if (qld?.payload['headingDegrees'] !== 45) return 'QLDTraffic NorthEast not mapped to 45';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 27 ? undefined : `objectCount ${h.objectCount}`),
  },
});

/**
 * public-cameras-unverified: the same code with the Caltrans, Austin, New York and Iowa
 * packs, under a stricter manifest that is off by default.
 */
const unverifiedByUrl =
  (files: { d4: string; d7: string; other: string; austin: string; nyc: string; iowa: string; nzta: string }) =>
  (req: { url: string }) => {
    const json = (name: string) => ({
      status: 200,
      body: body(`unverified/${name}`),
      headers: { 'content-type': 'application/json' },
    });
    if (req.url === caltransUrl(4)) return json(files.d4);
    if (req.url === caltransUrl(7)) return json(files.d7);
    if (req.url.startsWith('https://cwwp2.dot.ca.gov/')) return json(files.other);
    if (req.url === AUSTIN_CAMERAS_URL) return json(files.austin);
    if (req.url === NYC_CAMERAS_URL) return json(files.nyc);
    if (req.url === NZTA_CAMERAS_URL) return json(files.nzta);
    if (req.url === IOWA_CAMERAS_URL) return json(files.iowa);
    // Later pages of the Iowa layer: none in the fixture.
    if (req.url.includes('/Traffic_Cameras_View/')) return { status: 200, body: '{"features":[]}' };
    return { status: 404, body: '' };
  };
const UNVERIFIED_FRAME_HOST: Record<string, string> = {
  caltrans: 'cwwp2.dot.ca.gov',
  austin: 'cctv.austinmobility.io',
  nyc: 'webcams.nyctmc.org',
  iowa: 'atmsqf.iowadot.gov',
  nzta: 'www.trafficnz.info',
};
const EMPTY_DISTRICT = 'caltrans-empty-district.json';

export const unverifiedPlan = definePlan({
  providerDir: 'cctv-public',
  aliases: ['public-cameras-unverified'],
  create: () => createUnverifiedProvider(),
  fixtures: {
    normal: unverifiedByUrl({
      d4: 'caltrans-d4.json',
      d7: 'caltrans-d7.json',
      other: EMPTY_DISTRICT,
      austin: 'austin-cameras.json',
      nyc: 'nyc-cameras.json',
      iowa: 'iowa-cameras.json',
      nzta: 'nzta-cameras.json',
    }),
    empty: (req) =>
      req.url.startsWith('https://cwwp2.dot.ca.gov/')
        ? { status: 200, body: body(`unverified/${EMPTY_DISTRICT}`) }
        : req.url.includes('/Traffic_Cameras_View/')
          ? { status: 200, body: '{"features":[]}' }
          : req.url === NZTA_CAMERAS_URL
            ? { status: 200, body: body('empty.geojson') }
            : { status: 200, body: body('empty-array.json') },
    malformed: [
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['camera'],
    minObservations: 12,
    expectObjectIds: [
      'camera:public-cameras-unverified:caltrans:d4-tv102',
      'camera:public-cameras-unverified:caltrans:d7-tv400',
      'camera:public-cameras-unverified:austin:912',
      'camera:public-cameras-unverified:iowa:DMTV01',
      'camera:public-cameras-unverified:iowa:DMTV02',
    ],
    verify: (obs) => {
      const count = (pack: string) => obs.filter((o) => o.payload['pack'] === pack).length;
      for (const [pack, n] of [
        ['caltrans', 3],
        ['austin', 2],
        ['nyc', 2],
        ['iowa', 3],
        ['nzta', 2],
      ] as const)
        if (count(pack) !== n) return `expected ${n} ${pack} cameras, got ${count(pack)}`;
      for (const o of obs) {
        const pack = String(o.payload['pack']);
        const url = new URL(String(o.payload['frameUrl']));
        if (url.protocol !== 'https:' || url.hostname !== UNVERIFIED_FRAME_HOST[pack])
          return `${pack} frame off-host: ${url.host}`;
        if (!/licence not confirmed|courtesy|not confirmed/.test(String(o.payload['attribution'])))
          return `${o.externalId}: the attribution must say the licence is not confirmed`;
      }
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 12 ? undefined : `objectCount ${h.objectCount}`),
  },
});

/** public-cameras-singapore: one catalogue, polled every minute, keeping no rows. */
export const singaporePlan = definePlan({
  providerDir: 'cctv-public',
  aliases: ['public-cameras-singapore'],
  create: () => createSingaporeProvider(),
  fixtures: {
    normal: (req) =>
      req.url === SINGAPORE_TRAFFIC_IMAGES_URL
        ? { status: 200, body: body('singapore-traffic-images.json'), headers: { 'content-type': 'application/json' } }
        : { status: 404, body: '' },
    empty: () => ({ status: 200, body: '{"items":[{"timestamp":"2026-09-21T16:04:30+08:00","cameras":[]}]}' }),
    malformed: [
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['camera'],
    minObservations: 2,
    expectObjectIds: [
      'camera:public-cameras-singapore:singapore:1001',
      'camera:public-cameras-singapore:singapore:4703',
    ],
    verify: (obs) => {
      for (const o of obs) {
        const url = new URL(String(o.payload['frameUrl']));
        if (url.hostname !== 'images.data.gov.sg' || !url.pathname.startsWith('/api/traffic-images/'))
          return `frame off its path: ${url.href}`;
        if (!/Singapore Open Data Licence version 1\.0$/.test(String(o.payload['attribution'])))
          return `${o.externalId}: licence notice missing`;
      }
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 2 ? undefined : `objectCount ${h.objectCount}`),
  },
});

/** Every provider this package ships (the validator CLI runs each). */
export const plans = [plan, unverifiedPlan, singaporePlan];
