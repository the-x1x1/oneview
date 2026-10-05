import type { GeoPosition, JsonValue, WorldObject } from '@worldview/world-model';
import { lookAngles, MMSI_STATION_KIND_TEXT, mmsiFlag, type MmsiStationKind } from '@worldview/world-model';
import { formatDuration, formatUtcDateTime, formatUtcTime } from '@worldview/ui';

/**
 * What the context panel says about a satellite's catalogue record and passes, a ship's
 * broadcast voyage data and an earthquake's USGS summary — the words, kept out of the React
 * sections so they can be tested. Every function returns undefined for what the object does
 * not carry, so no empty rows render.
 */
export interface Row {
  label: string;
  value: string | undefined;
  mono?: boolean;
}

type Props = Readonly<Record<string, JsonValue>>;

function n(p: Props, key: string): number | undefined {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function s(p: Props, key: string): string | undefined {
  const v = p[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "NNE" for 22°. */
export function compassPoint(deg: number): string {
  return COMPASS_16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

/** "20 Nov 1998" for an ISO date (no time), or the text as given when it is not one. */
export function formatDay(isoDate: string): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return isoDate;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// ---- satellites ------------------------------------------------------------------------

/** The catalogue rows (CelesTrak SATCAT) and the orbit class from a `world.details` answer. */
export function satcatRows(p: Props): Row[] {
  const owner = s(p, 'owner');
  const ownerName = s(p, 'ownerName');
  const launch = s(p, 'launchDate');
  const site = s(p, 'launchSite');
  const siteName = s(p, 'launchSiteName');
  const decay = s(p, 'decayDate');
  const rcs = n(p, 'rcsM2');
  const docked = n(p, 'dockedTo');
  const status = s(p, 'opsStatusText');
  const orbitType = s(p, 'orbitTypeText');
  return [
    { label: 'Object type', value: s(p, 'objectTypeText') },
    {
      label: 'Owner / country',
      value: ownerName ? `${ownerName}${owner ? ` (${owner})` : ''}` : owner,
    },
    { label: 'Launched', value: launch ? formatDay(launch) : undefined },
    { label: 'Launch site', value: siteName ? `${siteName}${site ? ` (${site})` : ''}` : site },
    { label: 'Status', value: status },
    {
      label: 'Decayed',
      value: decay ? `${formatDay(decay)} — re-entered; no longer in orbit` : undefined,
    },
    {
      label: 'Orbit class',
      value: s(p, 'orbitClassText')
        ? `${s(p, 'orbitClassText')}${p['geostationary'] === true ? ', geostationary' : ''}`
        : undefined,
    },
    { label: 'Orbit', value: orbitType && orbitType !== 'In orbit' ? orbitType : undefined },
    { label: 'Docked to', value: docked !== undefined ? `NORAD ${docked}` : undefined, mono: true },
    { label: 'Radar cross-section', value: rcs !== undefined ? `${rcs.toFixed(rcs < 1 ? 2 : 1)} m²` : undefined },
    { label: 'Elements', value: s(p, 'dataStatusText') },
  ];
}

/** What the panel says when the catalogue has no record, or could not be asked. */
export function satcatStatusNote(p: Props): string | undefined {
  switch (p['satcatStatus']) {
    case 'not-listed':
      return 'CelesTrak’s catalogue has no record for this number.';
    case 'unavailable':
      return 'The catalogue record could not be read just now (offline, or CelesTrak is not answering). It is asked for again when the satellite is next selected.';
    default:
      return undefined;
  }
}

export interface PassView {
  /** "2026-09-27 22:51:53 UTC · in 3h 10m", or "In view now · sets in 2m 05s". */
  when: string;
  /** "48° max" */
  peak: string;
  /** "rises WSW, highest SSE, sets NE" */
  path: string;
  /** "3m 40s above 10°" */
  duration?: string;
  /**
   * "Visible to the eye 00:25:44–00:29:44 UTC", or "Not visible to the eye: in daylight or in
   * the Earth's shadow"; undefined when the answer did not work it out.
   */
  visibility?: string;
}

interface PassJson {
  riseAt?: string;
  riseAzimuthDeg?: number;
  culminationAt: string;
  culminationAzimuthDeg: number;
  maxElevationDeg: number;
  setAt?: string;
  setAzimuthDeg?: number;
  visibleFrom?: string;
  visibleUntil?: string;
}

function asPass(v: JsonValue): PassJson | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, JsonValue>;
  if (typeof o['culminationAt'] !== 'string' || typeof o['maxElevationDeg'] !== 'number') return undefined;
  return o as unknown as PassJson;
}

/** The passes of a `world.details` answer as rows, in time order; passes already over are left out. */
export function passViews(p: Props, nowMs: number): PassView[] | undefined {
  const raw = p['passes'];
  if (!Array.isArray(raw)) return undefined;
  const min = n(p, 'passMinElevationDeg') ?? 10;
  const out: PassView[] = [];
  for (const item of raw) {
    const pass = asPass(item);
    if (!pass) continue;
    const setMs = pass.setAt ? Date.parse(pass.setAt) : undefined;
    if (setMs !== undefined && setMs < nowMs) continue;
    const riseMs = pass.riseAt ? Date.parse(pass.riseAt) : undefined;
    const inView = riseMs === undefined || riseMs <= nowMs;
    const when = inView
      ? `In view now${setMs !== undefined ? ` · sets in ${formatDuration(setMs - nowMs)}` : ''}`
      : `${formatUtcDateTime(pass.riseAt!)} · in ${formatDuration(riseMs - nowMs)}`;
    const parts = [
      pass.riseAzimuthDeg !== undefined && !inView ? `rises ${compassPoint(pass.riseAzimuthDeg)}` : undefined,
      `highest ${compassPoint(pass.culminationAzimuthDeg)} at ${formatUtcTime(Date.parse(pass.culminationAt))}`,
      pass.setAzimuthDeg !== undefined ? `sets ${compassPoint(pass.setAzimuthDeg)}` : undefined,
    ].filter(Boolean);
    const view: PassView = { when, peak: `${Math.round(pass.maxElevationDeg)}° max`, path: parts.join(', ') };
    if (riseMs !== undefined && setMs !== undefined) view.duration = `${formatDuration(setMs - riseMs)} above ${min}°`;
    if (typeof pass.visibleFrom === 'string' && typeof pass.visibleUntil === 'string')
      view.visibility = `Visible to the eye ${formatUtcTime(Date.parse(pass.visibleFrom))}–${formatUtcTime(Date.parse(pass.visibleUntil))} UTC`;
    else if (typeof p['passDarkSkySunDeg'] === 'number')
      view.visibility = "Not visible to the eye: in daylight or in the Earth's shadow";
    out.push(view);
  }
  return out;
}

/** "Over 40.000° N, 75.000° W, above 10°" — where the passes were computed for. */
export function passObserverText(p: Props, over: 'view' | 'home' = 'view'): string | undefined {
  const o = p['passObserver'];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const lat = (o as Record<string, JsonValue>)['latitude'];
  const lon = (o as Record<string, JsonValue>)['longitude'];
  if (typeof lat !== 'number' || typeof lon !== 'number') return undefined;
  const min = n(p, 'passMinElevationDeg') ?? 10;
  const ns = `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}`;
  const ew = `${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
  const where = over === 'home' ? 'your home view' : 'the middle of the view when asked';
  return `Over ${ns}, ${ew} (${where}), above ${min}° elevation`;
}

/**
 * Where the satellite is in the sky from the passes' observer at its last position — "Now
 * 34° up, bearing 047° NE, 1,120 km away", or "Now below the horizon (12° under it, bearing
 * 210° SSW)". Undefined without an observer or a position with a height.
 */
export function lookNowText(p: Props, satellite: GeoPosition | undefined): string | undefined {
  const o = p['passObserver'];
  if (!o || typeof o !== 'object' || Array.isArray(o) || !satellite || satellite.altitudeM === undefined)
    return undefined;
  const lat = (o as Record<string, JsonValue>)['latitude'];
  const lon = (o as Record<string, JsonValue>)['longitude'];
  if (typeof lat !== 'number' || typeof lon !== 'number') return undefined;
  const look = lookAngles({ latitude: lat, longitude: lon }, satellite);
  const bearing = `bearing ${String(Math.round(look.azimuthDeg) % 360).padStart(3, '0')}° ${compassPoint(look.azimuthDeg)}`;
  const km = Math.round(look.rangeM / 1000).toLocaleString('en-US');
  if (look.elevationDeg < 0)
    return `Now below the horizon from there (${Math.round(-look.elevationDeg)}° under it, ${bearing}).`;
  return `Now ${Math.round(look.elevationDeg)}° up from there, ${bearing}, ${km} km away.`;
}

/** The sentence under the passes when there are none to list. */
export function noPassesText(p: Props): string | undefined {
  if (p['passesAlwaysAbove'] === true) return 'Always above the horizon from here — it does not rise or set.';
  const raw = p['passes'];
  if (!Array.isArray(raw) || raw.length) return undefined;
  const until = s(p, 'passesSearchedUntil');
  return `No pass above ${n(p, 'passMinElevationDeg') ?? 10}° from here${until ? ` before ${formatUtcDateTime(until)}` : ''}.`;
}

// ---- vessels ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An AIS ETA as the crew entered it: month, day and (when given) hour and minute, UTC. AIS
 * carries no year and the panel does not invent one. Accepts the `{month, day, hour, minute}`
 * object both AIS providers write, or an ISO timestamp from a source that sends one.
 */
export function formatVoyageEta(v: JsonValue | undefined): string | undefined {
  if (typeof v === 'string') return Number.isFinite(Date.parse(v)) ? formatUtcDateTime(v) : undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, JsonValue>;
  const month = o['month'];
  const day = o['day'];
  if (typeof month !== 'number' || month < 1 || month > 12 || typeof day !== 'number' || day < 1 || day > 31)
    return undefined;
  const hour = typeof o['hour'] === 'number' && o['hour'] <= 23 ? o['hour'] : undefined;
  const minute = typeof o['minute'] === 'number' && o['minute'] <= 59 ? o['minute'] : undefined;
  const time =
    hour !== undefined ? ` ${String(hour).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')} UTC` : '';
  return `${day} ${MONTHS[month - 1]}${time}`;
}

/** "Netherlands (MID 244)", from the provider's fields or, for an older record, the MMSI itself. */
export function vesselFlag(o: WorldObject): { flag?: string; kind?: MmsiStationKind } {
  const p = o.properties;
  const flag = s(p, 'flag');
  const mid = s(p, 'flagMid');
  const kindRaw = s(p, 'mmsiKind');
  const kind = kindRaw && kindRaw in MMSI_STATION_KIND_TEXT ? (kindRaw as MmsiStationKind) : undefined;
  if (flag) return { flag: `${flag}${mid ? ` (MID ${mid})` : ''}`, ...(kind ? { kind } : {}) };
  const mmsi = s(p, 'mmsi') ?? o.id.split(':')[2];
  const f = mmsi ? mmsiFlag(mmsi) : undefined;
  if (!f) return {};
  return {
    ...(f.country ? { flag: `${f.country} (MID ${f.mid})` } : {}),
    ...(f.kind !== 'ship' ? { kind: f.kind } : {}),
  };
}

/**
 * The vessel rows. Everything a ship says about itself in AIS static and voyage messages is
 * typed in by its crew (destination, ETA, draught) or at installation (type, size, call sign,
 * IMO, and the MMSI the flag is read from), so those rows say "as broadcast": it is what the
 * ship claims, not a checked record.
 */
export function vesselRows(o: WorldObject): Row[] {
  const p = o.properties;
  const length = n(p, 'lengthM');
  const beam = n(p, 'beamM');
  const draught = n(p, 'draughtM');
  const imo = s(p, 'imo') ?? (n(p, 'imo') !== undefined ? String(n(p, 'imo')) : undefined);
  const shipType = s(p, 'shipTypeText') ?? s(p, 'shipType');
  const code = n(p, 'shipType');
  const nav = s(p, 'navStatusText') ?? s(p, 'navStatus');
  const { flag, kind } = vesselFlag(o);
  return [
    { label: 'MMSI', value: s(p, 'mmsi') ?? o.id.split(':')[2], mono: true },
    { label: 'Station', value: kind ? MMSI_STATION_KIND_TEXT[kind] : undefined },
    { label: 'Flag (from MMSI)', value: flag },
    { label: 'Name', value: o.labels['name'] ?? s(p, 'name') },
    { label: 'IMO (as broadcast)', value: imo, mono: true },
    { label: 'Call sign (as broadcast)', value: s(p, 'callSign'), mono: true },
    {
      label: 'Ship type (as broadcast)',
      value: shipType
        ? `${shipType.charAt(0).toUpperCase()}${shipType.slice(1)}${code !== undefined ? ` (${code})` : ''}`
        : undefined,
    },
    { label: 'Navigation status', value: nav ? `${nav.charAt(0).toUpperCase()}${nav.slice(1)}` : undefined },
    { label: 'Destination (as broadcast)', value: s(p, 'destination') },
    { label: 'ETA (as broadcast)', value: formatVoyageEta(p['eta']) },
    {
      label: 'Length × beam (as broadcast)',
      value:
        length !== undefined && beam !== undefined
          ? `${length} m × ${beam} m`
          : length !== undefined
            ? `${length} m long`
            : undefined,
    },
    { label: 'Draught (as broadcast)', value: draught !== undefined ? `${draught.toFixed(1)} m` : undefined },
  ];
}

// ---- earthquakes -----------------------------------------------------------------------

const MAG_TYPE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  mw: 'moment magnitude',
  mww: 'moment magnitude (W-phase)',
  mwc: 'moment magnitude (centroid)',
  mwb: 'moment magnitude (body wave)',
  mwr: 'moment magnitude (regional)',
  ml: 'local magnitude',
  mlg: 'local magnitude (Lg wave)',
  md: 'duration magnitude',
  mb: 'body-wave magnitude',
  mb_lg: 'short-period surface-wave magnitude (Lg)',
  ms: 'surface-wave magnitude',
  mh: 'hand-computed magnitude',
  me: 'energy magnitude',
  mi: 'integrated P-wave magnitude',
  mint: 'intensity magnitude',
  mun: 'unknown magnitude type',
});

/** "M 6.1 mww — moment magnitude (W-phase)". */
export function magnitudeText(mag: number | undefined, magType: string | undefined): string | undefined {
  if (mag === undefined || !Number.isFinite(mag)) return undefined;
  const t = magType?.toLowerCase();
  const words = t ? MAG_TYPE_TEXT[t] : undefined;
  return `M ${mag.toFixed(1)}${t ? ` ${t}` : ''}${words ? ` — ${words}` : ''}`;
}

/**
 * USGS PAGER alert levels: the estimated impact, fatalities and economic losses, that the
 * alert colour stands for (https://earthquake.usgs.gov/data/pager/).
 */
const PAGER_TEXT: Readonly<Record<string, string>> = Object.freeze({
  green: 'Green — no fatalities and little damage expected',
  yellow: 'Yellow — some fatalities (1–99) or local damage (US$1–100 million) possible',
  orange: 'Orange — significant casualties (100–999) or damage (US$100 million–1 billion) likely',
  red: 'Red — high casualties (1,000 or more) or extensive damage (US$1 billion or more) probable',
});

export function pagerText(alert: string | undefined): string | undefined {
  if (!alert) return undefined;
  return PAGER_TEXT[alert.toLowerCase()] ?? alert;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** Modified Mercalli intensity in Roman numerals ("VI"), from USGS's decimal value. */
export function intensityText(v: number | undefined): string | undefined {
  if (v === undefined || !Number.isFinite(v) || v < 1) return undefined;
  return ROMAN[Math.min(12, Math.round(v)) - 1];
}

/** "34 reports · strongest felt intensity IV" (Did You Feel It?). */
export function feltText(felt: number | undefined, cdi: number | undefined): string | undefined {
  if (felt === undefined && cdi === undefined) return undefined;
  const reports = felt !== undefined ? `${felt.toLocaleString('en-US')} report${felt === 1 ? '' : 's'}` : undefined;
  const roman = intensityText(cdi);
  const intensity = roman ? `strongest felt intensity ${roman}` : undefined;
  return [reports, intensity].filter(Boolean).join(' · ') || undefined;
}
