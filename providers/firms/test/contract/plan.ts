import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan, type FixtureResponder } from '@worldview/tool-provider-validator';
import { createProvider, parseFirmsAreaUrl, FIRMS_CREDENTIAL_KEY } from '../../src/index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'firms',
);
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

const NORMAL_BY_SOURCE: Record<string, string> = {
  VIIRS_SNPP_NRT: 'viirs-snpp.csv',
  VIIRS_NOAA20_NRT: 'viirs-noaa20.csv',
  VIIRS_NOAA21_NRT: 'viirs-noaa21.csv',
  MODIS_NRT: 'modis.csv',
};

/**
 * Answers per source. Accepts either credential form: the key as a path segment
 * (`/csv/<key>/…`, the FIRMS contract) or the `{MAP_KEY}` placeholder plus a
 * `?MAP_KEY=` query (what the current SDK credential shape produces).
 */
const perSource =
  (file?: (source: string) => string): FixtureResponder =>
  (req) => {
    const parsed = parseFirmsAreaUrl(req.url);
    if (!parsed || !(parsed.source in NORMAL_BY_SOURCE)) return { status: 404, body: 'unknown FIRMS route' };
    if (req.credential?.key !== FIRMS_CREDENTIAL_KEY && !/\/csv\/[A-Za-z0-9]{16,}\//.test(req.url))
      return { status: 401, body: 'no MAP_KEY' };
    return {
      status: 200,
      body: body(file ? file(parsed.source) : NORMAL_BY_SOURCE[parsed.source]!),
      headers: { 'content-type': 'text/csv' },
    };
  };

export const plan = definePlan({
  providerDir: 'firms',
  aliases: ['nasa-firms'],
  create: () => createProvider(),
  credentials: [FIRMS_CREDENTIAL_KEY],
  fixtures: {
    normal: perSource(),
    empty: perSource(() => 'empty.csv'),
    stale: perSource(() => 'stale.csv'),
    malformed: [
      perSource(() => 'malformed-rows.csv'),
      perSource(() => 'malformed-allbad.csv'),
      perSource(() => 'malformed-html.txt'),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['fire-detection'],
    minObservations: 19,
    expectObjectIds: [
      'fire-detection:nasa-firms:VIIRS_SNPP_NRT:2026-09-21T0742:38.99488:-121.67046',
      'fire-detection:nasa-firms:VIIRS_NOAA20_NRT:2026-09-21T0530:-2.48811:114.90322',
      'fire-detection:nasa-firms:VIIRS_NOAA21_NRT:2026-09-20T1346:39.5804:-8.2451',
    ],
    verify: (obs) => {
      if (obs.length !== 19) return `expected 8 + 6 + 5 detections, got ${obs.length}`;
      const ca = obs.find((o) => o.externalId === 'VIIRS_SNPP_NRT:2026-09-21T0742:38.99488:-121.67046');
      if (!ca) return 'California SNPP detection missing';
      if (ca.observedAt !== '2026-09-21T07:42:00.000Z') return `acq_date/acq_time not mapped to UTC: ${ca.observedAt}`;
      if (
        ca.payload['confidence'] !== 'high' ||
        ca.payload['frpMw'] !== 14.53 ||
        ca.payload['brightnessK'] !== 331.62 ||
        ca.payload['dayNight'] !== 'night'
      )
        return 'payload mapping wrong';
      if (
        ca.payload['satellite'] !== 'N' ||
        ca.payload['instrument'] !== 'VIIRS' ||
        ca.payload['source'] !== 'VIIRS_SNPP_NRT'
      )
        return 'source/satellite fields wrong';
      if (ca.payload['scanKm'] !== 0.39 || ca.payload['trackKm'] !== 0.36) return 'scan/track wrong';
      if (ca.quality.positionAccuracyM !== 375 || ca.quality.sourceQuality !== 'authoritative') return 'quality wrong';
      const low = obs.find((o) => o.externalId === 'VIIRS_SNPP_NRT:2026-09-21T0742:34.15444:-118.19521');
      if (low?.payload['confidence'] !== 'low' || !low.quality.flags?.includes('low-confidence'))
        return 'low confidence not mapped';
      const day = obs.find((o) => o.externalId === 'VIIRS_SNPP_NRT:2026-09-20T1321:39.58012:-8.24551');
      if (day?.payload['dayNight'] !== 'day') return 'daynight D not mapped';
      const south = obs.find((o) => o.externalId === 'VIIRS_NOAA20_NRT:2026-09-21T0250:-33.61302:150.21101');
      if (!south || south.position?.latitude !== -33.61302) return 'southern-hemisphere detection missing';
      if (!obs.every((o) => o.rawPayloadHash && /^[0-9a-f]{64}$/.test(o.rawPayloadHash)))
        return 'rawPayloadHash missing (raw retention allowed)';
      if (
        !obs.every(
          (o) =>
            o.provenance.sourceRef?.includes('/api/area/csv/{MAP_KEY}/') ||
            o.provenance.sourceRef?.includes('/api/area/csv/'),
        )
      )
        return 'sourceRef missing';
      if (obs.some((o) => /MAP_KEY=[^{]/.test(o.provenance.sourceRef ?? ''))) return 'sourceRef leaks the key';
      return undefined;
    },
    verifyHealth: (h) =>
      h.objectCount === 19 && h.credentialState === 'present'
        ? undefined
        : `objectCount ${h.objectCount} credentialState ${h.credentialState}`,
  },
});
