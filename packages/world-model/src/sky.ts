import { solarEcliptic, subsolarPoint, wrap180Deg } from './sun.js';

/**
 * The Sun and the Moon as seen from a place: how high each stands and in which direction,
 * when each next rises and sets (and when civil twilight begins and ends), and how much of the
 * Moon is lit. Computed here, offline, from the time alone.
 *
 * The Sun is sun.ts's (the Astronomical Almanac's low-precision solar position, about 0.01°).
 * The Moon is the Almanac's low-precision lunar series (six terms in longitude, four in
 * latitude and in parallax; about 0.3° and 0.2°). Rising and setting are found by stepping
 * the altitude through the day and refining each crossing to a second: the Sun's upper limb at
 * the horizon with refraction (−0.833°), the Moon's with its parallax as well (Meeus,
 * *Astronomical Algorithms*, ch. 15: 0.7275 π − 0.5667°). Against Astronomy Engine (D. Cross),
 * sunrise, sunset and twilight come within 10 s and the Moon's rising and setting within
 * 2.5 min between the polar circles; beyond them, where both cross the horizon at a slant,
 * within 2 and 15 min (sky.test.ts says how this was checked). A Moon that only grazes the
 * horizon may be missed.
 */

const DEG = Math.PI / 180;

export interface SkyPosition {
  /** Degrees above the horizon (negative below it), as seen from the place. */
  altitudeDeg: number;
  /** Degrees clockwise from true north. */
  azimuthDeg: number;
}

interface Subpoint {
  /** Declination, degrees. */
  latitude: number;
  /** Where the body is on the meridian, degrees. */
  longitude: number;
}

/** Altitude and azimuth of a body whose sub-point (declination, Greenwich hour angle) is `sub`. */
function altAz(sub: Subpoint, place: { latitude: number; longitude: number }): SkyPosition {
  const φ = place.latitude * DEG;
  const δ = sub.latitude * DEG;
  const h = wrap180Deg(place.longitude - sub.longitude) * DEG;
  const altitude = Math.asin(Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos(h));
  const azimuth = Math.atan2(-Math.sin(h), Math.tan(δ) * Math.cos(φ) - Math.sin(φ) * Math.cos(h));
  return { altitudeDeg: altitude / DEG, azimuthDeg: (((azimuth / DEG) % 360) + 360) % 360 };
}

/** Where the Sun is from `place` at `ms` (no refraction). */
export function sunPosition(ms: number, place: { latitude: number; longitude: number }): SkyPosition {
  return altAz(subsolarPoint(ms), place);
}

interface MoonState {
  /** Ecliptic longitude and latitude, radians. */
  lambda: number;
  beta: number;
  /** Horizontal parallax, degrees. */
  parallaxDeg: number;
  sub: Subpoint;
}

/** The Moon by the Almanac's low-precision series, as of `ms`. */
function moonState(ms: number): MoonState {
  const t = (ms / 86_400_000 + 2_440_587.5 - 2_451_545.0) / 36_525;
  const s = (a: number, b: number) => Math.sin((a + b * t) * DEG);
  const c = (a: number, b: number) => Math.cos((a + b * t) * DEG);
  const lambdaDeg =
    218.32 +
    481_267.881 * t +
    6.29 * s(135.0, 477_198.87) -
    1.27 * s(259.3, -413_335.36) +
    0.66 * s(235.7, 890_534.22) +
    0.21 * s(269.9, 954_397.74) -
    0.19 * s(357.5, 35_999.05) -
    0.11 * s(186.5, 966_404.03);
  const betaDeg =
    5.13 * s(93.3, 483_202.02) + 0.28 * s(228.2, 960_400.89) - 0.28 * s(318.3, 6_003.15) - 0.17 * s(217.6, -407_332.21);
  const parallaxDeg =
    0.9508 +
    0.0518 * c(135.0, 477_198.87) +
    0.0095 * c(259.3, -413_335.36) +
    0.0078 * c(235.7, 890_534.22) +
    0.0028 * c(269.9, 954_397.74);
  const lambda = lambdaDeg * DEG;
  const beta = betaDeg * DEG;
  const { epsilon, gmstDeg } = solarEcliptic(ms);
  const x = Math.cos(beta) * Math.cos(lambda);
  const y = Math.cos(epsilon) * Math.cos(beta) * Math.sin(lambda) - Math.sin(epsilon) * Math.sin(beta);
  const z = Math.sin(epsilon) * Math.cos(beta) * Math.sin(lambda) + Math.cos(epsilon) * Math.sin(beta);
  const ra = Math.atan2(y, x) / DEG;
  const dec = Math.asin(z) / DEG;
  return { lambda, beta, parallaxDeg, sub: { latitude: dec, longitude: wrap180Deg(ra - gmstDeg) } };
}

/** The point on the Earth with the Moon directly overhead at `ms` (as seen from the Earth's centre). */
export function sublunarPoint(ms: number): { latitude: number; longitude: number } {
  return { ...moonState(ms).sub };
}

/** Where the Moon is from `place` at `ms`: seen from the surface (its parallax taken off), no refraction. */
export function moonPosition(ms: number, place: { latitude: number; longitude: number }): SkyPosition {
  const m = moonState(ms);
  const geo = altAz(m.sub, place);
  return {
    altitudeDeg: geo.altitudeDeg - m.parallaxDeg * Math.cos(geo.altitudeDeg * DEG),
    azimuthDeg: geo.azimuthDeg,
  };
}

export type MoonPhaseName =
  | 'new moon'
  | 'waxing crescent'
  | 'first quarter'
  | 'waxing gibbous'
  | 'full moon'
  | 'waning gibbous'
  | 'last quarter'
  | 'waning crescent';

export interface MoonIllumination {
  /** The lit fraction of the disc, 0–1. */
  fraction: number;
  waxing: boolean;
  /** The Moon's longitude east of the Sun, degrees [0, 360): 0 new, 90 first quarter, 180 full. */
  elongationDeg: number;
  phase: MoonPhaseName;
}

/** How much of the Moon is lit at `ms`, and its phase. */
export function moonIllumination(ms: number): MoonIllumination {
  const m = moonState(ms);
  const sun = solarEcliptic(ms).lambda;
  const elongationDeg = ((((m.lambda - sun) / DEG) % 360) + 360) % 360;
  // The angle Sun–Moon seen from the Earth; the phase angle is nearly its supplement.
  const psi = Math.acos(Math.cos(m.beta) * Math.cos(m.lambda - sun));
  const fraction = (1 - Math.cos(psi)) / 2;
  const phases: MoonPhaseName[] = [
    'new moon',
    'waxing crescent',
    'first quarter',
    'waxing gibbous',
    'full moon',
    'waning gibbous',
    'last quarter',
    'waning crescent',
  ];
  // The four principal phases take the 22.5° either side of them; the rest is between.
  const phase = phases[Math.floor(((elongationDeg + 22.5) % 360) / 45)]!;
  return { fraction, waxing: elongationDeg < 180, elongationDeg, phase };
}

export type SkyEventKind = 'rise' | 'set' | 'dawn' | 'dusk';

export interface SkyEvent {
  kind: SkyEventKind;
  at: number;
}

const SUN_HORIZON_DEG = -0.8333;
const CIVIL_TWILIGHT_DEG = -6;
const STEP_MS = 10 * 60_000;

/** Times in [fromMs, toMs] where f crosses zero, up (rise) or down (set), each to about a second. */
function crossings(f: (ms: number) => number, fromMs: number, toMs: number): Array<{ up: boolean; at: number }> {
  const out: Array<{ up: boolean; at: number }> = [];
  let t0 = fromMs;
  let v0 = f(t0);
  while (t0 < toMs) {
    const t1 = Math.min(toMs, t0 + STEP_MS);
    const v1 = f(t1);
    if ((v0 < 0 && v1 >= 0) || (v0 >= 0 && v1 < 0)) {
      let a = t0;
      let b = t1;
      let va = v0;
      while (b - a > 1000) {
        const mid = (a + b) / 2;
        const vm = f(mid);
        if ((va < 0 && vm < 0) || (va >= 0 && vm >= 0)) {
          a = mid;
          va = vm;
        } else b = mid;
      }
      out.push({ up: v1 >= 0, at: Math.round((a + b) / 2) });
    }
    t0 = t1;
    v0 = v1;
  }
  return out;
}

/**
 * The Sun's rising and setting, and the start and end of civil twilight (dawn, dusk: the Sun
 * 6° below the horizon), from `place` between `fromMs` and `fromMs + hours`, in time order.
 * None of a kind means the Sun stayed up, or down, through it (polar day or night).
 */
export function sunEvents(fromMs: number, place: { latitude: number; longitude: number }, hours = 48): SkyEvent[] {
  const to = fromMs + hours * 3_600_000;
  const alt = (ms: number) => sunPosition(ms, place).altitudeDeg;
  const out: SkyEvent[] = [];
  for (const c of crossings((ms) => alt(ms) - SUN_HORIZON_DEG, fromMs, to))
    out.push({ kind: c.up ? 'rise' : 'set', at: c.at });
  for (const c of crossings((ms) => alt(ms) - CIVIL_TWILIGHT_DEG, fromMs, to))
    out.push({ kind: c.up ? 'dawn' : 'dusk', at: c.at });
  return out.sort((a, b) => a.at - b.at);
}

/** The Moon's rising and setting from `place` between `fromMs` and `fromMs + hours`, in time order. */
export function moonEvents(fromMs: number, place: { latitude: number; longitude: number }, hours = 48): SkyEvent[] {
  const to = fromMs + hours * 3_600_000;
  // The geocentric altitude at which the Moon's upper limb touches the horizon (Meeus 15.1).
  const f = (ms: number) => {
    const m = moonState(ms);
    return altAz(m.sub, place).altitudeDeg - (0.7275 * m.parallaxDeg - 0.5667);
  };
  return crossings(f, fromMs, to).map((c) => ({ kind: c.up ? 'rise' : 'set', at: c.at }));
}
