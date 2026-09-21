import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { AisStreamProvider } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'aisstream', 'frames');
const frame = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

/**
 * Subscription provider plan. The checklist drives a FixtureSocket synchronously and waits
 * 10 ms, so batches are flushed per frame (`flushIntervalMs: 0`). The API key is injected by
 * a fixture secret resolver — the production runtime must provide the same hook.
 * The checklist subscribes without viewport bounds, so the out-of-bounds frame is admitted
 * here; bounds filtering is covered by the provider's unit tests.
 */
export const plan = definePlan({
  providerDir: 'ais',
  create: () => new AisStreamProvider({ secretResolver: async () => 'fixture-key', flushIntervalMs: 0 }),
  credentials: ['aisstream.apiKey'],
  clockStartMs: Date.parse('2026-09-21T08:00:10.000Z'),
  fixtures: {
    // Not used by a subscription provider, but required by the plan shape.
    normal: () => ({ status: 200, body: '' }),
  },
  subscription: {
    frames: ['01-position-report.json', '02-position-heading-511.json', '03-position-anchored.json', '04-ship-static-data.json', '05-malformed.json', '06-out-of-bounds.json'].map(frame),
    minObservations: 5,
  },
  expectations: {
    objectTypes: ['vessel'],
    minObservations: 5,
    expectObjectIds: ['vessel:mmsi:366123456', 'vessel:mmsi:338987654', 'vessel:mmsi:002320001', 'vessel:mmsi:431009876'],
    verify: (obs) => {
      const trader = obs.find((o) => o.externalId === '366123456' && !o.quality.flags?.includes('static-data'));
      if (!trader) return 'position report for 366123456 missing';
      if (trader.observedAt !== '2026-09-21T08:00:03.123Z') return `time_utc with nanoseconds not parsed: ${trader.observedAt}`;
      if (trader.position?.altitudeDatum !== 'sea-surface' || trader.position.latitude !== 21.3044) return 'position wrong';
      if (trader.payload['speedMps'] !== 5.86 || trader.payload['headingDegrees'] !== 252 || trader.payload['courseDegrees'] !== 254.3) return `motion payload wrong (${String(trader.payload['speedMps'])}/${String(trader.payload['headingDegrees'])}/${String(trader.payload['courseDegrees'])})`;
      if (trader.payload['navStatus'] !== 0 || trader.payload['name'] !== 'KALIHI TRADER' || trader.payload['mmsi'] !== '366123456') return 'identity payload wrong';
      if (trader.quality.sourceQuality !== 'crowdsourced' || trader.rawPayloadHash !== undefined) return 'quality/raw retention wrong';
      const fallback = obs.find((o) => o.externalId === '338987654');
      if (!fallback || fallback.payload['headingDegrees'] !== 96.5 || !fallback.quality.flags?.includes('heading-from-cog')) return 'TrueHeading 511 must fall back to COG';
      if (fallback.payload['rateOfTurnDegPerMin'] !== undefined) return 'ROT −128 must be dropped';
      const anchored = obs.find((o) => o.externalId === '002320001');
      if (!anchored) return 'short MMSI not zero-padded';
      if (anchored.payload['speedMps'] !== undefined || anchored.payload['courseDegrees'] !== undefined) return 'SOG 102.3 / COG 360 sentinels leaked';
      if (anchored.payload['headingDegrees'] !== 14 || anchored.payload['navStatusText'] !== 'at anchor' || !anchored.quality.flags?.includes('turning-right')) return 'anchored vessel payload wrong';
      const stat = obs.find((o) => o.externalId === '366123456' && o.quality.flags?.includes('static-data'));
      if (!stat) return 'ShipStaticData observation missing';
      if (stat.payload['imo'] !== '9312345' || stat.payload['callSign'] !== 'WDK4421' || stat.payload['shipTypeText'] !== 'cargo' || stat.payload['lengthM'] !== 162 || stat.payload['beamM'] !== 25 || stat.payload['draughtM'] !== 8.4 || stat.payload['destination'] !== 'HONOLULU') return 'static payload wrong';
      if (stat.quality.complete !== false) return 'static data must be marked incomplete';
      if (obs.some((o) => o.externalId === 'not-an-mmsi')) return 'malformed frame leaked';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 4 && h.credentialState === 'present' ? undefined : `objectCount ${h.objectCount} credentialState ${h.credentialState}`),
  },
});
