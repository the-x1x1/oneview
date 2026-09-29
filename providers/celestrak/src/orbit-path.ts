import type { ObjectTrackPoint } from '@worldview/provider-sdk';
import { orbitSummary, type GpElements } from './elements.js';
import type { Propagator } from './propagator.js';

/**
 * One orbital period of a satellite ahead of `startMs`, as positions for the selected
 * satellite's predicted path (the provider's `objectTrack`, provider-sdk object-track.ts).
 *
 * The positions are SGP4 from the element set the object already carries — the same
 * propagator that places the satellite — at `steps` equal intervals over one period
 * (1440 / mean motion minutes), both ends included. They are Earth-fixed: the line the map
 * draws is where over the Earth the satellite will be, the ground track at altitude, which
 * after one period ends west of where it began by the Earth's turn in that time (~23° for a
 * 93-minute low orbit). A geostationary satellite's path is therefore nearly a point.
 *
 * A period longer than MAX_PATH_MS (anything above ~24 h: high elliptical and beyond) is
 * cut there, and a position the propagator cannot give (decay) ends the path.
 */
export const ORBIT_PATH_STEPS = 180;
export const MAX_PATH_MS = 24 * 3600_000;

export function orbitPath(
  propagator: Propagator,
  elements: GpElements,
  startMs: number,
  steps = ORBIT_PATH_STEPS,
): ObjectTrackPoint[] {
  const periodMs = Math.min(MAX_PATH_MS, orbitSummary(elements).periodMinutes * 60_000);
  if (!Number.isFinite(periodMs) || periodMs <= 0 || steps < 1) return [];
  const out: ObjectTrackPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const atMs = startMs + (periodMs * i) / steps;
    let state;
    try {
      state = propagator.propagate(elements, atMs);
    } catch {
      state = undefined;
    }
    if (
      !state ||
      !Number.isFinite(state.latitude) ||
      !Number.isFinite(state.longitude) ||
      !Number.isFinite(state.altitudeM) ||
      state.altitudeM < 0
    )
      break;
    out.push({
      observedAt: new Date(Math.round(atMs)).toISOString(),
      latitude: round(state.latitude, 4),
      longitude: round(state.longitude, 4),
      altitudeM: Math.round(state.altitudeM),
    });
  }
  return out;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
