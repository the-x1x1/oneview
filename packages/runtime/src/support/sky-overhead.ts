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
/**
 * A satellite whose position, carried as far as it goes, is still further behind now than
 * this is not "now" (its source has stopped propagating: a provider backing off, a computer
 * waking up): it is left out and counted as `stale`, not drawn where it was minutes ago.
 */
export const SKY_BEHIND_MS = 60_000;
/** Civil dusk is over: the Sun 6° or more below the horizon. */
export const SKY_DARK_SUN_DEG = -6;
/** Lower than this a satellite is lost in haze and buildings, sunlit or not. */
export const SKY_EYE_MIN_ELEVATION_DEG = 10;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** How a satellite is carried to now: the share `t` of the span to its next position, and how far behind now it ends. */
interface Carry {
  /** 0: not carried (no next position, or not yet past its propagation). */
  t: number;
  spanMs: number;
  next?: GeoPosition;
  behindMs: number;
}

/** One poll propagates the whole catalogue to the same moment: its time is parsed once. */
let parsedText = '';
let parsedMs = NaN;
function propagatedMs(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  if (v !== parsedText) {
    parsedText = v;
    parsedMs = Date.parse(v);
  }
  return parsedMs;
}

function carryOf(o: WorldObject, nowMs: number): Carry {
  const from = propagatedMs(o.properties['propagatedAt']);
  // Without its propagation time the position is taken as it is: `observedAt` is the element
  // set's epoch, hours before.
  if (!Number.isFinite(from)) return { t: 0, spanMs: 0, behindMs: 0 };
  const behind = Math.max(0, nowMs - from);
  const raw = o.properties['nextPosition'];
  if (!Array.isArray(raw) || raw.length < 4) return { t: 0, spanMs: 0, behindMs: behind };
  const lat = num(raw[0]);
  const lon = num(raw[1]);
  const alt = num(raw[2]);
  const at = num(raw[3]);
  if (lat === undefined || lon === undefined || alt === undefined || at === undefined)
    return { t: 0, spanMs: 0, behindMs: behind };
  if (!(at > from) || at - from > MAX_SPAN_MS || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !(alt > 0))
    return { t: 0, spanMs: 0, behindMs: behind };
  const spanMs = at - from;
  const t = Math.max(0, Math.min(MAX_SPANS, (nowMs - from) / spanMs));
  return {
    t,
    spanMs,
    next: { latitude: lat, longitude: lon, altitudeM: alt },
    behindMs: Math.max(0, nowMs - (from + t * spanMs)),
  };
}

/**
 * Where a satellite is at `nowMs`: its position carried along the chord to `nextPosition` (at
 * most two spans), or as propagated when it says nothing more; undefined when even carried it
 * is more than `SKY_BEHIND_MS` behind now.
 */
export function satelliteNow(o: WorldObject, nowMs: number): GeoPosition | undefined {
  const p = o.position;
  if (!p || p.altitudeM === undefined) return undefined;
  const c = carryOf(o, nowMs);
  if (c.behindMs > SKY_BEHIND_MS) return undefined;
  return carried(p, c);
}

function carried(p: GeoPosition, c: Carry): GeoPosition {
  if (c.t === 0 || !c.next) return p;
  const a = toEcef(p);
  const b = toEcef(c.next);
  const x = a[0] + (b[0] - a[0]) * c.t;
  const y = a[1] + (b[1] - a[1]) * c.t;
  const z = a[2] + (b[2] - a[2]) * c.t;
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

/**
 * The fastest a satellite's point beneath it moves round the Earth's centre: escape speed at
 * 150 km up is 0.097° a second, and the Earth turns 0.004° a second under it.
 */
const MAX_GROUND_RATE_DEG_S = 0.11;
/** What the spherical Earth of the cheap test can be off by against the ellipsoid, and then some. */
const PREFILTER_SLACK_RAD = (1 * Math.PI) / 180;
const SPHERE_R = 6_371_008.8;

/**
 * The furthest ground angle (radians, at the Earth's centre) from an observer at which a body
 * `altitudeM` up stands `elevationDeg` (≤ 0) above the horizon.
 */
function reachAngle(altitudeM: number, elevationDeg: number): number {
  const e = (Math.min(0, elevationDeg) * Math.PI) / 180;
  return Math.acos(Math.min(1, (SPHERE_R * Math.cos(e)) / (SPHERE_R + Math.max(0, altitudeM)))) - e;
}

/**
 * Whether a satellite can be put aside before it is carried to now and worked out: its point
 * beneath it, as propagated, is further from the observer than it can have moved in the time
 * it is carried, plus how far it can be seen from at the height the carrying can take it to
 * (past its next position the chord climbs off the orbit: 2½ % higher after two two-minute
 * spans of a low orbit).
 */
function beyondReach(groundAngleRad: number, altitudeM: number, c: Carry, minElevationDeg: number): boolean {
  let moved = 0;
  let top = Math.max(altitudeM, c.next?.altitudeM ?? 0);
  if (c.t > 0) {
    const α = ((MAX_GROUND_RATE_DEG_S * c.spanMs) / 1000) * (Math.PI / 180);
    moved = α * Math.max(1, c.t);
    if (c.t > 1) top = (SPHERE_R + top) * Math.sqrt(1 + 2 * c.t * (c.t - 1) * (1 - Math.cos(α))) - SPHERE_R;
  }
  return groundAngleRad > reachAngle(top, minElevationDeg) + moved + PREFILTER_SLACK_RAD;
}

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
  let stale = 0;
  for (const o of objects) {
    if (o.type !== 'satellite' || !o.position || o.position.altitudeM === undefined) continue;
    const category = o.properties['satelliteCategory'];
    if (typeof category === 'string' && excluded.has(category)) continue;
    // Cheap first: the ground angle to the point beneath it (most of the catalogue is over the
    // other side of the Earth), before carrying it to now and working out where it is in the sky.
    const raw = o.position;
    const c = carryOf(o, nowMs);
    const φ = (raw.latitude * Math.PI) / 180;
    const Δλ = ((raw.longitude - observer.longitude) * Math.PI) / 180;
    const cosc = sinφo * Math.sin(φ) + cosφo * Math.cos(φ) * Math.cos(Δλ);
    if (beyondReach(Math.acos(Math.max(-1, Math.min(1, cosc))), raw.altitudeM ?? 0, c, min)) continue;
    if (c.behindMs > SKY_BEHIND_MS) {
      stale++;
      continue;
    }
    const p = carried(raw, c);
    const look = lookAngles(observer, p);
    if (!(look.elevationDeg >= min)) continue;
    total++;
    const lit = sunlit(toEcef(p), sun);
    // Decided on the elevation as it is sent (to a tenth), so the panel's "could be seen"
    // (sky-plot.ts `visibleToEye`) and this count agree at 10°.
    const elevationDeg = Math.round(look.elevationDeg * 10) / 10;
    const eye = lit && dark && elevationDeg >= SKY_EYE_MIN_ELEVATION_DEG;
    if (eye) visible++;
    if (opts.visibleOnly && !eye) continue;
    const name = o.labels['name'] ?? (typeof o.properties['name'] === 'string' ? o.properties['name'] : o.id);
    above.push({
      id: o.id,
      name,
      ...(typeof category === 'string' ? { category } : {}),
      azimuthDeg: Math.round(look.azimuthDeg * 10) / 10,
      elevationDeg,
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
    stale,
    sunElevationDeg,
    satellites: above.slice(0, limit),
  };
}
