/**
 * UTM and MGRS grid references on the WGS84 ellipsoid, both ways.
 *
 * The projection is the transverse Mercator in Krüger's series to sixth order in the third
 * flattening n (L. Krüger 1912, in the form given by C. F. F. Karney, "Transverse Mercator
 * with an accuracy of a few nanometers", J. Geodesy 85 (2011), eqs. 7–11 and 35–36), which
 * is good to well under a millimetre anywhere a UTM zone is used. Zones follow the standard
 * rules, Norway's 32V and Svalbard's 31X–37X included; latitude bands are C to X, 8° each,
 * X 12°. UTM covers 80° S to 84° N; the polar caps take the Universal Polar Stereographic
 * grid (UPS: scale 0.994 at the pole, false easting and northing 2,000 km), and MGRS letters
 * them A and B (south, west and east of the 0° meridian) and Y and Z (north).
 *
 * MGRS letters are the current (WGS84, "AA") scheme. A reference names a square — 100 km down
 * to 1 m — and is written by truncating, never rounding, as the standard requires; read
 * back, it gives the middle of its square. The results were checked against GeographicLib's
 * GeoConvert (grid-reference.test.ts says how).
 */
import { normalizeLongitude } from './geo.js';

export const UTM_SOUTH_LIMIT = -80;
export const UTM_NORTH_LIMIT = 84;

const A = 6_378_137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500_000;
const FALSE_NORTHING_SOUTH = 10_000_000;
const DEG = Math.PI / 180;

const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const N1 = F / (2 - F);
const N2 = N1 * N1;
const N3 = N2 * N1;
const N4 = N3 * N1;
const N5 = N4 * N1;
const N6 = N5 * N1;
/** The meridian's rectifying radius times the scale on the central meridian. */
const K0_RECT = K0 * (A / (1 + N1)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
/** Krüger's coefficients, geographic → projected (α) and back (β). */
const ALPHA = [
  N1 / 2 - (2 * N2) / 3 + (5 * N3) / 16 + (41 * N4) / 180 - (127 * N5) / 288 + (7891 * N6) / 37800,
  (13 * N2) / 48 - (3 * N3) / 5 + (557 * N4) / 1440 + (281 * N5) / 630 - (1983433 * N6) / 1935360,
  (61 * N3) / 240 - (103 * N4) / 140 + (15061 * N5) / 26880 + (167603 * N6) / 181440,
  (49561 * N4) / 161280 - (179 * N5) / 168 + (6601661 * N6) / 7257600,
  (34729 * N5) / 80640 - (3418889 * N6) / 1995840,
  (212378941 * N6) / 319334400,
];
const BETA = [
  N1 / 2 - (2 * N2) / 3 + (37 * N3) / 96 - N4 / 360 - (81 * N5) / 512 + (96199 * N6) / 604800,
  N2 / 48 + N3 / 15 - (437 * N4) / 1440 + (46 * N5) / 105 - (1118711 * N6) / 3870720,
  (17 * N3) / 480 - (37 * N4) / 840 - (209 * N5) / 4480 + (5569 * N6) / 90720,
  (4397 * N4) / 161280 - (11 * N5) / 504 - (830251 * N6) / 7257600,
  (4583 * N5) / 161280 - (108847 * N6) / 3991680,
  (20648693 * N6) / 638668800,
];

/** τ' — the tangent of the conformal latitude — from τ, the tangent of the geographic one. */
function conformalTan(tau: number): number {
  const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.hypot(1, tau)));
  return tau * Math.hypot(1, sigma) - sigma * Math.hypot(1, tau);
}

/** Metres east and north of the central meridian's crossing of the equator, scale k0 included. */
function project(latitude: number, dLon: number): { x: number; y: number } {
  const lam = dLon * DEG;
  const tp = conformalTan(Math.tan(latitude * DEG));
  const cosLam = Math.cos(lam);
  const xiP = Math.atan2(tp, cosLam);
  const etaP = Math.asinh(Math.sin(lam) / Math.hypot(tp, cosLam));
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1]!;
    xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  return { x: K0_RECT * eta, y: K0_RECT * xi };
}

/** The inverse of `project`: latitude, and longitude from the central meridian, in degrees. */
function unproject(x: number, y: number): { latitude: number; dLon: number } {
  const xi = y / K0_RECT;
  const eta = x / K0_RECT;
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j++) {
    const b = BETA[j - 1]!;
    xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEtaP = Math.sinh(etaP);
  const cosXiP = Math.cos(xiP);
  const tauP = Math.sin(xiP) / Math.hypot(sinhEtaP, cosXiP);
  // Newton's method for τ from τ' (Karney 2011, eqs. 19–21); a few steps reach machine precision.
  let tau = tauP / (1 - E2);
  for (let i = 0; i < 10; i++) {
    const tpi = conformalTan(tau);
    const step = ((tauP - tpi) / Math.hypot(1, tpi)) * ((1 + (1 - E2) * tau * tau) / ((1 - E2) * Math.hypot(1, tau)));
    tau += step;
    if (!(Math.abs(step) > 1e-14 * Math.max(1, Math.abs(tau)))) break;
  }
  return { latitude: Math.atan(tau) / DEG, dLon: Math.atan2(sinhEtaP, cosXiP) / DEG };
}

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

/** The MGRS/UTM latitude band letter (C–X), or undefined outside 80° S – 84° N. */
export function latitudeBand(latitude: number): string | undefined {
  if (!(latitude >= UTM_SOUTH_LIMIT && latitude < UTM_NORTH_LIMIT)) return undefined;
  return BANDS[Math.min(19, Math.floor((latitude - UTM_SOUTH_LIMIT) / 8))];
}

/** The latitudes a band letter spans: south inclusive, north exclusive. */
export function bandLatitudes(band: string): { south: number; north: number } | undefined {
  const i = BANDS.indexOf(band.toUpperCase());
  if (i < 0 || band.length !== 1) return undefined;
  return { south: UTM_SOUTH_LIMIT + 8 * i, north: i === 19 ? UTM_NORTH_LIMIT : UTM_SOUTH_LIMIT + 8 * (i + 1) };
}

/** The UTM zone a point is in (1–60), with the Norway and Svalbard exceptions. */
export function utmZone(latitude: number, longitude: number): number {
  const lon = normalizeLongitude(longitude);
  let zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
  if (latitude >= 56 && latitude < 64 && lon >= 3 && lon < 12) zone = 32;
  if (latitude >= 72 && latitude < 84 && lon >= 0 && lon < 42) zone = lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : 37;
  return zone;
}

/** The longitude of a zone's central meridian. */
export function utmCentralMeridian(zone: number): number {
  return zone * 6 - 183;
}

export interface UtmCoordinate {
  zone: number;
  hemisphere: 'N' | 'S';
  /** The latitude band letter of the point itself. */
  band: string;
  /** Metres, false easting 500 km included. */
  easting: number;
  /** Metres; in the southern hemisphere the false northing of 10,000 km is included. */
  northing: number;
}

/** A point's UTM coordinate in its standard zone, or undefined outside 80° S – 84° N. */
export function toUtm(p: { latitude: number; longitude: number }): UtmCoordinate | undefined {
  const band = latitudeBand(p.latitude);
  if (!band || !Number.isFinite(p.longitude)) return undefined;
  const zone = utmZone(p.latitude, p.longitude);
  const { x, y } = project(p.latitude, normalizeLongitude(p.longitude - utmCentralMeridian(zone)));
  const south = p.latitude < 0;
  return {
    zone,
    hemisphere: south ? 'S' : 'N',
    band,
    easting: FALSE_EASTING + x,
    northing: south ? y + FALSE_NORTHING_SOUTH : y,
  };
}

/** The point at a UTM coordinate (any zone, either hemisphere); undefined for numbers out of range. */
export function fromUtm(
  zone: number,
  hemisphere: 'N' | 'S',
  easting: number,
  northing: number,
): { latitude: number; longitude: number } | undefined {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return undefined;
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return undefined;
  const y = hemisphere === 'S' ? northing - FALSE_NORTHING_SOUTH : northing;
  const { latitude, dLon } = unproject(easting - FALSE_EASTING, y);
  return { latitude, longitude: normalizeLongitude(utmCentralMeridian(zone) + dLon) };
}

/** `4Q 614096mE 2355747mN` — whole metres, truncated. */
export function formatUtm(u: UtmCoordinate): string {
  return `${u.zone}${u.band} ${Math.floor(u.easting)}mE ${Math.floor(u.northing)}mN`;
}

// --- UPS ---------------------------------------------------------------------------------

const UPS_K0 = 0.994;
const UPS_FALSE = 2_000_000;
/** 2·a·k0 / √((1+e)^(1+e)·(1−e)^(1−e)) (Snyder, eq. 21-33). */
const UPS_RHO_SCALE = (2 * A * UPS_K0) / Math.sqrt((1 + E) ** (1 + E) * (1 - E) ** (1 - E));

export interface UpsCoordinate {
  hemisphere: 'N' | 'S';
  easting: number;
  northing: number;
}

/**
 * A point's UPS coordinate: the polar stereographic projection of its pole's hemisphere (north
 * from the equator up, south below it). Meant for the caps beyond UTM — 84° N and 80° S — where
 * MGRS uses it; undefined for an invalid point.
 */
export function toUps(p: { latitude: number; longitude: number }): UpsCoordinate | undefined {
  if (!(Math.abs(p.latitude) <= 90) || !Number.isFinite(p.longitude)) return undefined;
  const north = p.latitude >= 0;
  const φ = (north ? p.latitude : -p.latitude) * DEG;
  // 180° and −180° are one meridian; it is taken as +180 (east), as GeographicLib does.
  const lon = normalizeLongitude(p.longitude);
  const λ = (lon === -180 ? 180 : lon) * DEG;
  const sinφ = Math.sin(φ);
  const t = Math.tan(Math.PI / 4 - φ / 2) / ((1 - E * sinφ) / (1 + E * sinφ)) ** (E / 2);
  const ρ = UPS_RHO_SCALE * t;
  return {
    hemisphere: north ? 'N' : 'S',
    easting: UPS_FALSE + ρ * Math.sin(λ),
    northing: UPS_FALSE + (north ? -1 : 1) * ρ * Math.cos(λ),
  };
}

/** The point at a UPS coordinate. */
export function fromUps(
  hemisphere: 'N' | 'S',
  easting: number,
  northing: number,
): { latitude: number; longitude: number } | undefined {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return undefined;
  const x = easting - UPS_FALSE;
  const y = northing - UPS_FALSE;
  const ρ = Math.hypot(x, y);
  const t = ρ / UPS_RHO_SCALE;
  let φ = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 20; i++) {
    const sinφ = Math.sin(φ);
    const next = Math.PI / 2 - 2 * Math.atan(t * ((1 - E * sinφ) / (1 + E * sinφ)) ** (E / 2));
    const done = Math.abs(next - φ) < 1e-15;
    φ = next;
    if (done) break;
  }
  const north = hemisphere === 'N';
  const λ = ρ === 0 ? 0 : north ? Math.atan2(x, -y) : Math.atan2(x, y);
  return { latitude: (north ? φ : -φ) / DEG, longitude: normalizeLongitude(λ / DEG) };
}

/** `UPS N 2000000mE 1444542mN` — whole metres, truncated. */
export function formatUps(u: UpsCoordinate): string {
  return `UPS ${u.hemisphere} ${Math.floor(u.easting)}mE ${Math.floor(u.northing)}mN`;
}

// --- MGRS -------------------------------------------------------------------------------

/** 100 km column letters, by zone modulo 3 (I and O are never used). */
const COLUMN_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'] as const;
/** 100 km row letters, repeating every 2,000 km; even zones start five letters on. */
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';
const SQUARE = 100_000;
const ROW_CYCLE = 2_000_000;
/**
 * The polar MGRS letters: per band its column letters and the 100 km index of the first, then
 * the row letters and their first index. South of 80° S: A west of 0°, B east; north of 84° N:
 * Y west, Z east.
 */
const POLAR: Readonly<Record<'A' | 'B' | 'Y' | 'Z', { cols: string; col0: number; rows: string; row0: number }>> = {
  A: { cols: 'JKLPQRSTUXYZ', col0: 8, rows: 'ABCDEFGHJKLMNPQRSTUVWXYZ', row0: 8 },
  B: { cols: 'ABCFGHJKLPQR', col0: 20, rows: 'ABCDEFGHJKLMNPQRSTUVWXYZ', row0: 8 },
  Y: { cols: 'RSTUXYZ', col0: 13, rows: 'ABCDEFGHJKLMNP', row0: 13 },
  Z: { cols: 'ABCFGHJ', col0: 20, rows: 'ABCDEFGHJKLMNP', row0: 13 },
};

export interface MgrsReference {
  /** The UTM zone; 0 in the polar caps, which have none. */
  zone: number;
  band: string;
  /** The 100 km square's two letters. */
  square: string;
  /** Digits of easting and of northing within the square: 0 (100 km) to 5 (1 m). */
  digits: number;
  /** Easting and northing within the square, in units of the precision (truncated). */
  easting: number;
  northing: number;
}

/** The MGRS reference of a point to `digits` (0–5) figures each way — UTM's or, beyond 84° N and 80° S, UPS's. */
export function toMgrs(p: { latitude: number; longitude: number }, digits = 5): MgrsReference | undefined {
  if (!Number.isInteger(digits) || digits < 0 || digits > 5) return undefined;
  if (p.latitude >= UTM_NORTH_LIMIT || p.latitude < UTM_SOUTH_LIMIT) return polarMgrs(p, digits);
  const u = toUtm(p);
  if (!u) return undefined;
  const col = Math.floor(u.easting / SQUARE);
  const colLetter = COLUMN_SETS[(u.zone - 1) % 3]![col - 1];
  if (!colLetter) return undefined;
  const rowNumber = Math.floor(u.northing / SQUARE);
  const rowLetter = ROWS[(rowNumber + (u.zone % 2 === 0 ? 5 : 0)) % 20]!;
  const unit = 10 ** (5 - digits);
  return {
    zone: u.zone,
    band: u.band,
    square: colLetter + rowLetter,
    digits,
    easting: Math.floor((u.easting - col * SQUARE) / unit),
    northing: Math.floor((u.northing - rowNumber * SQUARE) / unit),
  };
}

function polarMgrs(p: { latitude: number; longitude: number }, digits: number): MgrsReference | undefined {
  const u = toUps(p);
  if (!u) return undefined;
  const east = u.easting >= UPS_FALSE;
  const band = u.hemisphere === 'N' ? (east ? 'Z' : 'Y') : east ? 'B' : 'A';
  const set = POLAR[band];
  const col = Math.floor(u.easting / SQUARE);
  const row = Math.floor(u.northing / SQUARE);
  const colLetter = set.cols[col - set.col0];
  const rowLetter = set.rows[row - set.row0];
  if (!colLetter || !rowLetter) return undefined;
  const unit = 10 ** (5 - digits);
  return {
    zone: 0,
    band,
    square: colLetter + rowLetter,
    digits,
    easting: Math.floor((u.easting - col * SQUARE) / unit),
    northing: Math.floor((u.northing - row * SQUARE) / unit),
  };
}

/** `4Q FJ 14096 55747`, `Z AB 00000 44542` in the polar caps, or `4Q FJ` for a 100 km square. */
export function formatMgrs(m: MgrsReference): string {
  const head = `${m.zone ? m.zone : ''}${m.band} ${m.square}`;
  if (m.digits === 0) return head;
  return `${head} ${String(m.easting).padStart(m.digits, '0')} ${String(m.northing).padStart(m.digits, '0')}`;
}

export interface ReadGridReference {
  latitude: number;
  longitude: number;
  /** The side of the square the reference names, in metres (1 m for a 10-figure MGRS reference or UTM). */
  precisionM: number;
  /** The reference as written back in standard form. */
  text: string;
}

const MGRS_TEXT = /^(\d{1,2})\s*([C-HJ-NP-X])\s*([A-Z])([A-Z])\s*(\d*)(?:\s+(\d+))?$/i;
const MGRS_POLAR_TEXT = /^([ABYZ])\s*([A-Z])([A-Z])\s*(\d*)(?:\s+(\d+))?$/i;

/** A polar reference (bands A, B, Y, Z): the middle of its square, by UPS. */
function parsePolarMgrs(m: RegExpExecArray): ReadGridReference | { error: string } {
  const band = m[1]!.toUpperCase() as keyof typeof POLAR;
  const colLetter = m[2]!.toUpperCase();
  const rowLetter = m[3]!.toUpperCase();
  const first = m[4] ?? '';
  const second = m[5];
  let text: string;
  if (second !== undefined) {
    if (first.length !== second.length) return { error: 'The easting and northing need the same number of figures.' };
    text = first + second;
  } else {
    if (first.length % 2 !== 0) return { error: 'An MGRS reference needs an even number of figures.' };
    text = first;
  }
  const digits = text.length / 2;
  if (digits > 5) return { error: 'An MGRS reference has at most five figures each way (1 m).' };
  const e = digits ? Number(text.slice(0, digits)) : 0;
  const n = digits ? Number(text.slice(digits)) : 0;
  const unit = 10 ** (5 - digits);
  const set = POLAR[band];
  const col = set.cols.indexOf(colLetter);
  const row = set.rows.indexOf(rowLetter);
  if (col < 0 || row < 0) return { error: `The square ${colLetter}${rowLetter} is not in polar band ${band}.` };
  const easting = (set.col0 + col) * SQUARE + e * unit + unit / 2;
  const northing = (set.row0 + row) * SQUARE + n * unit + unit / 2;
  const p = fromUps(band === 'A' || band === 'B' ? 'S' : 'N', easting, northing)!;
  const written = formatMgrs({ zone: 0, band, square: colLetter + rowLetter, digits, easting: e, northing: n });
  return { ...p, precisionM: unit, text: written };
}

/** MGRS's own northing limits at the polar ends: below 9,500 km in the north, from 1,000 km in the south. */
const MGRS_NORTH_LIMIT_M = 9_500_000;
const MGRS_SOUTH_LIMIT_M = 1_000_000;

/**
 * Whether a 100 km square — its column's eastings, the northings from `base` — reaches into a
 * latitude band. Columns never straddle a central meridian, so the square's latitudes run
 * between those of its corners. Towards the poles the bands C and X run on to MGRS's northing
 * limits, a little past 80° S and 84° N, where the grid overlaps the polar one.
 */
function squareMeetsBand(col: number, base: number, span: { south: number; north: number }): boolean {
  const y0 = base - (span.south < 0 ? FALSE_NORTHING_SOUTH : 0);
  let min = Infinity;
  let max = -Infinity;
  for (const x of [col * SQUARE - FALSE_EASTING, (col + 1) * SQUARE - FALSE_EASTING])
    for (const y of [y0, y0 + SQUARE]) {
      const { latitude } = unproject(x, y);
      min = Math.min(min, latitude);
      max = Math.max(max, latitude);
    }
  if (span.north === UTM_NORTH_LIMIT) return max > span.south && base < MGRS_NORTH_LIMIT_M;
  if (span.south === UTM_SOUTH_LIMIT) return min < span.north && base >= MGRS_SOUTH_LIMIT_M;
  return max > span.south && min < span.north;
}

/**
 * Read an MGRS reference — `4QFJ1234567890`, `4Q FJ 12345 67890`, lowercase or with a leading
 * zero — as the middle of the square it names. A reference whose square letters cannot lie in
 * its zone and latitude band is refused with the reason, as GeographicLib refuses it.
 */
export function parseMgrs(text: string): ReadGridReference | { error: string } | undefined {
  const polar = MGRS_POLAR_TEXT.exec(text.trim());
  if (polar) return parsePolarMgrs(polar);
  const m = MGRS_TEXT.exec(text.trim());
  if (!m) return undefined;
  const zone = Number(m[1]);
  const band = m[2]!.toUpperCase();
  const colLetter = m[3]!.toUpperCase();
  const rowLetter = m[4]!.toUpperCase();
  const first = m[5] ?? '';
  const second = m[6];
  if (zone < 1 || zone > 60) return { error: `There is no UTM zone ${zone}.` };
  let digitsText: string;
  if (second !== undefined) {
    if (first.length !== second.length) return { error: 'The easting and northing need the same number of figures.' };
    digitsText = first + second;
  } else {
    if (first.length % 2 !== 0) return { error: 'An MGRS reference needs an even number of figures.' };
    digitsText = first;
  }
  const digits = digitsText.length / 2;
  if (digits > 5) return { error: 'An MGRS reference has at most five figures each way (1 m).' };
  if (colLetter === 'I' || colLetter === 'O' || rowLetter === 'I' || rowLetter === 'O')
    return { error: 'MGRS square letters never use I or O.' };
  if (!ROWS.includes(rowLetter)) return { error: `${rowLetter} is not an MGRS row letter (A to V).` };
  const col = COLUMN_SETS[(zone - 1) % 3]!.indexOf(colLetter);
  const span = bandLatitudes(band)!;
  if (col < 0) return { error: `The square ${colLetter}${rowLetter} is not in zone ${zone}.` };
  const unit = 10 ** (5 - digits);
  const easting = (col + 1) * SQUARE + (digits ? Number(digitsText.slice(0, digits)) * unit : 0) + unit / 2;
  const withinSquare = (digits ? Number(digitsText.slice(digits)) * unit : 0) + unit / 2;
  const rowInCycle = (ROWS.indexOf(rowLetter) - (zone % 2 === 0 ? 5 : 0) + 20) % 20;
  // The row letter repeats every 2,000 km: take the repetition whose square meets the band.
  let northing: number | undefined;
  for (let base = rowInCycle * SQUARE; base < FALSE_NORTHING_SOUTH; base += ROW_CYCLE) {
    if (squareMeetsBand(col + 1, base, span)) {
      northing = base + withinSquare;
      break;
    }
  }
  if (northing === undefined) return { error: `The square ${colLetter}${rowLetter} is not in zone ${zone}${band}.` };
  const p = fromUtm(zone, span.south < 0 ? 'S' : 'N', easting, northing);
  if (!p) return undefined;
  const written = formatMgrs({
    zone,
    band,
    square: colLetter + rowLetter,
    digits,
    easting: digits ? Number(digitsText.slice(0, digits)) : 0,
    northing: digits ? Number(digitsText.slice(digits)) : 0,
  });
  return { ...p, precisionM: unit, text: written };
}

const UTM_TEXT = /^(\d{1,2})\s*([C-HJ-NP-X])[\s,]+(\d{5,7}(?:\.\d+)?)\s*(?:m?E)?[\s,]+(\d{1,8}(?:\.\d+)?)\s*(?:m?N)?$/i;

/**
 * Read a UTM coordinate — zone, latitude band letter, easting, northing: `4Q 612345 2358765`.
 * The letter is read as a latitude band, and the point must lie in that band (within a
 * degree). N and S are also written for the hemisphere: when the band reading cannot be
 * right the hemisphere one is used, and when both can (S between about 31° and 41° N) the
 * coordinate is refused as ambiguous.
 */
export function parseUtm(text: string): ReadGridReference | { error: string } | undefined {
  const m = UTM_TEXT.exec(text.trim());
  if (!m) return undefined;
  const zone = Number(m[1]);
  const letter = m[2]!.toUpperCase();
  const easting = Number(m[3]);
  const northing = Number(m[4]);
  if (zone < 1 || zone > 60) return { error: `There is no UTM zone ${zone}.` };
  if (!(easting > 0 && easting < 1_000_000)) return { error: 'A UTM easting is between 0 and 1,000,000 m.' };
  if (!(northing >= 0 && northing <= FALSE_NORTHING_SOUTH))
    return { error: 'A UTM northing is between 0 and 10,000,000 m.' };
  const span = bandLatitudes(letter)!;
  const near = (lat: number, s: { south: number; north: number }) => lat >= s.south - 1 && lat <= s.north + 1;
  const asBand = fromUtm(zone, span.south < 0 ? 'S' : 'N', easting, northing);
  const bandFits = !!asBand && near(asBand.latitude, span);
  let point = bandFits ? asBand : undefined;
  let written = `${zone}${letter}`;
  if (letter === 'N' || letter === 'S') {
    const hemisphere = fromUtm(zone, letter, easting, northing);
    const hemisphereFits =
      !!hemisphere &&
      (letter === 'N'
        ? hemisphere.latitude >= 0 && hemisphere.latitude < UTM_NORTH_LIMIT + 1
        : hemisphere.latitude < 0 && hemisphere.latitude >= UTM_SOUTH_LIMIT - 1);
    if (letter === 'S' && bandFits && hemisphereFits)
      return {
        error: `${zone}S could be latitude band S (32°–40° N) or the southern hemisphere; write the band letter, or use MGRS.`,
      };
    if (!point && hemisphereFits) {
      point = hemisphere;
      written = `${zone}${latitudeBand(hemisphere.latitude) ?? letter}`;
    }
  }
  if (!point) return { error: `That UTM coordinate is not in latitude band ${letter} of zone ${zone}.` };
  return { ...point, precisionM: 1, text: `${written} ${Math.floor(easting)}mE ${Math.floor(northing)}mN` };
}

/**
 * What a search must look like to be taken for MGRS: at least one figure each way (a bare `4QFJ`
 * is not). A polar reference (bands A, B, Y, Z) needs six figures or more, or spaces in it:
 * written tight with fewer it is a flight's callsign — `BAW1234` is British Airways 1234, not a
 * square near the South Pole.
 */
const MGRS_SEARCH =
  /^(?:\d{1,2}\s?[C-HJ-NP-X]\s?[A-HJ-NP-Z]{2}\s?(?:\d{2,10}|\d{1,5}\s\d{1,5})|[ABYZ](?:\s?[A-HJ-NP-Z]{2}\s?\d{6,10}|\s?[A-HJ-NP-Z]{2}\s?\d{1,5}\s\d{1,5}|\s[A-HJ-NP-Z]{2}\s?\d{2,10}))$/i;

/**
 * Typed text read as a grid reference, if it is written as one: MGRS with at least one figure
 * each way, or UTM. `error` says why one that looks like a reference cannot be read.
 */
export function readGridReference(
  text: string,
): (ReadGridReference & { kind: 'mgrs' | 'utm' }) | { kind: 'mgrs' | 'utm'; error: string } | undefined {
  const t = text.trim();
  const kind = MGRS_SEARCH.test(t) ? 'mgrs' : 'utm';
  const read = kind === 'mgrs' ? parseMgrs(t) : parseUtm(t);
  return read ? { kind, ...read } : undefined;
}
