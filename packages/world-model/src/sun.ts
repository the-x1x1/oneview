/**
 * Where the Sun is: the point on the Earth with the Sun overhead. The day/night shading
 * (render-core sun.ts) and a satellite pass's visibility (providers/celestrak passes.ts) both
 * start here, so the map's night side and "visible: the satellite is sunlit and the sky is
 * dark" agree.
 *
 * The solar position is the low-precision algorithm of the Astronomical Almanac (Meeus,
 * *Astronomical Algorithms*, ch. 25, as used by NOAA's solar calculator): good to about
 * 0.01° in declination for dates within a few centuries of 2000.
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

export function wrap180Deg(deg: number): number {
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
  return { latitude: declination / DEG, longitude: wrap180Deg(rightAscension / DEG - gmst) };
}
