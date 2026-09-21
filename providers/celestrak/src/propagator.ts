import type { GpElements } from './elements.js';

/** Geodetic state of a satellite at one instant. */
export interface PropagatedState {
  latitude: number;
  longitude: number;
  /** Height above the WGS84 ellipsoid (or a spherical approximation, see the propagator), metres. */
  altitudeM: number;
  /** Inertial speed, m/s. */
  speedMps: number;
  /** Ground-track direction of travel, degrees clockwise from north. */
  headingDegrees?: number;
}

/**
 * Propagator — turns an element set into a position at a given time.
 *
 * `prepare()` is where a propagator loads optional native/third-party code
 * (satellite.js is loaded lazily so the provider still type-checks and runs
 * without it). `propagate()` must be synchronous and side-effect free apart from
 * internal caching; returning undefined means "this element set cannot be
 * propagated" (decayed, invalid) and the object is skipped with a reason.
 */
export interface Propagator {
  readonly name: string;
  prepare?(): Promise<void>;
  propagate(elements: GpElements, atMs: number): PropagatedState | undefined;
}
