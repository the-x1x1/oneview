import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createDigitrafficAisProvider } from '../../src/index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'digitraffic-ais',
);
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
const json = { 'content-type': 'application/json' };
/** Positions from `locations`, static data from `vessels`, whatever the scenario. */
const answer =
  (locations: string, vessels = '[]') =>
  (req: { url: string }) =>
    new URL(req.url).pathname.endsWith('/vessels')
      ? { status: 200, body: vessels, headers: json }
      : { status: 200, body: locations, headers: json };

/**
 * Invented fixtures (fixtures/digitraffic-ais/README.md) at 2026-09-28T10:00:00Z; the clock
 * starts half a minute later, so the freshest reports classify LIVE.
 */
export const digitrafficPlan = definePlan({
  providerDir: 'ais',
  aliases: ['digitraffic-ais'],
  create: () => createDigitrafficAisProvider(),
  clockStartMs: Date.parse('2026-09-28T10:00:30.000Z'),
  fixtures: {
    normal: answer(body('locations.json'), body('vessels.json')),
    empty: answer(body('locations-empty.json')),
    stale: answer(body('locations-stale.json')),
    malformed: [
      answer(body('locations-malformed-rows.json')),
      answer(body('locations-malformed-shape.json')),
      answer(body('malformed-notjson.txt')),
      answer(''),
    ],
  },
  expectations: {
    objectTypes: ['vessel'],
    minObservations: 5,
    expectObjectIds: [
      'vessel:mmsi:230145250',
      'vessel:mmsi:276829000',
      'vessel:mmsi:265547250',
      'vessel:mmsi:212345000',
      'vessel:mmsi:992301234',
    ],
    verify: (obs) => {
      if (obs.length !== 5) return `expected 5 ships, got ${obs.length}`;
      const ferry = obs.find((o) => o.externalId === '230145250');
      if (!ferry) return 'ferry missing';
      if (ferry.observedAt !== '2026-09-28T09:59:40.000Z') return `newer report must win, got ${ferry.observedAt}`;
      const p = ferry.payload;
      if (p['name'] !== 'TESTFERRY' || p['callSign'] !== 'OJTS1' || p['imo'] !== '9999001')
        return 'static data not folded into the position';
      if (p['flag'] !== 'Finland' || p['shipTypeText'] !== 'passenger' || p['destination'] !== 'HELSINKI')
        return `flag/type/destination wrong (${String(p['flag'])}, ${String(p['shipTypeText'])})`;
      if (p['lengthM'] !== 150 || p['beamM'] !== 27 || p['draughtM'] !== 6.8) return 'dimensions/draught wrong';
      if (JSON.stringify(p['eta']) !== '{"month":9,"day":28,"hour":11,"minute":30}') return 'ETA not decoded';
      if (p['speedMps'] !== 9.36 || p['courseDegrees'] !== 185.3 || p['headingDegrees'] !== 186) return 'motion wrong';
      if (ferry.quality.sourceQuality !== 'authoritative' || ferry.quality.positionAccuracyM !== 10)
        return 'quality wrong';
      const cargo = obs.find((o) => o.externalId === '276829000');
      if (!cargo?.quality.flags?.includes('heading-from-cog') || cargo.payload['lengthM'] !== 120)
        return 'heading 511 / MQTT reference-point spelling not handled';
      if (cargo.payload['draughtM'] !== 25.5 || cargo.payload['eta'] !== undefined) return 'draught 255 / ETA 0 wrong';
      const tanker = obs.find((o) => o.externalId === '212345000');
      if (!tanker || tanker.payload['speedMps'] !== undefined || !tanker.quality.flags?.includes('turning-right'))
        return 'SOG 102.3 / ROT 127 sentinels not handled';
      if (tanker.payload['imo'] !== undefined || tanker.payload['shipTypeText'] !== 'tanker')
        return 'tanker static data wrong';
      const anchored = obs.find((o) => o.externalId === '265547250');
      if (
        !anchored ||
        anchored.payload['courseDegrees'] !== undefined ||
        anchored.payload['navStatusText'] !== 'at anchor'
      )
        return 'COG 360 / nav status wrong';
      const aton = obs.find((o) => o.externalId === '992301234');
      if (aton?.payload['mmsiKind'] === undefined) return 'aid to navigation not marked as such';
      if (!obs.every((o) => o.rawPayloadHash && /^[0-9a-f]{64}$/.test(o.rawPayloadHash)))
        return 'rawPayloadHash missing (raw retention allowed)';
      if (!obs.every((o) => o.provenance.attribution.includes('Fintraffic / digitraffic.fi, license CC 4.0 BY')))
        return 'CC BY notice missing';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 5 ? undefined : `objectCount ${h.objectCount}`),
  },
});
