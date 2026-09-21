import { Ids, isAuthoritativeId, makeObjectId, type Observation } from '@worldview/world-model';

/**
 * @worldview/identity — deterministic cross-source identity resolution (ADR-011).
 *
 * An observation maps to exactly one WorldObject id through an explicit, tested
 * rule. Allowed joins are authoritative identifiers only:
 *
 *   aircraft   ← payload.icao24        (ICAO 24-bit hex)
 *   vessel     ← payload.mmsi
 *   satellite  ← payload.noradId
 *   earthquake ← externalId (USGS event id; other catalogs use their own namespace)
 *   airport    ← payload.icao (4-letter ICAO location indicator)
 *   otherwise  ← provider-scoped id: <type>:<providerId>:<externalId>
 *
 * No fuzzy matching. No name/position heuristics. No LLM. If identity is uncertain
 * the observation keeps a provider-scoped id and the objects stay separate — false
 * merges are worse than duplicates.
 */
export interface IdentityResolution {
  objectId: string;
  authoritative: boolean;
  rule: string;
}

export type IdentityRule = (observation: Observation) => IdentityResolution | undefined;

const ICAO24 = /^[0-9a-f]{6}$/i;
const MMSI = /^\d{9}$/;
const NORAD = /^\d{1,9}$/;
/**
 * ICAO location indicator: exactly four letters (ADR-011). Digits appear in local/FAA
 * identifiers that are not globally unique, so they are deliberately excluded — an
 * airport without a valid ICAO stays provider-scoped rather than risking a false merge.
 */
const ICAO_AIRPORT = /^[A-Za-z]{4}$/;

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export const authoritativeRules: Readonly<Record<string, IdentityRule>> = Object.freeze({
  aircraft: (o) => {
    const hex = str(o.payload['icao24']) ?? (o.externalId && ICAO24.test(o.externalId) ? o.externalId : undefined);
    if (!hex || !ICAO24.test(hex)) return undefined;
    return { objectId: Ids.aircraftByIcao24(hex), authoritative: true, rule: 'aircraft.icao24' };
  },
  vessel: (o) => {
    const mmsi = str(o.payload['mmsi']) ?? (o.externalId && MMSI.test(o.externalId) ? o.externalId : undefined);
    if (!mmsi || !MMSI.test(mmsi)) return undefined;
    return { objectId: Ids.vesselByMmsi(mmsi), authoritative: true, rule: 'vessel.mmsi' };
  },
  satellite: (o) => {
    const norad = str(o.payload['noradId']) ?? (o.externalId && NORAD.test(o.externalId) ? o.externalId : undefined);
    if (!norad || !NORAD.test(norad)) return undefined;
    return { objectId: Ids.satelliteByNorad(norad), authoritative: true, rule: 'satellite.norad' };
  },
  earthquake: (o) => {
    if (o.providerId !== 'usgs-earthquakes' || !o.externalId) return undefined;
    return { objectId: Ids.earthquakeByUsgs(o.externalId), authoritative: true, rule: 'earthquake.usgs' };
  },
  airport: (o) => {
    const icao = str(o.payload['icao']) ?? (o.externalId && ICAO_AIRPORT.test(o.externalId) ? o.externalId : undefined);
    if (!icao || !ICAO_AIRPORT.test(icao)) return undefined;
    return { objectId: Ids.airportByIcao(icao), authoritative: true, rule: 'airport.icao' };
  },
});

export class IdentityResolver {
  private readonly rules: Map<string, IdentityRule[]>;

  constructor(rules: Readonly<Record<string, IdentityRule | IdentityRule[]>> = authoritativeRules) {
    this.rules = new Map();
    for (const [type, r] of Object.entries(rules)) this.rules.set(type, Array.isArray(r) ? [...r] : [r]);
  }

  /** Register an additional deterministic rule for a type (evaluated after existing ones). */
  addRule(objectType: string, rule: IdentityRule): void {
    const list = this.rules.get(objectType) ?? [];
    list.push(rule);
    this.rules.set(objectType, list);
  }

  resolve(observation: Observation): IdentityResolution {
    for (const rule of this.rules.get(observation.objectType) ?? []) {
      const r = rule(observation);
      if (r) return r;
    }
    const value = observation.externalId ?? observation.id;
    let objectId: string;
    try {
      objectId = makeObjectId(observation.objectType, observation.providerId, value);
    } catch {
      objectId = makeObjectId(observation.objectType, observation.providerId, encodeValue(value));
    }
    return { objectId, authoritative: isAuthoritativeId(objectId), rule: 'provider-scoped' };
  }
}

/** Make arbitrary external ids safe for the id grammar (reversible enough for display, deterministic). */
export function encodeValue(value: string): string {
  const out = value.replace(/[^A-Za-z0-9._:+@-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);
  return /^[A-Za-z0-9]/.test(out) ? out : `x${out}`;
}

export const defaultIdentityResolver = new IdentityResolver();
