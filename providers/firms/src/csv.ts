/**
 * NASA FIRMS area-CSV parsing — pure functions, no network.
 *
 * Adapted from gods-eye-view src/data/firmsCsv.js (MIT): header-field gate
 * (`isLikelyCsv`), column-index parsing that survives reordering across product
 * versions, unpadded `acq_time` handling and the "HTML/plain-text error is not an
 * empty catalog" distinction. Typed, and rows are rejected with reasons instead of
 * silently skipped.
 *
 * VIIRS header (FIRMS NRT, confirmed 2026-07-16 by GEV):
 *   latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,
 *   instrument,confidence,version,bright_ti5,frp,daynight
 * MODIS uses `brightness`/`bright_t31` and a numeric 0-100 confidence.
 */
export interface FirmsRow {
  latitude: number;
  longitude: number;
  /** Fire radiative power, MW. */
  frp?: number;
  /** Raw confidence cell: 'l' | 'n' | 'h' (VIIRS) or 0-100 (MODIS). */
  confidence: string;
  /** Brightness temperature of the fire channel (I-4 for VIIRS, channel 21/22 for MODIS), Kelvin. */
  brightness?: number;
  /** Background/secondary channel brightness (I-5 or channel 31), Kelvin. */
  brightnessSecondary?: number;
  scan?: number;
  track?: number;
  daynight: string;
  acqDate: string;
  /** Unpadded HHMM as published ("45" = 00:45 UTC). */
  acqTime: string;
  satellite: string;
  instrument: string;
  version: string;
}

export interface ParsedFirmsCsv {
  rows: FirmsRow[];
  /** Data lines seen (valid or not). */
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

const REQUIRED_HEADER_FIELDS = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp'] as const;

/** Upstream errors come back as HTML or plain text ("Invalid MAP_KEY."), never CSV. */
export function isLikelyCsv(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed[0] === '<') return false;
  const nl = trimmed.indexOf('\n');
  const header = (nl === -1 ? trimmed : trimmed.slice(0, nl))
    .trim()
    .toLowerCase()
    .split(',')
    .map((f) => f.trim());
  return REQUIRED_HEADER_FIELDS.every((f) => header.includes(f));
}

/** FIRMS' own error strings that mean "credential problem" rather than "malformed". */
export function isKeyRejection(text: string): boolean {
  return /invalid\s+map_?key|map_?key\s+(is\s+)?(invalid|missing|expired)|exceeded.*transaction/i.test(
    text.slice(0, 500),
  );
}

function num(cell: string | undefined): number | undefined {
  if (cell === undefined || cell === '') return undefined;
  const n = Number(cell);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a FIRMS area CSV body. Non-CSV input → `undefined` (so callers separate "no fires" from "upstream error"). */
export function parseFirmsCsv(text: string): ParsedFirmsCsv | undefined {
  if (!isLikelyCsv(text)) return undefined;
  const lines = text.split('\n');
  let headerIndex = 0;
  while (headerIndex < lines.length && !lines[headerIndex]!.trim()) headerIndex++;
  const header = lines[headerIndex]!.trim()
    .toLowerCase()
    .split(',')
    .map((f) => f.trim());
  const col = new Map(header.map((name, i) => [name, i] as const));
  const idx = (name: string): number | undefined => col.get(name);
  const iLat = idx('latitude')!,
    iLon = idx('longitude')!,
    iFrp = idx('frp')!,
    iConf = idx('confidence')!;
  const iBright = idx('bright_ti4') ?? idx('brightness');
  const iBright2 = idx('bright_ti5') ?? idx('bright_t31');
  const iScan = idx('scan'),
    iTrack = idx('track'),
    iDayNight = idx('daynight');
  const iDate = idx('acq_date')!,
    iTime = idx('acq_time')!,
    iSat = idx('satellite'),
    iInst = idx('instrument'),
    iVer = idx('version');

  const rows: FirmsRow[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  let total = 0;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const index = total++;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < header.length) {
      rejected.push({ index, reason: `truncated row (${parts.length}/${header.length} columns)` });
      continue;
    }
    const latitude = num(parts[iLat]);
    const longitude = num(parts[iLon]);
    if (latitude === undefined || longitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      rejected.push({ index, reason: 'invalid coordinates' });
      continue;
    }
    const acqDate = parts[iDate] ?? '';
    const acqTime = parts[iTime] ?? '';
    if (!Number.isFinite(acquisitionMsUtc(acqDate, acqTime))) {
      rejected.push({ index, reason: `invalid acquisition time ${acqDate} ${acqTime}` });
      continue;
    }
    const row: FirmsRow = {
      latitude,
      longitude,
      confidence: parts[iConf] ?? '',
      daynight: (iDayNight !== undefined ? parts[iDayNight] : '') ?? '',
      acqDate,
      acqTime,
      satellite: (iSat !== undefined ? parts[iSat] : '') ?? '',
      instrument: (iInst !== undefined ? parts[iInst] : '') ?? '',
      version: (iVer !== undefined ? parts[iVer] : '') ?? '',
    };
    const frp = num(parts[iFrp]);
    if (frp !== undefined && frp >= 0) row.frp = frp;
    const brightness = iBright !== undefined ? num(parts[iBright]) : undefined;
    if (brightness !== undefined && brightness > 0) row.brightness = brightness;
    const brightness2 = iBright2 !== undefined ? num(parts[iBright2]) : undefined;
    if (brightness2 !== undefined && brightness2 > 0) row.brightnessSecondary = brightness2;
    const scan = iScan !== undefined ? num(parts[iScan]) : undefined;
    if (scan !== undefined && scan > 0) row.scan = scan;
    const track = iTrack !== undefined ? num(parts[iTrack]) : undefined;
    if (track !== undefined && track > 0) row.track = track;
    rows.push(row);
  }
  return { rows, total, rejected };
}

/** acq_date "YYYY-MM-DD" + unpadded acq_time "HHMM" (UTC) → epoch ms, NaN when unparsable. */
export function acquisitionMsUtc(acqDate: string, acqTime: string | number): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acqDate)) return Number.NaN;
  const t = String(acqTime).trim();
  if (!/^\d{1,4}$/.test(t)) return Number.NaN;
  const hhmm = t.padStart(4, '0');
  const year = Number(acqDate.slice(0, 4)),
    month = Number(acqDate.slice(5, 7)),
    day = Number(acqDate.slice(8, 10));
  const hours = Number(hhmm.slice(0, 2)),
    minutes = Number(hhmm.slice(2, 4));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) return Number.NaN;
  const ms = Date.UTC(year, month - 1, day, hours, minutes);
  // Reject dates that rolled over (e.g. 2026-02-30).
  if (new Date(ms).getUTCDate() !== day) return Number.NaN;
  return ms;
}
