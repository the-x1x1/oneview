/**
 * Where the Sun is, for the day/night shading (Settings → Map → Day and night, or N).
 *
 * The globe needs only the time — Cesium lights it from its own sun model once the scene
 * clock says what time it is — but the 2D map has nothing of the kind: it draws the night
 * side as a polygon, and this is where that polygon comes from. It is also what the tests
 * pin the geometry to, so both views are checked against the same astronomy.
 *
 * The solar position is the low-precision algorithm of the Astronomical Almanac (Meeus,
 * *Astronomical Algorithms*, ch. 25, as used by NOAA's solar calculator): good to about
 * 0.01° in declination for dates within a few centuries of 2000. The terminator on a map
 * is a line a few kilometres wide at best (refraction alone moves it by ~0.5°), so nothing
 * finer is worth its cost.
 */

const DEG = Math.PI / 180;

export interface SubsolarPoint {
  /** The Sun's declination: the latitude where it stands overhead, degrees. */
  latitude: number;
  /** The longitude where it is local apparent noon, degrees in [−180, 180). */
  longitude: number;
}

/** Julian centuries since J2000.0 and days since J2000.0, from epoch milliseconds. */
function j2000(ms: number): { d: number; t: number } {
  const d = ms / 86_400_000 + 2_440_587.5 - 2_451_545.0;
  return { d, t: d / 36_525 };
}

function wrap180(deg: number): number {
  const x = (((deg + 180) % 360) + 360) % 360;
  return x - 180;
}

/** The point on the Earth with the Sun directly overhead at `date`. */
export function subsolarPoint(date: Date | number): SubsolarPoint {
  const ms = typeof date === 'number' ? date : date.getTime();
  const { d, t } = j2000(ms);
  const meanLongitude = 280.46646 + t * (36_000.76983 + t * 0.0003032);
  const meanAnomaly = (357.52911 + t * (35_999.05029 - t * 0.0001537)) * DEG;
  const centre =
    Math.sin(meanAnomaly) * (1.914602 - t * (0.004817 + t * 0.000014)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - t * 0.000101) +
    Math.sin(3 * meanAnomaly) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * DEG;
  // Apparent longitude: true longitude less aberration and nutation in longitude.
  const lambda = (meanLongitude + centre - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const epsilon = (meanObliquity + 0.00256 * Math.cos(omega)) * DEG;
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const rightAscension = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  // Greenwich mean sidereal time, degrees (IAU 1982; the t² term is a few milliseconds).
  const gmst = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t;
  return { latitude: declination / DEG, longitude: wrap180(rightAscension / DEG - gmst) };
}

/** The Sun's elevation above the horizon at a place, degrees (geometric: no refraction). */
export function sunElevationDeg(
  date: Date | number,
  place: { latitude: number; longitude: number },
  subsolar: SubsolarPoint = subsolarPoint(date),
): number {
  const phi = place.latitude * DEG;
  const delta = subsolar.latitude * DEG;
  const hourAngle = (place.longitude - subsolar.longitude) * DEG;
  const s = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

/** Where a great-circle course of `distanceDeg` from a point on `bearingDeg` ends (spherical Earth). */
function destination(latDeg: number, lonDeg: number, bearingDeg: number, distanceDeg: number): [number, number] {
  const phi1 = latDeg * DEG;
  const theta = bearingDeg * DEG;
  const delta = distanceDeg * DEG;
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lambda2 =
    lonDeg * DEG +
    Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * sinPhi2);
  return [lambda2 / DEG, phi2 / DEG];
}

/** Shortest signed difference b − a between two longitudes, in (−180, 180]. */
function lonDelta(a: number, b: number): number {
  let x = (b - a) % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

/**
 * The part of the Earth where the Sun is below `elevationDeg` (0: the night side; −6, −12,
 * −18: past civil, nautical, astronomical twilight) as one closed ring of `[longitude,
 * latitude]` pairs, counter-clockwise, for a GeoJSON Polygon.
 *
 * That region is a spherical cap round the antisolar point, of angular radius 90° plus the
 * elevation. Its edge is traced as a circle of points round that centre. When the cap holds a
 * pole — every night side does, except within a whisker of an equinox — the edge crosses every
 * meridian once and its longitudes run through a full turn; the ring then closes along the
 * pole it holds. Longitudes are left continuous rather than folded into [−180, 180], so a
 * ring can run from −170° to 190°: MapLibre (geojson-vt) draws those across the antimeridian
 * correctly, where a folded ring would be drawn as a band across the whole map.
 *
 * `steps` points trace the edge (default one per 2° of bearing).
 */
export function nightRing(
  date: Date | number,
  elevationDeg = 0,
  steps = 180,
  subsolar: SubsolarPoint = subsolarPoint(date),
): Array<[number, number]> {
  // Exactly at an equinox the terminator runs through both poles and the ring degenerates
  // (neither pole is inside). A declination held a millidegree off zero moves the line by
  // about 100 m and keeps one pole inside.
  const minDec = 1e-3;
  const dec = Math.abs(subsolar.latitude) < minDec ? (subsolar.latitude < 0 ? -minDec : minDec) : subsolar.latitude;
  const centreLat = -dec;
  const centreLon = wrap180(subsolar.longitude + 180);
  const radius = 90 + elevationDeg;
  const n = Math.max(8, Math.floor(steps));
  const edge: Array<[number, number]> = [];
  // Which way round this traces the ring on the lon/lat plane depends on the case below;
  // the ring is oriented at the end.
  for (let i = 0; i < n; i++) edge.push(destination(centreLat, centreLon, (i * 360) / n, radius));

  const holdsNorth = 90 - centreLat < radius;
  const holdsSouth = 90 + centreLat < radius;
  const unwrapped: Array<[number, number]> = [];
  if (holdsNorth || holdsSouth) {
    // The edge's longitude turns once round the pole, always the same way. Near the pole a
    // single step can swing by nearly 180°, where the shortest difference is ambiguous, so
    // the way round is taken from the typical step and every step is unwrapped in it.
    const deltas: number[] = [];
    for (let i = 1; i < n; i++) deltas.push(lonDelta(edge[i - 1]![0], edge[i]![0]));
    const sorted = [...deltas].sort((a, b) => a - b);
    const direction = sorted[Math.floor(sorted.length / 2)]! >= 0 ? 1 : -1;
    let lon = edge[0]![0];
    unwrapped.push([lon, edge[0]![1]]);
    for (let i = 1; i < n; i++) {
      let step = deltas[i - 1]!;
      if (Math.sign(step) !== direction && step !== 0) step += direction * 360;
      lon += step;
      unwrapped.push([lon, edge[i]![1]]);
    }
    // Close the turn: the first point again, a full revolution on.
    unwrapped.push([edge[0]![0] + direction * 360, edge[0]![1]]);
    const pole = holdsNorth ? 90 : -90;
    const last = unwrapped[unwrapped.length - 1]!;
    unwrapped.push([last[0], pole], [unwrapped[0]![0], pole], [unwrapped[0]![0], unwrapped[0]![1]]);
  } else {
    // A cap clear of both poles: a closed blob; keep longitudes continuous round its centre.
    for (const [lon, lat] of edge) unwrapped.push([centreLon + lonDelta(centreLon, lon), lat]);
    unwrapped.push([unwrapped[0]![0], unwrapped[0]![1]]);
  }
  return signedArea(unwrapped) < 0 ? unwrapped.reverse() : unwrapped;
}

/** Twice the signed area of a closed ring on the lon/lat plane (positive: counter-clockwise). */
function signedArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 1; i < ring.length; i++) a += ring[i - 1]![0] * ring[i]![1] - ring[i]![0] * ring[i - 1]![1];
  return a;
}

/**
 * The shading bands the 2D map draws, darkest last: the night side past each twilight, so
 * the stacked fills darken smoothly from the terminator to full night instead of stepping
 * once at the line.
 */
export const NIGHT_BANDS_DEG: readonly number[] = [0, -6, -12, -18];

/** How often the shading is recomputed: the terminator moves 0.25° of longitude a minute. */
export const DAY_NIGHT_REFRESH_MS = 60_000;
