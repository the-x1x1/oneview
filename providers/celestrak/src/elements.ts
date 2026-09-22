import type { CelestrakFormat } from './manifest.js';

/**
 * General-perturbations element set in a format-independent shape. Both CelesTrak
 * formats (OMM JSON and 3-line TLE) parse into this record, which is also what
 * the provider caches (plain JSON) and hands to a Propagator.
 *
 * TLE parsing adapted from gods-eye-view src/layers/satellites/orbits.js (MIT):
 * name / line1 / line2 triples, with column decoding and checksums added here.
 */
export type GpElements = {
  /** NORAD catalog number (also the observation externalId). */
  noradId: number;
  name: string;
  /** International designator, e.g. 1998-067A. */
  intlDesignator?: string;
  /** Element-set epoch, UTC ISO. */
  epoch: string;
  /** Revolutions per day. */
  meanMotion: number;
  eccentricity: number;
  /** Degrees. */
  inclination: number;
  /** Right ascension of the ascending node, degrees. */
  raan: number;
  /** Argument of perigee, degrees. */
  argPerigee: number;
  /** Mean anomaly at epoch, degrees. */
  meanAnomaly: number;
  /** SGP4 drag term (1/earth radii). */
  bstar?: number;
  /** First derivative of mean motion / 2 (rev/day²). */
  meanMotionDot?: number;
  /** Second derivative of mean motion / 6 (rev/day³). */
  meanMotionDdot?: number;
  elementSetNo?: number;
  revAtEpoch?: number;
  classification?: string;
  /** Original TLE lines when the catalog was fetched as TLE. */
  line1?: string;
  line2?: string;
};

export interface ParsedCatalog {
  elements: GpElements[];
  /** Number of records seen in the body (valid or not). */
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

const TWO_DIGIT_YEAR_PIVOT = 57; // TLE convention: 57-99 → 1957-1999, 00-56 → 2000-2056

function finite(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function inRange(v: number | undefined, min: number, max: number): v is number {
  return v !== undefined && v >= min && v <= max;
}

/** Validate ranges shared by both formats. Returns a reason on failure. */
export function validateElements(e: GpElements): string | undefined {
  if (!Number.isInteger(e.noradId) || e.noradId < 1 || e.noradId > 999_999_999) return 'invalid NORAD id';
  if (!e.name) return 'missing name';
  if (!Number.isFinite(Date.parse(e.epoch))) return 'invalid epoch';
  if (!(e.meanMotion > 0) || e.meanMotion > 20) return 'mean motion out of range';
  if (!(e.eccentricity >= 0) || e.eccentricity >= 1) return 'eccentricity out of range';
  if (!inRange(e.inclination, 0, 180)) return 'inclination out of range';
  if (!inRange(e.raan, 0, 360)) return 'RAAN out of range';
  if (!inRange(e.argPerigee, 0, 360)) return 'argument of perigee out of range';
  if (!inRange(e.meanAnomaly, 0, 360)) return 'mean anomaly out of range';
  return undefined;
}

/** CelesTrak OMM epochs carry no zone designator (`2026-09-21T03:12:34.123456`); they are UTC. */
export function ommEpochToIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
  if (!m) return undefined;
  const fraction = m[2] ? m[2].slice(0, 4).padEnd(4, '0') : '.000';
  const ms = Date.parse(`${m[1]}${fraction}${m[3] ?? 'Z'}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function ommRecordToElements(raw: unknown): GpElements | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'record not an object';
  const r = raw as Record<string, unknown>;
  const noradId = finite(r['NORAD_CAT_ID']);
  if (noradId === undefined) return 'missing NORAD_CAT_ID';
  const epoch = ommEpochToIso(r['EPOCH']);
  if (!epoch) return 'invalid EPOCH';
  const name = typeof r['OBJECT_NAME'] === 'string' ? r['OBJECT_NAME'].trim().slice(0, 64) : '';
  const meanMotion = finite(r['MEAN_MOTION']);
  const eccentricity = finite(r['ECCENTRICITY']);
  const inclination = finite(r['INCLINATION']);
  const raan = finite(r['RA_OF_ASC_NODE']);
  const argPerigee = finite(r['ARG_OF_PERICENTER']);
  const meanAnomaly = finite(r['MEAN_ANOMALY']);
  if (
    meanMotion === undefined ||
    eccentricity === undefined ||
    inclination === undefined ||
    raan === undefined ||
    argPerigee === undefined ||
    meanAnomaly === undefined
  )
    return 'missing orbital elements';
  const e: GpElements = { noradId, name, epoch, meanMotion, eccentricity, inclination, raan, argPerigee, meanAnomaly };
  const intl = typeof r['OBJECT_ID'] === 'string' ? r['OBJECT_ID'].trim() : '';
  if (intl) e.intlDesignator = intl.slice(0, 16);
  const bstar = finite(r['BSTAR']);
  if (bstar !== undefined) e.bstar = bstar;
  const dot = finite(r['MEAN_MOTION_DOT']);
  if (dot !== undefined) e.meanMotionDot = dot;
  const ddot = finite(r['MEAN_MOTION_DDOT']);
  if (ddot !== undefined) e.meanMotionDdot = ddot;
  const setNo = finite(r['ELEMENT_SET_NO']);
  if (setNo !== undefined) e.elementSetNo = setNo;
  const rev = finite(r['REV_AT_EPOCH']);
  if (rev !== undefined) e.revAtEpoch = rev;
  const cls = typeof r['CLASSIFICATION_TYPE'] === 'string' ? r['CLASSIFICATION_TYPE'].trim() : '';
  if (cls) e.classification = cls.slice(0, 1);
  const invalid = validateElements(e);
  return invalid ?? e;
}

/** Parse a CelesTrak `FORMAT=json` body (array of OMM records). Non-array → single rejection at index -1. */
export function parseOmmJson(payload: unknown): ParsedCatalog {
  if (!Array.isArray(payload)) return { elements: [], total: 0, rejected: [{ index: -1, reason: 'not an OMM array' }] };
  const elements: GpElements[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  payload.forEach((raw, index) => {
    const r = ommRecordToElements(raw);
    if (typeof r === 'string') rejected.push({ index, reason: r });
    else elements.push(r);
  });
  return { elements, total: payload.length, rejected };
}

// ---- TLE -------------------------------------------------------------------

/** TLE checksum: sum of digits (minus signs count 1) over columns 1-68, mod 10. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < 68 && i < line.length; i++) {
    const c = line[i]!;
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

/** Alpha-5 catalog numbers: first character A-Z (no I/O) encodes 10-33 ten-thousands. */
export function decodeCatalogNumber(field: string): number | undefined {
  const f = field.trim();
  if (/^\d{1,5}$/.test(f)) return Number(f);
  const m = /^([A-HJ-NP-Z])(\d{4})$/.exec(f);
  if (!m) return undefined;
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return (letters.indexOf(m[1]!) + 10) * 10_000 + Number(m[2]);
}

/** "±NNNNN±E" implied-decimal exponent field (BSTAR, ndot/6). */
function impliedExponent(field: string): number | undefined {
  const m = /^\s*([+-]?)(\d+)([+-]\d)\s*$/.exec(field);
  if (!m) return undefined;
  const mantissa = Number(`${m[1]}0.${m[2]}`);
  return mantissa * 10 ** Number(m[3]);
}

function tleEpochToIso(yearField: string, dayField: string): string | undefined {
  const yy = Number(yearField);
  const day = Number(dayField);
  if (!Number.isInteger(yy) || !Number.isFinite(day) || day < 1 || day >= 367) return undefined;
  const year = yy >= TWO_DIGIT_YEAR_PIVOT ? 1900 + yy : 2000 + yy;
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000).toISOString();
}

export function intlDesignatorFromTle(field: string): string | undefined {
  const f = field.trim();
  const m = /^(\d{2})(\d{3})([A-Z]{1,3})$/.exec(f);
  if (!m) return f ? f.slice(0, 16) : undefined;
  const yy = Number(m[1]);
  const year = yy >= TWO_DIGIT_YEAR_PIVOT ? 1900 + yy : 2000 + yy;
  return `${year}-${m[2]}${m[3]}`;
}

/** Decode one name/line1/line2 triple. Returns a reason string on failure. */
export function tleToElements(name: string, line1: string, line2: string): GpElements | string {
  if (line1.length < 69 || line2.length < 69) return 'TLE line too short';
  if (line1[0] !== '1' || line2[0] !== '2') return 'TLE line numbers wrong';
  if (tleChecksum(line1) !== Number(line1[68]) || tleChecksum(line2) !== Number(line2[68]))
    return 'TLE checksum mismatch';
  const noradId = decodeCatalogNumber(line1.slice(2, 7));
  const noradId2 = decodeCatalogNumber(line2.slice(2, 7));
  if (noradId === undefined || noradId !== noradId2) return 'TLE catalog numbers disagree';
  const epoch = tleEpochToIso(line1.slice(18, 20), line1.slice(20, 32));
  if (!epoch) return 'invalid TLE epoch';
  const inclination = finite(line2.slice(8, 16));
  const raan = finite(line2.slice(17, 25));
  const ecc = finite(`0.${line2.slice(26, 33).trim()}`);
  const argPerigee = finite(line2.slice(34, 42));
  const meanAnomaly = finite(line2.slice(43, 51));
  const meanMotion = finite(line2.slice(52, 63));
  if (
    inclination === undefined ||
    raan === undefined ||
    ecc === undefined ||
    argPerigee === undefined ||
    meanAnomaly === undefined ||
    meanMotion === undefined
  )
    return 'TLE line 2 unparsable';
  const e: GpElements = {
    noradId,
    name: name.trim().slice(0, 64),
    epoch,
    meanMotion,
    eccentricity: ecc,
    inclination,
    raan,
    argPerigee,
    meanAnomaly,
    line1,
    line2,
  };
  const intl = intlDesignatorFromTle(line1.slice(9, 17));
  if (intl) e.intlDesignator = intl;
  const cls = line1[7];
  if (cls && cls !== ' ') e.classification = cls;
  const dot = finite(line1.slice(33, 43));
  if (dot !== undefined) e.meanMotionDot = dot;
  const ddot = impliedExponent(line1.slice(44, 52));
  if (ddot !== undefined) e.meanMotionDdot = ddot;
  const bstar = impliedExponent(line1.slice(53, 61));
  if (bstar !== undefined) e.bstar = bstar;
  const setNo = finite(line1.slice(64, 68));
  if (setNo !== undefined) e.elementSetNo = setNo;
  const rev = finite(line2.slice(63, 68));
  if (rev !== undefined) e.revAtEpoch = rev;
  const invalid = validateElements(e);
  return invalid ?? e;
}

/** Parse a `FORMAT=tle` body: name / line1 / line2 triples (2-line sets without names are accepted). */
export function parseTleText(text: string): ParsedCatalog {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const elements: GpElements[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  let total = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      // 2-line set without a name line.
      const r = tleToElements(`NORAD ${line.slice(2, 7).trim()}`, line, lines[i + 1]!);
      if (typeof r === 'string') rejected.push({ index: total, reason: r });
      else elements.push(r);
      total++;
      i += 2;
      continue;
    }
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      const r = tleToElements(line, lines[i + 1]!, lines[i + 2]!);
      if (typeof r === 'string') rejected.push({ index: total, reason: r });
      else elements.push(r);
      total++;
      i += 3;
      continue;
    }
    rejected.push({ index: total, reason: `unexpected line: ${line.slice(0, 24)}` });
    total++;
    i++;
  }
  if (total === 0) return { elements: [], total: 0, rejected: [{ index: -1, reason: 'no TLE records' }] };
  return { elements, total, rejected };
}

/** Parse a CelesTrak body in the requested format. */
export function parseCatalog(body: string, format: CelestrakFormat): ParsedCatalog {
  if (format === 'tle') return parseTleText(body);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { elements: [], total: 0, rejected: [{ index: -1, reason: 'not valid JSON' }] };
  }
  return parseOmmJson(payload);
}

const MU_KM3_S2 = 398_600.4418;
export const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;

/** Semi-major axis (km) from mean motion (rev/day). */
export function semiMajorAxisKm(meanMotionRevPerDay: number): number {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86_400;
  return Math.cbrt(MU_KM3_S2 / (n * n));
}

export function orbitSummary(e: GpElements): {
  periodMinutes: number;
  apogeeKm: number;
  perigeeKm: number;
  semiMajorAxisKm: number;
} {
  const a = semiMajorAxisKm(e.meanMotion);
  return {
    periodMinutes: 1440 / e.meanMotion,
    apogeeKm: a * (1 + e.eccentricity) - EARTH_EQUATORIAL_RADIUS_KM,
    perigeeKm: a * (1 - e.eccentricity) - EARTH_EQUATORIAL_RADIUS_KM,
    semiMajorAxisKm: a,
  };
}
