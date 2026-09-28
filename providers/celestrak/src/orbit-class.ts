import { EARTH_EQUATORIAL_RADIUS_KM, semiMajorAxisKm, type GpElements } from './elements.js';

/**
 * The orbit's class in the words everyone uses — LEO, MEO, GEO, HEO — from the element set
 * alone (mean motion and eccentricity), so it is known for every satellite whether or not
 * its catalogue record has been read.
 *
 * The boundaries are the conventional ones:
 *
 *  - HEO (highly elliptical): eccentricity 0.25 or more — Molniya and Tundra orbits,
 *    transfer orbits. Checked first: such an orbit's perigee can be low and its apogee far
 *    beyond geostationary, so neither altitude alone describes it.
 *  - GEO (geosynchronous): one revolution per sidereal day, 0.99–1.01 rev/day, nearly
 *    circular (e < 0.01). Includes inclined geosynchronous orbits, which trace a figure of
 *    eight rather than hold still; `geostationary` says whether it also holds still
 *    (inclination under 1°).
 *  - LEO (low Earth orbit): apogee below 2,000 km.
 *  - MEO (medium Earth orbit): the rest up to geosynchronous — navigation constellations sit
 *    here at ~20,000 km.
 *  - Beyond GEO: slower than one revolution a day and not elliptical enough for HEO.
 */
export type OrbitClass = 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'beyond-GEO';

export const ORBIT_CLASS_TEXT: Readonly<Record<OrbitClass, string>> = Object.freeze({
  LEO: 'Low Earth orbit (LEO)',
  MEO: 'Medium Earth orbit (MEO)',
  GEO: 'Geosynchronous orbit (GEO)',
  HEO: 'Highly elliptical orbit (HEO)',
  'beyond-GEO': 'Beyond geosynchronous',
});

const LEO_MAX_APOGEE_KM = 2000;

export function orbitClass(e: Pick<GpElements, 'meanMotion' | 'eccentricity'>): OrbitClass | undefined {
  if (!Number.isFinite(e.meanMotion) || e.meanMotion <= 0) return undefined;
  if (!Number.isFinite(e.eccentricity) || e.eccentricity < 0 || e.eccentricity >= 1) return undefined;
  if (e.eccentricity >= 0.25) return 'HEO';
  if (e.meanMotion >= 0.99 && e.meanMotion <= 1.01 && e.eccentricity < 0.01) return 'GEO';
  if (e.meanMotion < 0.99) return 'beyond-GEO';
  const apogeeKm = semiMajorAxisKm(e.meanMotion) * (1 + e.eccentricity) - EARTH_EQUATORIAL_RADIUS_KM;
  return apogeeKm < LEO_MAX_APOGEE_KM ? 'LEO' : 'MEO';
}

/** Geosynchronous and holding still over one point: inclination under a degree. */
export function isGeostationary(e: Pick<GpElements, 'meanMotion' | 'eccentricity' | 'inclination'>): boolean {
  return orbitClass(e) === 'GEO' && e.inclination < 1;
}
