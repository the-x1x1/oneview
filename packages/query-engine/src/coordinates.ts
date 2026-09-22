/**
 * Coordinate parsing for the search box. Strict by design: a search that guesses is
 * worse than one that declines, because it flies the user somewhere they did not ask
 * for while looking like a success.
 *
 * Decimal degrees: "21.3, -157.9", "21.3 -157.9", "N 21.3 W 157.9", "21.3°N 157.9°W".
 * DMS (basic):     "21°18'25\"N 157°51'30\"W", "21 18 25 N, 157 51 30 W".
 * MGRS / UTM grid references are recognised but not converted (no datum tables shipped);
 * the parser returns `{ kind: 'unsupported', note }` so the UI can say so.
 *
 * Adapted from gods-eye-view src/search/coordinateParser.js (MIT) — decimal component rules.
 */
export interface ParsedCoordinate {
  kind: 'decimal' | 'dms';
  latitude: number;
  longitude: number;
  label: string;
}

export interface UnsupportedCoordinate {
  kind: 'unsupported';
  note: string;
}

const DECIMAL_COMPONENT = /^([NSEW])?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*°?\s*([NSEW])?$/i;
const LAT_LETTERS = new Set(['N', 'S']);

interface Component {
  value: number;
  axis: 'lat' | 'lon' | null;
}

function readDecimal(text: string): Component | undefined {
  const m = DECIMAL_COMPONENT.exec(text.trim());
  if (!m) return undefined;
  const [, before, digits, after] = m;
  if (before && after) return undefined;
  const letter = (before ?? after ?? '').toUpperCase();
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  if (letter && /^[+-]/.test(digits ?? '')) return undefined;
  if (!letter) return { value, axis: null };
  const magnitude = Math.abs(value);
  return {
    value: letter === 'S' || letter === 'W' ? -magnitude : magnitude,
    axis: LAT_LETTERS.has(letter) ? 'lat' : 'lon',
  };
}

/** 21°18'25"N or 21 18 25 N or 21°18.5'N — degrees, optional minutes, optional seconds, mandatory hemisphere letter. */
const DMS_COMPONENT =
  /^(\d{1,3})\s*(?:°|\s)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:['′]|\s)?\s*(\d{1,2}(?:\.\d+)?)?\s*(?:["″])?\s*([NSEW])$|^([NSEW])\s*(\d{1,3})\s*(?:°|\s)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:['′]|\s)?\s*(\d{1,2}(?:\.\d+)?)?\s*(?:["″])?$/i;

function readDms(text: string): Component | undefined {
  const m = DMS_COMPONENT.exec(text.trim());
  if (!m) return undefined;
  const deg = Number(m[1] ?? m[6]);
  const min = Number(m[2] ?? m[7] ?? 0);
  const sec = Number(m[3] ?? m[8] ?? 0);
  const letter = (m[4] ?? m[5] ?? '').toUpperCase();
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec) || min >= 60 || sec >= 60)
    return undefined;
  const magnitude = deg + min / 60 + sec / 3600;
  return {
    value: letter === 'S' || letter === 'W' ? -magnitude : magnitude,
    axis: LAT_LETTERS.has(letter) ? 'lat' : 'lon',
  };
}

/** Candidate (first, second) splits: on a comma/semicolon when present, otherwise at each whitespace gap. */
function splitCandidates(text: string): Array<[string, string]> {
  const t = text.trim();
  if (!t) return [];
  if (/[,;]/.test(t)) {
    const parts = t
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length === 2 ? [[parts[0]!, parts[1]!]] : [];
  }
  const words = t.split(/\s+/);
  const out: Array<[string, string]> = [];
  for (let i = 1; i < words.length; i++) out.push([words.slice(0, i).join(' '), words.slice(i).join(' ')]);
  return out;
}

export function formatCoordinateLabel(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}

const MGRS_RE = /^\d{1,2}\s?[C-HJ-NP-X]\s?[A-HJ-NP-Z]{2}\s?(\d{2,10}|\d{1,5}\s\d{1,5})$/i;
const UTM_RE = /^\d{1,2}\s?[C-HJ-NP-X]\s+\d{5,7}(\.\d+)?\s+\d{6,7}(\.\d+)?$/i;

export function parseCoordinates(text: string): ParsedCoordinate | UnsupportedCoordinate | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (MGRS_RE.test(t))
    return { kind: 'unsupported', note: 'MGRS grid references are not supported; enter decimal degrees or DMS.' };
  if (UTM_RE.test(t))
    return { kind: 'unsupported', note: 'UTM coordinates are not supported; enter decimal degrees or DMS.' };
  for (const pair of splitCandidates(t)) {
    const dms = [readDms(pair[0]), readDms(pair[1])] as const;
    if (dms[0] && dms[1]) return assemble(dms[0], dms[1], 'dms');
    const dec = [readDecimal(pair[0]), readDecimal(pair[1])] as const;
    if (dec[0] && dec[1]) return assemble(dec[0], dec[1], 'decimal');
  }
  return undefined;
}

function assemble(first: Component, second: Component, kind: 'decimal' | 'dms'): ParsedCoordinate | undefined {
  if (first.axis && first.axis === second.axis) return undefined;
  let lat: number, lon: number;
  if (first.axis === 'lon' || second.axis === 'lat') {
    lat = second.value;
    lon = first.value;
  } else {
    lat = first.value;
    lon = second.value;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180)
    return undefined;
  return { kind, latitude: lat, longitude: lon, label: formatCoordinateLabel(lat, lon) };
}
