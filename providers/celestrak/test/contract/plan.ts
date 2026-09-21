import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { CelestrakProvider, CircularOrbitPropagator } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'celestrak');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

/**
 * The checklist runs every scenario against the upstream path, so the catalog
 * reuse window is set to 0 here (in production it is 2 h — CelesTrak etiquette —
 * and covered by unit tests in src/index.test.ts). The deterministic circular
 * propagator replaces satellite.js so fixtures resolve to the same positions on
 * every machine.
 */
export const plan = definePlan({
  providerDir: 'celestrak',
  create: () => new CelestrakProvider({ propagator: new CircularOrbitPropagator(), catalogMaxAgeMs: 0 }),
  settings: { groups: ['stations', 'visual'], maxObjects: 5000 },
  fixtures: {
    normal: () => ({ status: 200, body: body('normal.json'), headers: { 'content-type': 'application/json' } }),
    empty: () => ({ status: 200, body: body('empty.json') }),
    stale: () => ({ status: 200, body: body('stale.json') }),
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.json') }),
      () => ({ status: 200, body: body('malformed-allbad.json') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notfound.txt') }),
      () => ({ status: 200, body: body('malformed-html.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: ['satellite'],
    minObservations: 12,
    expectObjectIds: ['satellite:norad:25544', 'satellite:norad:41866', 'satellite:norad:57001'],
    verify: (obs) => {
      const iss = obs.find((o) => o.externalId === '25544');
      if (!iss) return 'ISS missing';
      if (iss.payload['name'] !== 'ISS (ZARYA)' || iss.payload['noradId'] !== 25544 || iss.payload['intlDesignator'] !== '1998-067A') return 'ISS payload wrong';
      if (iss.position?.altitudeDatum !== 'orbit' || !(iss.position.altitudeM > 350_000 && iss.position.altitudeM < 500_000)) return `ISS altitude implausible: ${String(iss.position?.altitudeM)}`;
      if (Math.abs(iss.position.latitude) > 51.7) return 'ISS latitude exceeds inclination';
      if (iss.observedAt !== '2026-09-21T03:12:34.123Z' || iss.effectiveFrom !== iss.observedAt) return 'observedAt/effectiveFrom must equal the element epoch';
      if (iss.effectiveUntil !== '2026-09-28T03:12:34.123Z') return 'effectiveUntil must be epoch + 7 d';
      if (typeof iss.payload['periodMinutes'] !== 'number' || Math.abs((iss.payload['periodMinutes'] as number) - 92.9) > 0.2) return 'periodMinutes wrong';
      if (typeof iss.payload['speedMps'] !== 'number' || Math.abs((iss.payload['speedMps'] as number) - 7660) > 60) return 'speedMps implausible';
      if (typeof iss.payload['headingDegrees'] !== 'number') return 'headingDegrees missing';
      const geo = obs.find((o) => o.externalId === '41866');
      if (!geo || !(geo.position!.altitudeM > 35_000_000 && geo.position!.altitudeM < 36_500_000)) return 'GOES 16 not at GEO altitude';
      if (Math.abs(geo!.position!.latitude) > 0.5) return 'GOES 16 latitude not near the equator';
      // Both groups return the same catalog: dedupe across groups keeps the first (stations) copy only.
      if (obs.length !== 12) return `expected 12 unique objects across two groups, got ${obs.length}`;
      if (obs.some((o) => o.payload['group'] !== 'stations')) return 'dedupe across groups should keep the first group';
      if (!obs.every((o) => o.quality.flags?.includes('propagated') && o.quality.sourceQuality === 'authoritative')) return 'quality flags missing';
      if (!obs.every((o) => o.rawPayloadHash && /^[0-9a-f]{64}$/.test(o.rawPayloadHash))) return 'rawPayloadHash missing';
      return undefined;
    },
    verifyHealth: (h) => (h.objectCount === 12 ? undefined : `objectCount ${h.objectCount}`),
  },
});
