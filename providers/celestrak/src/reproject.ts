import type { JsonValue, WorldObject } from '@worldview/world-model';
import { validateElements, type GpElements } from './elements.js';
import { ELEMENT_VALIDITY_MS } from './manifest.js';
import type { Propagator } from './propagator.js';
import { SatelliteJsPropagator } from './satellite-js-propagator.js';

/**
 * Where a satellite was at a replay cursor, from the element set history kept for it.
 *
 * History keeps a satellite once per element set (history-store dedupe.ts): the observation
 * is the element set, and its stored position is merely wherever the first propagation of
 * it happened to put the satellite. Replaying that position shows the satellite frozen at
 * that point for hours — thousands of kilometres from where it was at the cursor. The
 * element set is in the stored properties, so the position at any cursor can be computed
 * exactly as live does: propagate it to that time.
 */
export interface SatelliteReprojector {
  readonly types: readonly string[];
  /** Load the propagator; until it has, `at` answers undefined and the stored position stands. */
  prepare(): Promise<void>;
  at(object: WorldObject, atMs: number): WorldObject | undefined;
}

const MAX_ELEMENT_AGE_MS = 30 * 24 * 3600_000;

export function createSatelliteReprojector(propagator: Propagator = new SatelliteJsPropagator()): SatelliteReprojector {
  let ready = !propagator.prepare;
  return {
    types: ['satellite'],
    async prepare() {
      if (ready || !propagator.prepare) return;
      await propagator.prepare();
      ready = true;
    },
    at(object, atMs) {
      if (!ready || object.type !== 'satellite') return undefined;
      const e = elementsFromProperties(object.properties);
      if (!e) return undefined;
      const age = atMs - Date.parse(e.epoch);
      if (!Number.isFinite(age) || age > MAX_ELEMENT_AGE_MS || age < -ELEMENT_VALIDITY_MS) return undefined;
      let state;
      try {
        state = propagator.propagate(e, atMs);
      } catch {
        return undefined;
      }
      if (!state || !Number.isFinite(state.latitude) || !Number.isFinite(state.longitude)) return undefined;
      return {
        ...object,
        position: {
          latitude: state.latitude,
          longitude: state.longitude,
          altitudeM: Math.round(state.altitudeM),
          altitudeDatum: 'orbit',
        },
        motion: {
          ...object.motion,
          speedMps: Math.round(state.speedMps * 10) / 10,
          ...(state.headingDegrees !== undefined && Number.isFinite(state.headingDegrees)
            ? { headingDegrees: Math.round(state.headingDegrees * 10) / 10 }
            : {}),
        },
        properties: withoutNext({ ...object.properties, propagatedAt: new Date(atMs).toISOString() }),
      };
    },
  };
}

/**
 * A replayed satellite is where the cursor puts it and nowhere else: the live poll's
 * `nextPosition`, kept with the stored element set, belongs to another moment.
 */
function withoutNext(p: Record<string, JsonValue>): Record<string, JsonValue> {
  delete p['nextPosition'];
  return p;
}

/** The element set normalize.ts stored in a satellite's properties, or undefined when it is incomplete. */
export function elementsFromProperties(p: Record<string, JsonValue>): GpElements | undefined {
  const num = (k: string) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : undefined);
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  const noradId = num('noradId');
  const epoch = str('epoch');
  const meanMotion = num('meanMotion');
  const eccentricity = num('eccentricity');
  const inclination = num('inclination');
  const raan = num('raan');
  const argPerigee = num('argPerigee');
  const meanAnomaly = num('meanAnomaly');
  if (
    noradId === undefined ||
    epoch === undefined ||
    meanMotion === undefined ||
    eccentricity === undefined ||
    inclination === undefined ||
    raan === undefined ||
    argPerigee === undefined ||
    meanAnomaly === undefined
  )
    return undefined;
  const e: GpElements = {
    noradId,
    name: str('name') ?? String(noradId),
    epoch,
    meanMotion,
    eccentricity,
    inclination,
    raan,
    argPerigee,
    meanAnomaly,
  };
  const bstar = num('bstar');
  if (bstar !== undefined) e.bstar = bstar;
  const intl = str('intlDesignator');
  if (intl) e.intlDesignator = intl;
  const cls = str('classification');
  if (cls) e.classification = cls;
  const line1 = str('line1');
  const line2 = str('line2');
  if (line1 && line2) {
    e.line1 = line1;
    e.line2 = line2;
  }
  return validateElements(e) === undefined ? e : undefined;
}
