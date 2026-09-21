import { bearingDegrees, normalizeLongitude } from '@worldview/world-model';
import type { GpElements } from './elements.js';
import { semiMajorAxisKm } from './elements.js';
import type { Propagator, PropagatedState } from './propagator.js';

/**
 * CircularOrbitPropagator — a deterministic Keplerian *circular* approximation.
 *
 * NOT FOR PRODUCTION. It ignores eccentricity, drag, J2 nodal precession and uses
 * geocentric latitude over a spherical Earth. It exists so contract tests and
 * fixtures are reproducible without satellite.js, and so a reviewer can verify the
 * normalizer by hand: the sub-satellite point moves along the orbital plane at the
 * mean motion, and the Earth rotates underneath at the sidereal rate.
 */
const MU_KM3_S2 = 398_600.4418;
const MEAN_EARTH_RADIUS_KM = 6371.0088;
const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

/** Greenwich mean sidereal time (radians) — IAU 1982 polynomial, adequate here. */
export function gmstRadians(atMs: number): number {
  const jd = atMs / 86_400_000 + 2_440_587.5;
  const d = jd - 2_451_545.0;
  const t = d / 36_525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t;
  return (((deg % 360) + 360) % 360) * DEG;
}

function subPoint(e: GpElements, aKm: number, nRadPerSec: number, atMs: number): { latitude: number; longitude: number; radiusKm: number } {
  const dt = (atMs - Date.parse(e.epoch)) / 1000;
  const u = (e.argPerigee + e.meanAnomaly) * DEG + nRadPerSec * dt; // argument of latitude
  const i = e.inclination * DEG;
  const raan = e.raan * DEG;
  const cu = Math.cos(u), su = Math.sin(u), ci = Math.cos(i), si = Math.sin(i), cr = Math.cos(raan), sr = Math.sin(raan);
  const x = aKm * (cr * cu - sr * su * ci);
  const y = aKm * (sr * cu + cr * su * ci);
  const z = aKm * (su * si);
  const lon = normalizeLongitude((Math.atan2(y, x) - gmstRadians(atMs)) / DEG);
  const lat = Math.atan2(z, Math.hypot(x, y)) / DEG;
  return { latitude: lat, longitude: lon, radiusKm: Math.hypot(x, y, z) };
}

export class CircularOrbitPropagator implements Propagator {
  readonly name = 'circular-orbit-approximation (not for production)';

  propagate(elements: GpElements, atMs: number): PropagatedState | undefined {
    if (!Number.isFinite(atMs) || !(elements.meanMotion > 0)) return undefined;
    const n = (elements.meanMotion * TWO_PI) / 86_400;
    const a = semiMajorAxisKm(elements.meanMotion);
    if (!Number.isFinite(a) || a <= MEAN_EARTH_RADIUS_KM) return undefined;
    const p0 = subPoint(elements, a, n, atMs);
    const p1 = subPoint(elements, a, n, atMs + 1000);
    const speedMps = Math.sqrt(MU_KM3_S2 / a) * 1000;
    return {
      latitude: p0.latitude,
      longitude: p0.longitude,
      altitudeM: (p0.radiusKm - MEAN_EARTH_RADIUS_KM) * 1000,
      speedMps,
      headingDegrees: bearingDegrees(p0, p1),
    };
  }
}
