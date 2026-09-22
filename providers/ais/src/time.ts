import type { IsoTimestamp } from '@worldview/world-model';

/**
 * Tolerant parser for AISStream `MetaData.time_utc`. Observed shapes (Go `time.Time.String()`
 * and friends):
 *   "2026-09-21 08:00:03.123456789 +0000 UTC"
 *   "2026-09-21 08:00:03 +0000 UTC"
 *   "2026-09-21 08:00:03.5 +0000 +0000"
 *   "2026-09-21T08:00:03Z" / "2026-09-21T08:00:03.123+02:00"
 * Fractional seconds beyond milliseconds are truncated. Epoch numbers (seconds or ms) are
 * accepted too. Anything else → undefined (caller decides the fallback).
 */
const TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|UTC|[+-]\d{2}:?\d{2})?(?:\s+(?:UTC|GMT|[+-]\d{4}|m=[+-][\d.]+))*$/i;

const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

export function parseAisTimestamp(value: unknown): IsoTimestamp | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const ms = value < 1e11 ? value * 1000 : value;
    return inRange(ms) ? new Date(Math.floor(ms)).toISOString() : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const m = TEXT.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const year = Number(y),
    month = Number(mo),
    day = Number(d),
    hour = Number(h),
    minute = Number(mi),
    second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return undefined;
  const millis = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  let ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  // Reject impossible dates that Date.UTC would silently roll over (e.g. Feb 30).
  const check = new Date(ms);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  if (zone && zone.toUpperCase() !== 'Z' && zone.toUpperCase() !== 'UTC') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    ms -= offsetMin * 60_000;
  }
  return inRange(ms) ? new Date(ms).toISOString() : undefined;
}

function inRange(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_MS && ms < MAX_MS;
}
