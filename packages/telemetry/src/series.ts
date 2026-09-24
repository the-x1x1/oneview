import type { JsonValue } from '@worldview/world-model';
import type { TelemetryLimits, TelemetrySeries } from '@worldview/provider-sdk';

/** One reading: epoch milliseconds and the value, as the payload carried it (SI). */
export type ReadingPoint = readonly [t: number, v: number];

export interface ReadingWindow {
  startMs: number;
  endMs: number;
}

/** Points kept per series for the panel (the brief's cap; min/max buckets keep the extremes). */
export const MAX_POINTS_PER_SERIES = 2_000;

/** What a reading is read from: an object as history returns it, or an observation. */
export interface ReadingSource {
  id?: string;
  observedAt: string;
  properties?: Readonly<Record<string, JsonValue>>;
  payload?: Readonly<Record<string, JsonValue>>;
}

/**
 * `payload[key]` over `observedAt` for one object: every finite number inside the window
 * (both ends included), time ascending, one point per instant (the last one read wins).
 * Items with another id are ignored; items without an id are taken as the object's.
 */
export function projectReadings(
  items: Iterable<ReadingSource>,
  objectId: string,
  keys: ReadonlyArray<string>,
  window?: ReadingWindow,
): Map<string, ReadingPoint[]> {
  const byKey = new Map<string, Map<number, number>>(keys.map((k) => [k, new Map()]));
  for (const item of items) {
    if (item.id !== undefined && item.id !== objectId) continue;
    const t = Date.parse(item.observedAt);
    if (!Number.isFinite(t)) continue;
    if (window && (t < window.startMs || t > window.endMs)) continue;
    const values = item.properties ?? item.payload;
    if (!values) continue;
    for (const [key, points] of byKey) {
      const v = values[key];
      if (typeof v === 'number' && Number.isFinite(v)) points.set(t, v);
    }
  }
  const out = new Map<string, ReadingPoint[]>();
  for (const [key, points] of byKey)
    out.set(
      key,
      [...points.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, v] as const),
    );
  return out;
}

/**
 * At most `max` points (`max` is taken as at least 4): split the span into equal buckets
 * and keep each bucket's lowest and highest reading in time order, so a spike survives
 * thinning (the track profile's rule). The first and last points are always kept.
 */
export function downsample(points: ReadonlyArray<ReadingPoint>, max = MAX_POINTS_PER_SERIES): ReadingPoint[] {
  if (points.length <= max) return [...points];
  const limit = Math.max(4, max);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const buckets = Math.floor((limit - 2) / 2);
  const span = last[0] - first[0];
  const out: ReadingPoint[] = [first];
  let lo: ReadingPoint | undefined;
  let hi: ReadingPoint | undefined;
  let current = -1;
  const flush = () => {
    if (!lo || !hi) return;
    if (lo === hi) out.push(lo);
    else if (lo[0] <= hi[0]) out.push(lo, hi);
    else out.push(hi, lo);
  };
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const b = span > 0 ? Math.min(buckets - 1, Math.floor(((p[0] - first[0]) / span) * buckets)) : 0;
    if (b !== current) {
      flush();
      current = b;
      lo = hi = p;
      continue;
    }
    if (p[1] < lo![1]) lo = p;
    if (p[1] > hi![1]) hi = p;
  }
  flush();
  out.push(last);
  return out;
}

/**
 * The spacing past which the line breaks: three times the median spacing between
 * readings, and never less than `floorMs`. A stretch that long without a reading is drawn
 * as a gap, not bridged; a shorter one (a reading or two missed) is joined.
 */
export function gapThreshold(points: ReadonlyArray<ReadingPoint>, floorMs = 60_000): number {
  if (points.length < 3) return Number.POSITIVE_INFINITY;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i]![0] - points[i - 1]![0]);
  gaps.sort((a, b) => a - b);
  return Math.max(floorMs, 3 * gaps[Math.floor(gaps.length / 2)]!);
}

/**
 * The value range a series is drawn over: the descriptor's `min`/`max` where given, the data
 * elsewhere; a flat series gets a band around its value. Undefined without data or range.
 */
export function valueRange(
  points: ReadonlyArray<ReadingPoint>,
  series: Pick<TelemetrySeries, 'min' | 'max'>,
): { min: number; max: number } | undefined {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const [, v] of points) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const fixedLo = series.min !== undefined;
  const fixedHi = series.max !== undefined;
  if (fixedLo) lo = series.min!;
  if (fixedHi) hi = series.max!;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  if (hi > lo) return { min: lo, max: hi };
  // A flat series, or data entirely beyond a one-sided fixed end: a band on the free side.
  const at = fixedLo && !fixedHi ? lo : fixedHi && !fixedLo ? hi : lo;
  const pad = Math.abs(at) > 0 ? Math.abs(at) * 0.05 : 1;
  if (fixedLo && fixedHi) return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
  if (fixedLo) return { min: lo, max: lo + pad };
  if (fixedHi) return { min: hi - pad, max: hi };
  return { min: lo - pad, max: hi + pad };
}

/** The last reading at or before `t`, or undefined. */
export function readingAt(points: ReadonlyArray<ReadingPoint>, t: number): ReadingPoint | undefined {
  let lo = 0;
  let hi = points.length - 1;
  let found: ReadingPoint | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = points[mid]!;
    if (p[0] <= t) {
      found = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * SVG path data for a series in a `width` × `height` box: the window across, `range` up,
 * a new sub-path after every gap wider than `gapMs`. Values outside the range are clamped
 * to its edge, so a fixed range never draws outside the box.
 */
export function readingsPath(
  points: ReadonlyArray<ReadingPoint>,
  range: { min: number; max: number },
  window: ReadingWindow,
  width: number,
  height: number,
  gapMs = Number.POSITIVE_INFINITY,
): string {
  const span = Math.max(1, window.endMs - window.startMs);
  const vSpan = range.max - range.min;
  let d = '';
  let prev: number | undefined;
  for (const [t, v] of points) {
    if (t < window.startMs || t > window.endMs) {
      prev = undefined;
      continue;
    }
    const x = ((t - window.startMs) / span) * width;
    const f = vSpan > 0 ? (Math.min(range.max, Math.max(range.min, v)) - range.min) / vSpan : 0.5;
    const y = height - f * height;
    d += `${prev !== undefined && t - prev <= gapMs ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    prev = t;
  }
  return d;
}

export interface LimitBand {
  kind: 'warn' | 'crit';
  /** Top edge and height in the box's coordinates (y grows downwards). */
  y: number;
  height: number;
}

/**
 * The shaded bands a series' limits make inside the drawn range: warning between the warn
 * and critical limits (or the range's edge), critical beyond the critical limit. Bands that
 * fall outside the range are left out.
 */
export function limitBands(
  limits: TelemetryLimits | undefined,
  range: { min: number; max: number },
  height: number,
): LimitBand[] {
  if (!limits) return [];
  const vSpan = range.max - range.min;
  if (!(vSpan > 0)) return [];
  const yOf = (v: number) => height - ((Math.min(range.max, Math.max(range.min, v)) - range.min) / vSpan) * height;
  const bands: LimitBand[] = [];
  const add = (kind: LimitBand['kind'], from: number, to: number) => {
    const lo = Math.max(range.min, Math.min(from, to));
    const hi = Math.min(range.max, Math.max(from, to));
    if (hi <= lo) return;
    const top = yOf(hi);
    bands.push({ kind, y: top, height: yOf(lo) - top });
  };
  const { warnLow, warnHigh, critLow, critHigh } = limits;
  if (critHigh !== undefined) add('crit', critHigh, range.max);
  if (warnHigh !== undefined) add('warn', warnHigh, critHigh ?? range.max);
  if (critLow !== undefined) add('crit', range.min, critLow);
  if (warnLow !== undefined) add('warn', critLow ?? range.min, warnLow);
  return bands;
}
