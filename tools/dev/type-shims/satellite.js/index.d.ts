/**
 * Declaration shim for `satellite.js` — used ONLY when the real package is not
 * installed (tools/dev/typecheck.mjs maps it in and records that in evidence).
 * It declares the minimal surface `providers/celestrak/src/satellite-js-propagator.ts`
 * uses, matching the documented API of satellite.js ≥ 5 (SGP4):
 *
 *   twoline2satrec(line1, line2) / json2satrec(omm) → SatRec (satrec.error !== 0 on failure)
 *   propagate(satrec, date) → { position, velocity } in ECI km / km·s⁻¹ (false/null on failure)
 *   gstime(date) → GMST radians; eciToGeodetic(eci, gmst) → radians + km
 *   degreesLat / degreesLong → radians → degrees
 */
export interface EciVec3<T> { x: T; y: T; z: T }

export interface SatRec {
  /** Catalog number as a string (may be Alpha-5). */
  satnum: string;
  /** 0 = ok; 1-6 = SGP4 error codes (decayed, invalid elements…). */
  error: number;
  epochyr: number;
  epochdays: number;
  jdsatepoch: number;
  /** Mean motion, radians per minute. */
  no: number;
  inclo: number;
  nodeo: number;
  ecco: number;
  argpo: number;
  mo: number;
  bstar: number;
}

export interface PositionAndVelocity {
  position: EciVec3<number> | boolean | null;
  velocity: EciVec3<number> | boolean | null;
}

export interface GeodeticLocation {
  /** Radians. */
  longitude: number;
  /** Radians. */
  latitude: number;
  /** Kilometres above the WGS72/84 ellipsoid. */
  height: number;
}

/** OMM record as published by CelesTrak `FORMAT=json`. */
export interface OMMJsonObject {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  EPHEMERIS_TYPE: number;
  CLASSIFICATION_TYPE: 'U' | 'C';
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
}

export function twoline2satrec(line1: string, line2: string): SatRec;
export function json2satrec(omm: OMMJsonObject): SatRec;
/** Null when the element set cannot be propagated to that time; the real package types it so. */
export function propagate(satrec: SatRec, date: Date): PositionAndVelocity | null;
export function gstime(date: Date): number;
export function eciToGeodetic(eci: EciVec3<number>, gmst: number): GeodeticLocation;
export function degreesLat(radians: number): number;
export function degreesLong(radians: number): number;
