import type * as SatelliteJs from 'satellite.js';
import { bearingDegrees } from '@worldview/world-model';
import type { GpElements } from './elements.js';
import type { Propagator, PropagatedState } from './propagator.js';

/**
 * SGP4 propagation through satellite.js (loaded lazily so the provider can be
 * type-checked, tested and even instantiated without the library present).
 *
 * Adapted from gods-eye-view src/layers/satellites/orbits.js (MIT):
 * twoline2satrec → propagate → eciToGeodetic(gstime) → degreesLat/Long, with
 * satrec.error checks and the km→m conversions kept.
 */
export type SatelliteJsModule = Pick<typeof SatelliteJs, 'twoline2satrec' | 'json2satrec' | 'propagate' | 'gstime' | 'eciToGeodetic' | 'degreesLat' | 'degreesLong'>;

const MAX_CACHED_SATRECS = 20_000;

export class SatelliteJsPropagator implements Propagator {
  readonly name = 'satellite.js (SGP4)';
  private lib: SatelliteJsModule | undefined;
  private readonly satrecs = new Map<string, SatelliteJs.SatRec | null>();

  constructor(private readonly loader: () => Promise<SatelliteJsModule> = () => import('satellite.js')) {}

  get ready(): boolean { return this.lib !== undefined; }

  async prepare(): Promise<void> {
    if (this.lib) return;
    try {
      this.lib = await this.loader();
    } catch (err) {
      throw new Error(`satellite.js is not available: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  propagate(elements: GpElements, atMs: number): PropagatedState | undefined {
    const lib = this.lib;
    if (!lib) throw new Error('SatelliteJsPropagator.prepare() must complete before propagate()');
    const satrec = this.satrec(lib, elements);
    if (!satrec) return undefined;
    const now = geodeticAt(lib, satrec, atMs);
    if (!now) return undefined;
    const next = geodeticAt(lib, satrec, atMs + 1000);
    const state: PropagatedState = { latitude: now.latitude, longitude: now.longitude, altitudeM: now.altitudeM, speedMps: now.speedMps };
    if (next) state.headingDegrees = bearingDegrees(now, next);
    return state;
  }

  private satrec(lib: SatelliteJsModule, e: GpElements): SatelliteJs.SatRec | undefined {
    const key = `${e.noradId}:${e.epoch}:${e.line1 ? 'tle' : 'omm'}`;
    const cached = this.satrecs.get(key);
    if (cached !== undefined) return cached ?? undefined;
    if (this.satrecs.size >= MAX_CACHED_SATRECS) this.satrecs.clear();
    let rec: SatelliteJs.SatRec | null = null;
    try {
      rec = e.line1 && e.line2 ? lib.twoline2satrec(e.line1, e.line2) : lib.json2satrec(toOmm(e));
      if (rec.error !== 0) rec = null;
    } catch { rec = null; }
    this.satrecs.set(key, rec);
    return rec ?? undefined;
  }
}

function geodeticAt(lib: SatelliteJsModule, satrec: SatelliteJs.SatRec, atMs: number): { latitude: number; longitude: number; altitudeM: number; speedMps: number } | undefined {
  const date = new Date(atMs);
  let pv: SatelliteJs.PositionAndVelocity;
  try { pv = lib.propagate(satrec, date); } catch { return undefined; }
  const pos = pv.position;
  if (!pos || typeof pos === 'boolean') return undefined;
  const geo = lib.eciToGeodetic(pos, lib.gstime(date));
  const vel = pv.velocity;
  const speedMps = vel && typeof vel !== 'boolean' ? Math.hypot(vel.x, vel.y, vel.z) * 1000 : Number.NaN;
  const out = { latitude: lib.degreesLat(geo.latitude), longitude: lib.degreesLong(geo.longitude), altitudeM: geo.height * 1000, speedMps };
  if (![out.latitude, out.longitude, out.altitudeM, out.speedMps].every(Number.isFinite)) return undefined;
  return out;
}

/** Rebuild the OMM record satellite.js's json2satrec expects from our element shape. */
export function toOmm(e: GpElements): SatelliteJs.OMMJsonObject {
  return {
    OBJECT_NAME: e.name,
    OBJECT_ID: e.intlDesignator ?? '',
    EPOCH: e.epoch.replace(/Z$/, ''),
    MEAN_MOTION: e.meanMotion,
    ECCENTRICITY: e.eccentricity,
    INCLINATION: e.inclination,
    RA_OF_ASC_NODE: e.raan,
    ARG_OF_PERICENTER: e.argPerigee,
    MEAN_ANOMALY: e.meanAnomaly,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: e.classification ?? 'U',
    NORAD_CAT_ID: e.noradId,
    ELEMENT_SET_NO: e.elementSetNo ?? 999,
    REV_AT_EPOCH: e.revAtEpoch ?? 0,
    BSTAR: e.bstar ?? 0,
    MEAN_MOTION_DOT: e.meanMotionDot ?? 0,
    MEAN_MOTION_DDOT: e.meanMotionDdot ?? 0,
  };
}
