import {
  EARTH_RADIUS_M,
  lookAngles,
  subsolarPoint,
  sunPosition,
  toEcef,
  type GeoPosition,
  type WorldObject,
} from '@worldview/world-model';
import type { SkyOverheadAnswer, SkySatellite } from '@worldview/ipc-contract';

/**
 * The satellites above a place's horizon now (`sky.overhead`): each one's elevation, bearing
 * and range from the place, and whether the Sun lights it. Worked out here from the positions
 * the satellite source last propagated — carried to now along the chord to its next
 * propagated position, as the globe moves the markers (render-core motion.ts) — so a low
 * orbit's look angles are not half a minute behind. Nothing is looked up.
 *
 * "Sunlit" is a cylindrical shadow: the satellite is in the Earth's shadow when it is on the
 * night side of the Earth's centre and within an Earth radius of the line through the Sun.
 * It ignores the penumbra (a few seconds of a low orbit's pass), which is all a "can it be
 * seen" answer needs.
 */
export const SKY_LIMIT_DEFAULT = 200;
/** How far past its next propagated position a satellite is carried (spans), as the globe does. */
const MAX_SPANS = 2;
/** The longest span between two propagations that is carried along (render-core satelliteMotion's cap). */
const MAX_SPAN_MS = 120_000;
/** A satellite last propagated longer ago than this is not "now": it is left out. */
export const SKY_STALE_MS = 10 * 60_000;
/** Civil dusk is over: the Sun 6° or more below the horizon. */
export const SKY_DARK_SUN_DEG = -6;
/** Lower than this a satellite is lost in haze and buildings, sunlit or not. */
export const SKY_EYE_MIN_ELEVATION_DEG = 10;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Where a satellite is at `nowMs`: its position carried along the chord to `nextPosition`, or
 * as propagated when it says nothing more; undefined when it was propagated too long ago to be
 * "now" (or says not when).
 */
export function satelliteNow(o: WorldObject, nowMs: number): GeoPosition | undefined {
  const p = o.position;
  if (!p || p.altitudeM === undefined) return undefined;
  const from = Date.parse(String(o.properties['propagatedAt'] ?? ''));
  // Without its propagation time the position is taken as it is: `observedAt` is the element
  // set's epoch, hours before.
  if (!Number.isFinite(from)) return p;
  if (Math.abs(nowMs - from) > SKY_STALE_MS) return undefined;
  const next = o.properties['nextPosition'];
  if (!Array.isArray(next) || next.length < 4) return p;
  const [lat, lon, alt, at] = next.map(num);
  if (lat === undefined || lon === undefined || alt === undefined || at === undefined) return p;
  if (!(at > from) || at - from > MAX_SPAN_MS || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !(alt > 0)) return p;
  const t = Math.max(0, Math.min(MAX_SPANS, (nowMs - from) / (at - from)));
  if (t === 0) return p;
  const a = toEcef(p);
  const b = toEcef({ latitude: lat, longitude: lon, altitudeM: alt });
  const x = a[0] + (b[0] - a[0]) * t;
  const y = a[1] + (b[1] - a[1]) * t;
  const z = a[2] + (b[2] - a[2]) * t;
  return fromEcef(x, y, z);
}

const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);

/**
 * Geodetic latitude, longitude and height (WGS84) of an ECEF point: Bowring's formula, then two
 * turns of the usual iteration — to millimetres from the ground to geostationary orbit.
 */
export function fromEcef(x: number, y: number, z: number): GeoPosition {
  const p = Math.hypot(x, y);
  const θ = Math.atan2(z * WGS84_A, p * WGS84_B);
  let φ = Math.atan2(z + WGS84_EP2 * WGS84_B * Math.sin(θ) ** 3, p - WGS84_E2 * WGS84_A * Math.cos(θ) ** 3);
  let n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(φ) ** 2);
  let h = Math.abs(Math.cos(φ)) > 1e-9 ? p / Math.cos(φ) - n : Math.abs(z) - WGS84_B;
  for (let i = 0; i < 2 && p > 1e-3; i++) {
    φ = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + h)));
    n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(φ) ** 2);
    h = Math.abs(Math.cos(φ)) > 1e-9 ? p / Math.cos(φ) - n : Math.abs(z) - WGS84_B;
  }
  return { latitude: (φ * 180) / Math.PI, longitude: (Math.atan2(y, x) * 180) / Math.PI, altitudeM: h };
}

/** Whether a point (ECEF) is lit by the Sun, whose direction is the unit vector `sun`. */
export function sunlit(point: readonly [number, number, number], sun: readonly [number, number, number]): boolean {
  const along = point[0] * sun[0] + point[1] * sun[1] + point[2] * sun[2];
  if (along >= 0) return true;
  const px = point[0] - along * sun[0];
  const py = point[1] - along * sun[1];
  const pz = point[2] - along * sun[2];
  return Math.hypot(px, py, pz) > EARTH_RADIUS_M;
}

/** The unit vector from the Earth's centre to the Sun at `nowMs` (ECEF). */
function sunDirection(nowMs: number): [number, number, number] {
  const s = subsolarPoint(nowMs);
  const φ = (s.latitude * Math.PI) / 180;
  const λ = (s.longitude * Math.PI) / 180;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}

export interface SkyOptions {
  minElevationDeg?: number;
  limit?: number;
  /** Categories left out (`satelliteCategory`), before anything is counted or cut. */
  excludeCategories?: readonly string[];
  /** Only those that could be seen with the eye (sunlit, 10° up or more, the sky dark). */
  visibleOnly?: boolean;
}

/** The ground angle (radians) from below a satellite at `altitudeM` to where it sets, plus a margin. */
function horizonAngle(altitudeM: number): number {
  return Math.acos(Math.min(1, EARTH_RADIUS_M / (EARTH_RADIUS_M + Math.max(0, altitudeM))));
}

/**
 * Carried at most two spans (four minutes of a low orbit, about 15° of its track) from where it
 * was propagated: a satellite further than this past the observer's horizon cannot be above it.
 */
const PREFILTER_MARGIN_RAD = (16 * Math.PI) / 180;

export function skyOverhead(
  objects: Iterable<WorldObject>,
  observer: GeoPosition,
  nowMs: number,
  opts: SkyOptions = {},
): SkyOverheadAnswer {
  const min = opts.minElevationDeg ?? 0;
  const limit = opts.limit ?? SKY_LIMIT_DEFAULT;
  const excluded = new Set(opts.excludeCategories ?? []);
  const sun = sunDirection(nowMs);
  const sunElevationDeg = Math.round(sunPosition(nowMs, observer).altitudeDeg * 10) / 10;
  const dark = sunElevationDeg <= SKY_DARK_SUN_DEG;
  const φo = (observer.latitude * Math.PI) / 180;
  const sinφo = Math.sin(φo);
  const cosφo = Math.cos(φo);
  const above: SkySatellite[] = [];
  let total = 0;
  let visible = 0;
  for (const o of objects) {
    if (o.type !== 'satellite' || !o.position) continue;
    const category = o.properties['satelliteCategory'];
    if (typeof category === 'string' && excluded.has(category)) continue;
    // Cheap first: the ground angle to the point beneath it (most of the catalogue is over the
    // other side of the Earth), before carrying it to now and working out where it is in the sky.
    const raw = o.position;
    const φ = (raw.latitude * Math.PI) / 180;
    const Δλ = ((raw.longitude - observer.longitude) * Math.PI) / 180;
    const cosc = sinφo * Math.sin(φ) + cosφo * Math.cos(φ) * Math.cos(Δλ);
    if (Math.acos(Math.max(-1, Math.min(1, cosc))) > horizonAngle(raw.altitudeM ?? 0) + PREFILTER_MARGIN_RAD) continue;
    const p = satelliteNow(o, nowMs);
    if (!p) continue;
    const look = lookAngles(observer, p);
    if (!(look.elevationDeg >= min)) continue;
    total++;
    const lit = sunlit(toEcef(p), sun);
    const eye = lit && dark && look.elevationDeg >= SKY_EYE_MIN_ELEVATION_DEG;
    if (eye) visible++;
    if (opts.visibleOnly && !eye) continue;
    const name = o.labels['name'] ?? (typeof o.properties['name'] === 'string' ? o.properties['name'] : o.id);
    above.push({
      id: o.id,
      name,
      ...(typeof category === 'string' ? { category } : {}),
      azimuthDeg: Math.round(look.azimuthDeg * 10) / 10,
      elevationDeg: Math.round(look.elevationDeg * 10) / 10,
      rangeM: Math.round(look.rangeM),
      altitudeM: Math.round(p.altitudeM ?? 0),
      sunlit: lit,
    });
  }
  above.sort((a, b) => b.elevationDeg - a.elevationDeg || (a.id < b.id ? -1 : 1));
  return {
    at: new Date(nowMs).toISOString(),
    observer: { latitude: observer.latitude, longitude: observer.longitude },
    total,
    visible,
    sunElevationDeg,
    satellites: above.slice(0, limit),
  };
}
