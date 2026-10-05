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

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Where a satellite is at `nowMs`: its position carried along the chord to `nextPosition`. */
export function satelliteNow(o: WorldObject, nowMs: number): GeoPosition | undefined {
  const p = o.position;
  if (!p || p.altitudeM === undefined) return undefined;
  const next = o.properties['nextPosition'];
  const from = Date.parse(String(o.properties['propagatedAt'] ?? o.observedAt));
  if (!Array.isArray(next) || next.length < 4 || !Number.isFinite(from)) return p;
  const [lat, lon, alt, at] = next.map(num);
  if (lat === undefined || lon === undefined || alt === undefined || at === undefined || !(at > from)) return p;
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

export function skyOverhead(
  objects: Iterable<WorldObject>,
  observer: GeoPosition,
  nowMs: number,
  opts: { minElevationDeg?: number; limit?: number } = {},
): SkyOverheadAnswer {
  const min = opts.minElevationDeg ?? 0;
  const limit = opts.limit ?? SKY_LIMIT_DEFAULT;
  const sun = sunDirection(nowMs);
  const above: SkySatellite[] = [];
  for (const o of objects) {
    if (o.type !== 'satellite') continue;
    const p = satelliteNow(o, nowMs);
    if (!p) continue;
    const look = lookAngles(observer, p);
    if (!(look.elevationDeg >= min)) continue;
    const name = o.labels['name'] ?? (typeof o.properties['name'] === 'string' ? o.properties['name'] : o.id);
    const category = o.properties['satelliteCategory'];
    above.push({
      id: o.id,
      name,
      ...(typeof category === 'string' ? { category } : {}),
      azimuthDeg: Math.round(look.azimuthDeg * 10) / 10,
      elevationDeg: Math.round(look.elevationDeg * 10) / 10,
      rangeM: Math.round(look.rangeM),
      altitudeM: Math.round(p.altitudeM ?? 0),
      sunlit: sunlit(toEcef(p), sun),
    });
  }
  above.sort((a, b) => b.elevationDeg - a.elevationDeg || (a.id < b.id ? -1 : 1));
  return {
    at: new Date(nowMs).toISOString(),
    observer: { latitude: observer.latitude, longitude: observer.longitude },
    total: above.length,
    sunElevationDeg: Math.round(sunPosition(nowMs, observer).altitudeDeg * 10) / 10,
    satellites: above.slice(0, limit),
  };
}
