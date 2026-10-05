import type { ViewState } from '@worldview/render-core';

/**
 * The globe by keyboard, as the 2D map already is by MapLibre's own keyboard handler: with
 * the globe focused (Tab to it, or click it), the arrow keys move the view a step towards the
 * top, bottom or sides of the screen, + and − zoom in and out by a factor of two, Shift with
 * ← → turns the view 15°, and Shift with ↑ ↓ tilts it 10° (from looking straight down to
 * looking 15° below the horizontal). Cesium has no keyboard control of its own, so without
 * this the globe needed a mouse.
 *
 * A step is a fifth of the camera's height over the ground, so it is the same share of the
 * view near the ground and in orbit. The view moves its camera point (`center`) and keeps its
 * height, heading and tilt; a tilted view moves with it.
 */

export interface MapKey {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** The keyboard's own repeat of a held key. */
  repeat?: boolean;
}

const DEG = Math.PI / 180;
const EARTH_RADIUS_M = 6_371_008.8;
/** A pan step as a share of the camera's height. */
export const PAN_SHARE = 0.2;
export const TURN_DEG = 15;
export const TILT_DEG = 10;
export const MIN_ALTITUDE_M = 100;
export const MAX_ALTITUDE_M = 40_000_000;
/** The flattest view the keyboard tilts to (the mouse can tilt further). */
export const MAX_PITCH_DEG = -15;

/** Where `distanceM` along `bearingDeg` from a point ends, on a sphere (a step of the view). */
function stepFrom(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceM: number,
): { latitude: number; longitude: number } {
  const φ1 = lat * DEG;
  const λ1 = lon * DEG;
  const θ = bearingDeg * DEG;
  const δ = distanceM / EARTH_RADIUS_M;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  const latitude = Math.max(-89, Math.min(89, φ2 / DEG));
  const longitude = ((((λ2 / DEG + 180) % 360) + 360) % 360) - 180;
  return { latitude, longitude };
}

/** The view one key moves to, or null for a key that is not a map key. */
export function globeKeyView(view: ViewState, k: MapKey): Partial<ViewState> | null {
  if (k.ctrlKey || k.altKey || k.metaKey) return null;
  const heading = view.headingDegrees;
  const altitude = Math.max(MIN_ALTITUDE_M, view.altitudeM);
  const arrow: Record<string, number> = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 };
  if (k.key in arrow) {
    if (k.shiftKey) {
      if (k.key === 'ArrowLeft' || k.key === 'ArrowRight') {
        const turned = heading + (k.key === 'ArrowRight' ? TURN_DEG : -TURN_DEG);
        return { headingDegrees: ((turned % 360) + 360) % 360 };
      }
      // Never the other way: a view the mouse tilted flatter than the keyboard's limit only
      // gets steeper.
      if (k.key === 'ArrowUp')
        return view.pitchDegrees >= MAX_PITCH_DEG
          ? null
          : { pitchDegrees: Math.min(MAX_PITCH_DEG, view.pitchDegrees + TILT_DEG) };
      return { pitchDegrees: Math.max(-90, view.pitchDegrees - TILT_DEG) };
    }
    const center = stepFrom(view.center.latitude, view.center.longitude, heading + arrow[k.key]!, altitude * PAN_SHARE);
    return { center };
  }
  if (k.key === '+' || k.key === '=') return { altitudeM: Math.max(MIN_ALTITUDE_M, altitude / 2) };
  if (k.key === '-' || k.key === '_') return { altitudeM: Math.min(MAX_ALTITUDE_M, altitude * 2) };
  return null;
}

/** How long a key's move flies (map-host passes it to `setView`). */
export const KEY_FLIGHT_MS = 200;

/** A key's move still in the air: where it is going, what was sent, and until when. */
export interface KeyFlight {
  view: ViewState;
  sent: Partial<ViewState>;
  untilMs: number;
}

/**
 * The move for a key pressed at `nowMs`. While the last key's move is still flying, the camera
 * has not got there, so the next press is taken from where it is going, not from where it is:
 * three quick presses of + went from 20,000 km to 10,000, not to 2,500 (walk on the laptop,
 * 2026-10-05). A held key's repeats are not chained — thirty a second would run the target a
 * whole zoom or a pole away within a second — but each moves on from the camera, as before.
 * What is sent carries the fields of the flight it replaces, so a zoom still in the air is not
 * left halfway by a turn that follows it. A flight the camera has left (dragged, wheeled or
 * flown somewhere else meanwhile) is not followed: map-host forgets it on a press or the wheel.
 */
export function chainedKeyView(
  current: ViewState,
  flying: KeyFlight | undefined,
  nowMs: number,
  k: MapKey,
): { send: Partial<ViewState>; flight: KeyFlight } | null {
  const inFlight = flying !== undefined && nowMs < flying.untilMs;
  const base = inFlight && !k.repeat ? flying.view : current;
  const next = globeKeyView(base, k);
  if (!next) return null;
  const send = inFlight ? { ...flying.sent, ...next } : next;
  return { send, flight: { view: { ...base, ...send }, sent: send, untilMs: nowMs + KEY_FLIGHT_MS + 50 } };
}
