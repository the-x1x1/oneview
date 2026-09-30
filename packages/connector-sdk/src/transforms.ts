import type { JsonValue } from '@worldview/world-model';

/**
 * The transform registry: every conversion a mapping may apply, by name. Each is a pure
 * function of one JSON value to another (or `undefined`, which means "no value" and drops
 * the field). Nothing here can be extended from a definition — a definition names a
 * transform, it never supplies one.
 *
 * Two families take one numeric argument after a colon (`scale:0.3048`, `offset:-273.15`);
 * `timestamp:<pattern>` takes a date pattern. That is the whole extent of parameters.
 */
export type Transform = (value: JsonValue) => JsonValue | undefined;

const num = (v: JsonValue): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
};

const numeric =
  (f: (n: number) => number): Transform =>
  (v) => {
    const n = num(v);
    return n === undefined ? undefined : f(n);
  };

const roundTo = (digits: number) => (n: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** ISO 8601, or the common date-only and space-separated forms, as an ISO instant string. */
function isoTimestamp(v: JsonValue): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v > 1e11 ? v : v * 1000).toISOString() : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  // "2026-09-23 10:00:00" → treat as UTC, as most feeds mean it.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(t) ? t.replace(' ', 'T') + 'Z' : t;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

const ZONED = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})$/;
const MIN_EPOCH_S = 946_684_800; // 2000-01-01: smaller numbers are not a clock
const MAX_EPOCH_S = 4_102_444_800; // 2100-01-01

/**
 * A time as ISO 8601 — or undefined when it cannot be placed without guessing a zone. Unix
 * seconds (a number or a numeric string; milliseconds when too large to be seconds) between
 * 2000 and 2100 and a date-time with `Z` or an offset are read; `2026-09-24 07:12:01` (a
 * device's local time, rtl_433's default) is not, and neither is a date that does not exist.
 *
 * Written by phase `mqtt` for its payload presets (a message from a home broker states its
 * zone or it does not, and a guess would misplace every reading by hours) and promoted here
 * by the refactor pass, so a definition can ask for the same rule as `unambiguousTimestamp`.
 */
export function unambiguousTimestamp(v: unknown): string | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (Number.isFinite(n)) {
    const seconds = n > MAX_EPOCH_S ? n / 1000 : n;
    if (seconds < MIN_EPOCH_S || seconds > MAX_EPOCH_S) return undefined;
    return new Date(Math.round(seconds * 1000)).toISOString();
  }
  if (typeof v !== 'string') return undefined;
  const m = ZONED.exec(v.trim());
  if (!m) return undefined;
  const zone = m[3] === 'Z' ? 'Z' : `${m[3]!.slice(0, 3)}:${m[3]!.slice(-2)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (!Number.isFinite(ms)) return undefined;
  // Date.parse rolls 30 February over into March; a date that does not exist is not a time.
  const [y, mo, d] = m[1]!.split('-').map(Number) as [number, number, number];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  return new Date(ms).toISOString();
}

const epoch =
  (unit: 'seconds' | 'millis'): Transform =>
  (v) => {
    const n = num(v);
    if (n === undefined) return undefined;
    const ms = unit === 'seconds' ? n * 1000 : n;
    if (ms < 0 || ms > 4102444800000) return undefined; // before 1970 or after 2100: not a live timestamp
    return new Date(Math.round(ms)).toISOString();
  };

/**
 * A pattern with the tokens YYYY, MM, DD, HH, mm, ss (and optional Z or ±HH:mm in the
 * string itself); anything else in the pattern must match literally. Without an offset in
 * the value, UTC is assumed.
 */
export function patternTimestamp(pattern: string): Transform {
  const tokens: string[] = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/YYYY|MM|DD|HH|mm|ss|[.*+?^${}()|[\]\\/]/g, (m) => {
        if (['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'].includes(m)) {
          tokens.push(m);
          return m === 'YYYY' ? '(\\d{4})' : '(\\d{2})';
        }
        return '\\' + m;
      }) +
      '(?:\\.\\d+)?\\s*(Z|[+-]\\d{2}:?\\d{2})?$',
  );
  return (v) => {
    if (typeof v !== 'string') return undefined;
    const m = re.exec(v.trim());
    if (!m) return undefined;
    const parts: Record<string, number> = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 };
    tokens.forEach((t, i) => (parts[t] = Number(m[i + 1])));
    let ms = Date.UTC(parts['YYYY']!, parts['MM']! - 1, parts['DD']!, parts['HH']!, parts['mm']!, parts['ss']!);
    const zone = m[tokens.length + 1];
    if (zone && zone !== 'Z') {
      const sign = zone.startsWith('-') ? -1 : 1;
      const hh = Number(zone.slice(1, 3));
      const mi = Number(zone.slice(-2));
      ms -= sign * (hh * 60 + mi) * 60_000;
    }
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  };
}

export const TRANSFORMS: Readonly<Record<string, Transform>> = Object.freeze({
  // Types
  number: (v) => num(v),
  integer: numeric((n) => Math.trunc(n)),
  string: (v) => (v === null || v === undefined ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  boolean: (v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (['true', 'yes', 'y', '1', 'on'].includes(t)) return true;
      if (['false', 'no', 'n', '0', 'off', ''].includes(t)) return false;
    }
    return undefined;
  },
  json: (v) => (v === undefined ? undefined : JSON.stringify(v)),
  // Strings
  trim: (v) => (typeof v === 'string' ? v.trim() : v),
  lowercase: (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  uppercase: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  emptyToNone: (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  // An id may not hold whitespace: "Tstm Wnd Gst" in a composed id becomes "Tstm_Wnd_Gst".
  spacesToUnderscores: (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, '_') : v),
  // Arrays
  first: (v) => (Array.isArray(v) ? v[0] : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  length: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : undefined),
  // Time
  isoTimestamp: (v) => isoTimestamp(v),
  unixSeconds: epoch('seconds'),
  unixMillis: epoch('millis'),
  unambiguousTimestamp: (v) => unambiguousTimestamp(v),
  // Numbers
  abs: numeric(Math.abs),
  negate: numeric((n) => -n),
  round: numeric(Math.round),
  round1: numeric(roundTo(1)),
  round2: numeric(roundTo(2)),
  // Units → SI
  fahrenheitToCelsius: numeric((f) => roundTo(2)(((f - 32) * 5) / 9)),
  celsiusToFahrenheit: numeric((c) => roundTo(2)((c * 9) / 5 + 32)),
  kelvinToCelsius: numeric((k) => roundTo(2)(k - 273.15)),
  knotsToMps: numeric((k) => roundTo(3)(k * 0.514444)),
  mphToMps: numeric((m) => roundTo(3)(m * 0.44704)),
  kmhToMps: numeric((k) => roundTo(3)(k / 3.6)),
  feetToMeters: numeric((f) => roundTo(2)(f * 0.3048)),
  feetPerMinuteToMps: numeric((f) => roundTo(3)(f * 0.00508)),
  milesToMeters: numeric((m) => roundTo(1)(m * 1609.344)),
  nauticalMilesToMeters: numeric((n) => roundTo(1)(n * 1852)),
  kilometersToMeters: numeric((k) => k * 1000),
  inchesHgToHpa: numeric((i) => roundTo(1)(i * 33.8639)),
  paToHpa: numeric((p) => roundTo(1)(p / 100)),
  inchesToMm: numeric((i) => roundTo(2)(i * 25.4)),
  // Geography
  headingDegrees: numeric((d) => ((d % 360) + 360) % 360),
});

/** Resolve a transform by name, including the parametrised forms; undefined for an unknown name. */
export function resolveTransform(name: string): Transform | undefined {
  const direct = TRANSFORMS[name];
  if (direct) return direct;
  const colon = name.indexOf(':');
  if (colon < 0) return undefined;
  const kind = name.slice(0, colon);
  const arg = name.slice(colon + 1);
  if (kind === 'scale' || kind === 'offset') {
    const n = Number(arg);
    if (!Number.isFinite(n) || arg.trim() === '') return undefined;
    return kind === 'scale' ? numeric((v) => v * n) : numeric((v) => v + n);
  }
  if (kind === 'timestamp') {
    if (!/^[\w\s:./,-]{1,64}$/.test(arg) || !/YYYY|MM|DD|HH|mm|ss/.test(arg)) return undefined;
    return patternTimestamp(arg);
  }
  return undefined;
}

export function transformNames(): string[] {
  return [...Object.keys(TRANSFORMS), 'scale:<factor>', 'offset:<amount>', 'timestamp:<pattern>'];
}
