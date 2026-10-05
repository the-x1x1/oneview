import { subsolarPoint } from '@worldview/world-model';
import type { GpElements } from './elements.js';
import type { Propagator } from './propagator.js';

/**
 * A satellite's next passes over a point on the ground: when it rises above a minimum
 * elevation, when it is highest and when it sets again, with the compass directions it
 * rises and sets in. For the selected satellite over the view centre (the provider's
 * `objectDetails`).
 *
 * Positions are SGP4 from the element set the object carries, through the same propagator
 * that places the satellite on the map; this module only turns them into look angles and
 * finds the crossings. So the answer is exactly as good as the element set: a few seconds
 * for a fresh one, drifting by minutes as it ages — which is why the panel shows the epoch.
 *
 * Method: sample the elevation every `stepMs` (20 s for low orbits, whose passes above 10°
 * last a few minutes; a minute for higher ones), bisect each crossing of the threshold to a
 * second, and golden-section search between rise and set for the highest point. A pass so
 * brief and low that it rises and sets between two samples (a few seconds just above the
 * threshold) shows as a local peak within two degrees below it at the samples; the
 * elevation between those samples is searched for its highest point, and the pass is kept
 * when that is above the threshold.
 */
export interface LookAngles {
  /** Degrees above the horizon (negative below). */
  elevationDeg: number;
  /** Degrees clockwise from true north. */
  azimuthDeg: number;
  rangeKm: number;
}

export interface Observer {
  latitude: number;
  longitude: number;
  /** Height above the ellipsoid, metres (default 0). */
  altitudeM?: number;
}

export interface SatellitePass {
  /** Undefined when the satellite was already above the threshold at the start (in view now). */
  riseAt?: number;
  riseAzimuthDeg?: number;
  culminationAt: number;
  culminationAzimuthDeg: number;
  maxElevationDeg: number;
  /** Undefined when the search window ended before it set. */
  setAt?: number;
  setAzimuthDeg?: number;
  /**
   * The part of the pass that can be seen with the eye (passVisibility): the satellite in
   * sunlight while the sky at the observer is dark. Undefined when none of it can.
   */
  visibleFrom?: number;
  visibleUntil?: number;
}

export interface PassSearch {
  passes: SatellitePass[];
  /** Above the threshold for the whole window (a geostationary satellite in view). */
  alwaysAbove: boolean;
  /** Where the search ended: the window's end, or where propagation stopped (decay). */
  searchedUntil: number;
}

export interface PassOptions {
  /** Default 10°. */
  minElevationDeg?: number;
  /** Default 3. */
  count?: number;
  /** How far ahead to look (default 3 days; 7 for orbits slower than 225 minutes). */
  horizonMs?: number;
  /** Sampling step (default 20 s below a 225-minute period, else 60 s). */
  stepMs?: number;
}

const DEG = Math.PI / 180;
/** How far below the threshold a sampled local peak is still searched between samples. */
const GRAZE_MARGIN_DEG = 2;
// WGS84 — the ellipsoid satellite.js's eciToGeodetic uses for the latitude/height it returns.
const A_KM = 6378.137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

/** Geodetic (degrees, metres) → Earth-centred Earth-fixed, km. */
export function geodeticToEcef(latDeg: number, lonDeg: number, altM: number): [number, number, number] {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const n = A_KM / Math.sqrt(1 - E2 * sinLat * sinLat);
  const h = altM / 1000;
  return [
    (n + h) * Math.cos(lat) * Math.cos(lon),
    (n + h) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - E2) + h) * sinLat,
  ];
}

/** Elevation, azimuth and range of a point (geodetic) seen from an observer on the ellipsoid. */
export function lookAngles(
  observer: Observer,
  target: { latitude: number; longitude: number; altitudeM: number },
): LookAngles {
  const o = geodeticToEcef(observer.latitude, observer.longitude, observer.altitudeM ?? 0);
  const t = geodeticToEcef(target.latitude, target.longitude, target.altitudeM);
  const r = [t[0] - o[0], t[1] - o[1], t[2] - o[2]] as const;
  const lat = observer.latitude * DEG;
  const lon = observer.longitude * DEG;
  const sinLat = Math.sin(lat),
    cosLat = Math.cos(lat),
    sinLon = Math.sin(lon),
    cosLon = Math.cos(lon);
  const east = -sinLon * r[0] + cosLon * r[1];
  const north = -sinLat * cosLon * r[0] - sinLat * sinLon * r[1] + cosLat * r[2];
  const up = cosLat * cosLon * r[0] + cosLat * sinLon * r[1] + sinLat * r[2];
  const rangeKm = Math.hypot(r[0], r[1], r[2]);
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, up / rangeKm))) / DEG;
  const azimuthDeg = (((Math.atan2(east, north) / DEG) % 360) + 360) % 360;
  return { elevationDeg, azimuthDeg, rangeKm };
}

/** The satellite's look angles from `observer` at `atMs`, or undefined where SGP4 gives no position. */
export function lookAnglesAt(
  propagator: Propagator,
  elements: GpElements,
  observer: Observer,
  atMs: number,
): LookAngles | undefined {
  let state;
  try {
    state = propagator.propagate(elements, atMs);
  } catch {
    return undefined;
  }
  if (!state || ![state.latitude, state.longitude, state.altitudeM].every(Number.isFinite)) return undefined;
  return lookAngles(observer, state);
}

export function nextPasses(
  propagator: Propagator,
  elements: GpElements,
  observer: Observer,
  startMs: number,
  options: PassOptions = {},
): PassSearch {
  const min = options.minElevationDeg ?? 10;
  const count = options.count ?? 3;
  const periodMin = 1440 / elements.meanMotion;
  const low = periodMin < 225;
  const horizonMs = options.horizonMs ?? (low ? 3 : 7) * 86_400_000;
  const stepMs = options.stepMs ?? (low ? 20_000 : 60_000);
  const endMs = startMs + horizonMs;
  const at = (t: number) => lookAnglesAt(propagator, elements, observer, t);

  const passes: SatellitePass[] = [];
  let prevT = startMs;
  let prev = at(startMs);
  // The sample before `prev`, for a pass that peaks between two samples below the threshold.
  let prev2: { t: number; el: number } | undefined;
  if (!prev) return { passes, alwaysAbove: false, searchedUntil: startMs };
  let current: { riseAt?: number; riseAz?: number; bestT: number; bestEl: number } | undefined =
    prev.elevationDeg >= min ? { bestT: startMs, bestEl: prev.elevationDeg } : undefined;
  const startedAbove = current !== undefined;
  let everBelow = !startedAbove;

  for (let t = startMs + stepMs; t <= endMs && passes.length < count; t += stepMs) {
    const now = at(t);
    if (!now) return finish(prevT);
    const wasAbove = prev!.elevationDeg >= min;
    const isAbove = now.elevationDeg >= min;
    if (!isAbove) everBelow = true;
    if (!wasAbove && isAbove) {
      const riseAt = crossing(at, prevT, t, min, true);
      current = { riseAt, riseAz: at(riseAt)?.azimuthDeg ?? now.azimuthDeg, bestT: t, bestEl: now.elevationDeg };
    } else if (wasAbove && isAbove && current && now.elevationDeg > current.bestEl) {
      current.bestT = t;
      current.bestEl = now.elevationDeg;
    } else if (wasAbove && !isAbove && current) {
      const setAt = crossing(at, prevT, t, min, false);
      passes.push(complete(current, setAt, at(setAt)?.azimuthDeg ?? now.azimuthDeg, stepMs));
      current = undefined;
    } else if (
      !wasAbove &&
      !isAbove &&
      prev2 &&
      prev!.elevationDeg > prev2.el &&
      prev!.elevationDeg >= now.elevationDeg &&
      prev!.elevationDeg > min - GRAZE_MARGIN_DEG
    ) {
      // A peak just below the threshold at the samples may be above it between them: a pass
      // of a few seconds, which sampling alone missed.
      const peakT = goldenMax(at, prev2.t, t, prevT);
      const peak = at(peakT);
      if (peak && peak.elevationDeg >= min) {
        const riseAt = crossing(at, prev2.t, peakT, min, true);
        const setAt = crossing(at, peakT, t, min, false);
        const graze = {
          riseAt,
          riseAz: at(riseAt)?.azimuthDeg ?? peak.azimuthDeg,
          bestT: peakT,
          bestEl: peak.elevationDeg,
        };
        passes.push(complete(graze, setAt, at(setAt)?.azimuthDeg ?? now.azimuthDeg, stepMs));
      }
    }
    prev2 = { t: prevT, el: prev!.elevationDeg };
    prev = now;
    prevT = t;
  }
  return finish(Math.min(prevT, endMs));

  function finish(until: number): PassSearch {
    if (startedAbove && !everBelow) return { passes: [], alwaysAbove: true, searchedUntil: until };
    if (current && passes.length < count) passes.push(complete(current, undefined, undefined, stepMs));
    return { passes, alwaysAbove: false, searchedUntil: until };
  }

  function complete(
    c: { riseAt?: number; riseAz?: number; bestT: number; bestEl: number },
    setAt: number | undefined,
    setAz: number | undefined,
    step: number,
  ): SatellitePass {
    const lo = Math.max(c.riseAt ?? startMs, c.bestT - step);
    const hi = Math.min(setAt ?? endMs, c.bestT + step);
    const peakT = goldenMax(at, lo, hi, c.bestT);
    const peak = at(peakT);
    const pass: SatellitePass = {
      culminationAt: peakT,
      culminationAzimuthDeg: round(peak?.azimuthDeg ?? 0, 1),
      maxElevationDeg: round(Math.max(peak?.elevationDeg ?? c.bestEl, c.bestEl), 1),
    };
    if (c.riseAt !== undefined) {
      pass.riseAt = c.riseAt;
      pass.riseAzimuthDeg = round(c.riseAz ?? 0, 1);
    }
    if (setAt !== undefined) {
      pass.setAt = setAt;
      pass.setAzimuthDeg = round(setAz ?? 0, 1);
    }
    // A pass still up when the window ends is looked at for its first twelve hours at most.
    const from = c.riseAt ?? startMs;
    const seen = passVisibility(
      propagator,
      elements,
      observer,
      from,
      Math.min(setAt ?? endMs, from + 12 * 3_600_000),
      min,
    );
    if (seen) {
      pass.visibleFrom = seen.from;
      pass.visibleUntil = seen.until;
    }
    return pass;
  }
}

/** The whole second at which elevation crosses `min` between `lo` (one side) and `hi` (the other). */
function crossing(
  at: (t: number) => LookAngles | undefined,
  lo: number,
  hi: number,
  min: number,
  rising: boolean,
): number {
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    const el = at(mid)?.elevationDeg ?? -90;
    if (el >= min === rising) hi = mid;
    else lo = mid;
  }
  // The first whole second on the far side: at or above for a rise, below for a set.
  return Math.ceil(hi / 1000) * 1000;
}

/** Time of the highest elevation in [lo, hi] (one peak), to the second; `fallback` if nothing better. */
function goldenMax(at: (t: number) => LookAngles | undefined, lo: number, hi: number, fallback: number): number {
  const g = (Math.sqrt(5) - 1) / 2;
  const el = (t: number) => at(t)?.elevationDeg ?? -90;
  let a = lo,
    b = hi;
  let c = b - g * (b - a),
    d = a + g * (b - a);
  let fc = el(c),
    fd = el(d);
  while (b - a > 1000) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = el(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = el(d);
    }
  }
  const best = Math.round((a + b) / 2000) * 1000;
  return el(best) >= el(fallback) ? best : fallback;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---- visibility -----------------------------------------------------------------------

/**
 * The Sun this far below the horizon or more counts as a dark enough sky to see a sunlit
 * satellite: the end of civil twilight, the line Heavens-Above and NASA's Spot the Station
 * use for a naked-eye pass.
 */
export const DARK_SKY_SUN_DEG = -6;
/** The Earth's shadow is taken as a cylinder of the mean radius behind it (no penumbra). */
const SHADOW_RADIUS_KM = 6371;
const VISIBILITY_STEP_MS = 10_000;

/** Unit vector to the Sun, Earth-fixed (the Sun taken as infinitely far). */
export function sunDirectionEcef(atMs: number): [number, number, number] {
  const sun = subsolarPoint(atMs);
  const lat = sun.latitude * DEG,
    lon = sun.longitude * DEG;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

/** Whether a point (Earth-fixed, km) is in sunlight: not inside the Earth's shadow cylinder. */
export function isSunlit(p: readonly [number, number, number], sun: readonly [number, number, number]): boolean {
  const along = p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2];
  if (along >= 0) return true;
  const off = Math.hypot(p[0] - along * sun[0], p[1] - along * sun[1], p[2] - along * sun[2]);
  return off > SHADOW_RADIUS_KM;
}

/** The Sun's elevation at the observer, degrees (geometric, on the ellipsoid normal). */
export function sunElevationAt(observer: Observer, sun: readonly [number, number, number]): number {
  const lat = observer.latitude * DEG,
    lon = observer.longitude * DEG;
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  return Math.asin(Math.max(-1, Math.min(1, up[0]! * sun[0] + up[1]! * sun[1] + up[2]! * sun[2]))) / DEG;
}

/**
 * The part of a pass that can be seen with the eye: the satellite above the pass threshold,
 * in sunlight, while the Sun is DARK_SKY_SUN_DEG or more below the observer's horizon.
 * Sampled every ten seconds from rise to set, so the ends are good to ten seconds. It says
 * nothing about cloud, the Moon or how bright the satellite is.
 */
export function passVisibility(
  propagator: Propagator,
  elements: GpElements,
  observer: Observer,
  fromMs: number,
  untilMs: number,
  minElevationDeg: number,
): { from: number; until: number } | undefined {
  let from: number | undefined;
  let until: number | undefined;
  for (let t = fromMs; t <= untilMs; t += VISIBILITY_STEP_MS) {
    const sun = sunDirectionEcef(t);
    if (sunElevationAt(observer, sun) > DARK_SKY_SUN_DEG) continue;
    let state;
    try {
      state = propagator.propagate(elements, t);
    } catch {
      continue;
    }
    if (!state || ![state.latitude, state.longitude, state.altitudeM].every(Number.isFinite)) continue;
    if (lookAngles(observer, state).elevationDeg < minElevationDeg) continue;
    if (!isSunlit(geodeticToEcef(state.latitude, state.longitude, state.altitudeM), sun)) continue;
    from ??= t;
    until = t;
  }
  return from !== undefined && until !== undefined ? { from, until } : undefined;
}
