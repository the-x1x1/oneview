/**
 * Display formatters. Pure; tested. Units follow the domain convention (aviation: ft/kt,
 * maritime: kt, ground: km/h) — callers pick the unit set; nothing is hidden behind
 * "auto" guesses.
 */
const M_TO_FT = 3.280839895;
const MPS_TO_KT = 1.943844492;
const MPS_TO_KMH = 3.6;

/** "12s", "8m", "23m", "3h", "2d" — never more precise than the data warrants. */
export function formatRelativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'unknown';
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 24) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** "12s ago" for an ISO timestamp against `nowMs`; `unknown` for invalid input. */
export function formatAgo(iso: string | undefined, nowMs: number): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  return `${formatRelativeAge(nowMs - t)} ago`;
}

/** Duration "1h 05m", "3m 20s", "45s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${String(rm).padStart(2, '0')}m`;
}

export function formatUtcTime(ms: number, withSeconds = true): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return d.toISOString().slice(11, withSeconds ? 19 : 16);
}

export function formatUtcDateTime(iso: string | number | undefined): string {
  if (iso === undefined) return 'unknown';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

export type AltitudeUnit = 'ft' | 'm';
export function formatAltitude(altitudeM: number | undefined, unit: AltitudeUnit = 'ft'): string | undefined {
  if (altitudeM === undefined || !Number.isFinite(altitudeM)) return undefined;
  if (unit === 'ft') return `${Math.round(altitudeM * M_TO_FT).toLocaleString('en-US')} ft`;
  return `${Math.round(altitudeM).toLocaleString('en-US')} m`;
}

/** Negative altitude for earthquakes is depth. */
export function formatDepthKm(depthKm: number | undefined): string | undefined {
  if (depthKm === undefined || !Number.isFinite(depthKm)) return undefined;
  return `${depthKm.toFixed(depthKm < 10 ? 1 : 0)} km`;
}

export type SpeedUnit = 'kt' | 'km/h' | 'm/s';
export function formatSpeed(speedMps: number | undefined, unit: SpeedUnit = 'kt'): string | undefined {
  if (speedMps === undefined || !Number.isFinite(speedMps)) return undefined;
  switch (unit) {
    case 'kt': return `${Math.round(speedMps * MPS_TO_KT)} kt`;
    case 'km/h': return `${Math.round(speedMps * MPS_TO_KMH)} km/h`;
    case 'm/s': return `${speedMps.toFixed(1)} m/s`;
  }
}

export function formatVerticalRate(vsMps: number | undefined): string | undefined {
  if (vsMps === undefined || !Number.isFinite(vsMps)) return undefined;
  const fpm = Math.round(vsMps * M_TO_FT * 60);
  return `${fpm > 0 ? '+' : ''}${fpm.toLocaleString('en-US')} ft/min`;
}

export function formatHeading(deg: number | undefined): string | undefined {
  if (deg === undefined || !Number.isFinite(deg)) return undefined;
  const d = ((Math.round(deg) % 360) + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${String(d).padStart(3, '0')}° ${dirs[Math.round(d / 45) % 8]}`;
}

/** "19.4067° N, 155.2833° W" (4 decimals ≈ 11 m). */
export function formatCoordinates(lat: number, lon: number, decimals = 4): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'unknown';
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(decimals)}° ${ns}, ${Math.abs(lon).toFixed(decimals)}° ${ew}`;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return 'unknown';
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 100_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000).toLocaleString('en-US')} km`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatMagnitude(mag: number | undefined, magType?: string | undefined): string | undefined {
  if (mag === undefined || !Number.isFinite(mag)) return undefined;
  return `M ${mag.toFixed(1)}${magType ? ` ${magType}` : ''}`;
}

export function formatPercent(v: number | undefined, decimals = 0): string | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  return `${(v * 100).toFixed(decimals)}%`;
}

/** Human label for object types ("fire-detection" → "Fire detection"). */
export function formatObjectType(type: string): string {
  const s = type.replace(/[-_]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
