import { EARTH_RADIUS_M, normalizeLongitude, type GeoPosition, type WorldObject } from '@worldview/world-model';
import type { RenderMotion } from './contract.js';

/**
 * Where a moving object is between reports (RenderFeature.motion).
 *
 * A satellite's two ends are both SGP4 propagations. An aircraft or a ship has only its last
 * report, so its second end is dead reckoned: the reported position carried along the
 * reported ground track at the reported ground speed (and, for an aircraft, climbing or
 * descending at the reported vertical rate) for `horizonMs`. The renderer places it by
 * wall-clock time between the two ends and, like a late satellite, at most one more span past
 * the second — so an aircraft is drawn at most 2 × 30 s ahead of its last report, then held
 * there until the next one arrives. It never flies on indefinitely on an old report.
 *
 * Without this an aircraft stood still between polls and then jumped: 2.5 km at 250 m/s for
 * a ten-second poll, and further whenever adsb.lol asked us to wait (a 429 served the last
 * answer again for up to a minute).
 */

/** How far past the second end a renderer carries a moving marker, in spans (layers/motion.ts in render-cesium). */
export const MOTION_MAX_T = 2;

/** Dead-reckoning span per type: the second end is this far ahead of the report. */
export const DEAD_RECKONING_HORIZON_MS: Readonly<Record<string, number>> = Object.freeze({
  aircraft: 30_000,
  vessel: 60_000,
});

/**
 * Slowest ground speed that is dead reckoned (m/s). Below it the report is drawn where it is:
 * a hovering helicopter's or a moored ship's speed is noise, not motion.
 */
const MIN_SPEED_MPS: Readonly<Record<string, number>> = Object.freeze({ aircraft: 5, vessel: 0.5 });
/** Fastest believed (m/s): Mach 3 for an aircraft, 60 kn for a ship. Anything faster is a bad report. */
const MAX_SPEED_MPS: Readonly<Record<string, number>> = Object.freeze({ aircraft: 1000, vessel: 31 });
/** Steepest believed climb or descent (m/s, ≈ 12,000 ft/min). */
const MAX_VERTICAL_MPS = 60;

const DEG = Math.PI / 180;

/** The point `distanceM` along the great circle leaving `from` on `bearingDeg`. */
export function destinationPoint(from: GeoPosition, bearingDeg: number, distanceM: number): GeoPosition {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = bearingDeg * DEG;
  const φ1 = from.latitude * DEG;
  const λ1 = from.longitude * DEG;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2);
  const out: GeoPosition = { latitude: φ2 / DEG, longitude: normalizeLongitude(λ2 / DEG) };
  if (from.altitudeM !== undefined) out.altitudeM = from.altitudeM;
  return out;
}

/**
 * An aircraft's or ship's dead-reckoned move from its last report, or undefined when it is not
 * moving, is on the ground, or its report does not say how it moves.
 */
export function deadReckonedMotion(obj: WorldObject): RenderMotion | undefined {
  const horizonMs = DEAD_RECKONING_HORIZON_MS[obj.type];
  if (horizonMs === undefined || !obj.position || !obj.motion) return undefined;
  const speed = obj.motion.speedMps;
  const heading = obj.motion.headingDegrees;
  if (speed === undefined || heading === undefined || !Number.isFinite(speed) || !Number.isFinite(heading))
    return undefined;
  if (speed < MIN_SPEED_MPS[obj.type]! || speed > MAX_SPEED_MPS[obj.type]!) return undefined;
  // Taxiways turn: a report on the ground is drawn where it is.
  if (obj.properties['onGround'] === true) return undefined;
  const fromMs = Date.parse(obj.observedAt);
  if (!Number.isFinite(fromMs)) return undefined;
  const to = destinationPoint(obj.position, heading, (speed * horizonMs) / 1000);
  const vs = obj.motion.verticalSpeedMps;
  if (obj.position.altitudeM !== undefined && vs !== undefined && Number.isFinite(vs) && obj.type === 'aircraft') {
    const alt = obj.position.altitudeM;
    const climb = Math.max(-MAX_VERTICAL_MPS, Math.min(MAX_VERTICAL_MPS, vs));
    // Carried MOTION_MAX_T spans, a descent must still end at or above sea level.
    to.altitudeM = Math.max(Math.min(alt, alt - alt / MOTION_MAX_T), alt + (climb * horizonMs) / 1000);
  }
  return { to, fromMs, toMs: fromMs + horizonMs };
}

/** The move's fraction at `nowMs`: 0 at the first end, 1 at the second, held at MOTION_MAX_T. */
export function motionFraction(motion: Pick<RenderMotion, 'fromMs' | 'toMs'>, nowMs: number): number {
  const span = motion.toMs - motion.fromMs;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(MOTION_MAX_T, (nowMs - motion.fromMs) / span));
}

/**
 * Where a feature moving from `from` is at `nowMs`, in longitude/latitude — for a renderer that
 * places markers in degrees (2D). Linear in degrees, the short way round the antimeridian: over
 * one span (tens of seconds to two minutes) that is within metres of the great circle, except
 * within a few kilometres of a pole, where nothing is dead reckoned for long.
 */
export function positionAlong(from: GeoPosition, motion: RenderMotion, nowMs: number): [number, number] {
  const t = motionFraction(motion, nowMs);
  let dLon = motion.to.longitude - from.longitude;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  const lat = from.latitude + (motion.to.latitude - from.latitude) * t;
  return [normalizeLongitude(from.longitude + dLon * t), Math.max(-90, Math.min(90, lat))];
}

/** Ground speed of a move in m/s (chord over span): what a renderer needs to pace its steps. */
export function motionSpeedMps(from: GeoPosition, motion: RenderMotion): number {
  const span = (motion.toMs - motion.fromMs) / 1000;
  if (!(span > 0)) return 0;
  const φ1 = from.latitude * DEG;
  const φ2 = motion.to.latitude * DEG;
  const dφ = φ2 - φ1;
  let dλ = (motion.to.longitude - from.longitude) * DEG;
  if (dλ > Math.PI) dλ -= 2 * Math.PI;
  else if (dλ < -Math.PI) dλ += 2 * Math.PI;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const ground = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  const dAlt = (motion.to.altitudeM ?? 0) - (from.altitudeM ?? 0);
  return Math.sqrt(ground * ground + dAlt * dAlt) / span;
}
