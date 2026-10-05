/**
 * Distances, bearings and areas on the WGS84 ellipsoid, for readouts a person compares with
 * other tools (the measure tool, the HUD's range row). The rest of the app keeps the
 * spherical `haversineMeters`, which is good to about 0.5% and is all a filter or a
 * nearness rank needs.
 *
 * Distance and bearings: Vincenty's inverse method (T. Vincenty, "Direct and inverse
 * solutions of geodesics on the ellipsoid with application of nested equations", Survey
 * Review 23 (1975) 88–93), good to well under a millimetre. It does not converge for points
 * within a fraction of a degree of each other's antipode; there the spherical distance and
 * bearing are given (within about 0.1%) and `approximate` says so.
 *
 * Area: the polygon's vertices are carried to the authalic sphere — the sphere of the
 * ellipsoid's area, by authalic latitude, which keeps areas — and the area is taken there
 * along great circles (the spherical excess of each edge against the equator). Against the
 * polygon with geodesic edges it is within 0.001% for a shape 200 km across, 0.01% at
 * 1,000 km and 0.2% for one the size of a continent, where the edges' paths differ.
 *
 * Both were checked against GeographicLib's GeodSolve and Planimeter (geodesic.test.ts).
 */
import { EARTH_RADIUS_M, normalizeLongitude } from './geo.js';

const A = 6_378_137;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const DEG = Math.PI / 180;

export interface GeodesicInverse {
  /** Metres along the geodesic. */
  distanceM: number;
  /** Bearing at the start, degrees clockwise from true north in [0, 360). */
  initialBearingDeg: number;
  /** Bearing on arrival, degrees clockwise from true north in [0, 360). */
  finalBearingDeg: number;
  /** True when the points are nearly antipodal and the spherical answer was given. */
  approximate?: true;
}

const bearing = (rad: number) => (((rad / DEG) % 360) + 360) % 360;

/** The shortest path between two points on the WGS84 ellipsoid. */
export function geodesicInverse(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): GeodesicInverse {
  const L = normalizeLongitude(b.longitude - a.longitude) * DEG;
  const U1 = Math.atan((1 - F) * Math.tan(a.latitude * DEG));
  const U2 = Math.atan((1 - F) * Math.tan(b.latitude * DEG));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let sinLambda = 0;
  let cosLambda = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;
  let converged = false;
  for (let i = 0; i < 200; i++) {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.hypot(t1, t2);
    if (sinSigma === 0) return { distanceM: 0, initialBearingDeg: 0, finalBearingDeg: 0 };
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    // On the equator cos²α is 0 and the term drops out.
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda) > Math.PI) break;
    if (Math.abs(lambda - previous) < 1e-12) {
      converged = true;
      break;
    }
  }
  if (!converged) return sphericalInverse(a, b);
  sinLambda = Math.sin(lambda);
  cosLambda = Math.cos(lambda);
  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma =
    bigB *
    sinSigma *
    (cos2SigmaM +
      (bigB / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return {
    distanceM: B * bigA * (sigma - deltaSigma),
    initialBearingDeg: bearing(Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)),
    finalBearingDeg: bearing(Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda)),
  };
}

function sphericalInverse(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): GeodesicInverse {
  const φ1 = a.latitude * DEG;
  const φ2 = b.latitude * DEG;
  const Δλ = normalizeLongitude(b.longitude - a.longitude) * DEG;
  const h = Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const distanceM = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const y2 = Math.sin(-Δλ) * Math.cos(φ1);
  const x2 = Math.cos(φ2) * Math.sin(φ1) - Math.sin(φ2) * Math.cos(φ1) * Math.cos(Δλ);
  return {
    distanceM,
    initialBearingDeg: bearing(Math.atan2(y, x)),
    finalBearingDeg: (bearing(Math.atan2(y2, x2)) + 180) % 360,
    approximate: true,
  };
}

/** q(φ) of the authalic latitude (Snyder, "Map Projections — A Working Manual", eq. 3-12). */
function authalicQ(sinPhi: number): number {
  return (
    (1 - E2) * (sinPhi / (1 - E2 * sinPhi * sinPhi) - (1 / (2 * E)) * Math.log((1 - E * sinPhi) / (1 + E * sinPhi)))
  );
}
const QP = authalicQ(1);
/** The radius of the sphere with the ellipsoid's surface area. */
export const AUTHALIC_RADIUS_M = A * Math.sqrt(QP / 2);
/** The ellipsoid's surface area, m². */
export const EARTH_AREA_M2 = 4 * Math.PI * AUTHALIC_RADIUS_M * AUTHALIC_RADIUS_M;

/** The authalic latitude (radians) of a geodetic latitude in degrees. */
function authalicLatitude(latitudeDeg: number): number {
  return Math.asin(Math.max(-1, Math.min(1, authalicQ(Math.sin(latitudeDeg * DEG)) / QP)));
}

/**
 * The area enclosed by a ring of points (closed back to the first; at least three), in m² —
 * the smaller of the two regions the ring divides the Earth into. The ring should not cross
 * itself: where it does, the lobes count against each other.
 */
export function geodesicPolygonArea(points: readonly { latitude: number; longitude: number }[]): number {
  if (points.length < 3) return 0;
  let excess = 0;
  let turn = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    const dLon = normalizeLongitude(q.longitude - p.longitude) * DEG;
    const t1 = Math.tan(authalicLatitude(p.latitude) / 2);
    const t2 = Math.tan(authalicLatitude(q.latitude) / 2);
    // The signed spherical excess between this edge and the equator.
    excess += 2 * Math.atan2(Math.tan(dLon / 2) * (t1 + t2), 1 + t1 * t2);
    turn += dLon;
  }
  // A ring round a pole has gone once round in longitude: the sum above then measured it
  // against the equator, a hemisphere off.
  if (Math.abs(turn) > Math.PI) excess -= Math.sign(turn) * 2 * Math.PI;
  const area = Math.abs(excess) * AUTHALIC_RADIUS_M * AUTHALIC_RADIUS_M;
  return Math.min(area, EARTH_AREA_M2 - area);
}
