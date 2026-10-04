import type { SeverityClass } from './event.js';

/**
 * What a feed entry is worth keeping (roadmap 0.5): its severity, halved for every six hours
 * of age. The engine's feed and the renderer's copy of it are both bounded, and both used to
 * drop the oldest entries first, so on a busy day a few hundred minor marine advisories pushed
 * out a severe warning from the morning before the renderer's relevance ranking ever saw it.
 * Both now drop the entry worth least by this measure, and the renderer ranks with the same
 * weights (plus nearness to the view, which only the renderer knows).
 *
 * Between two entries the comparison does not depend on the time it is made — both halve at
 * the same rate — so the measure is kept as a logarithm, `log2(weight) + hours / 6`, with no
 * clock: the same entries are kept whenever the feed is trimmed.
 *
 *   severity   INFO ½ · MINOR 1 · MODERATE 2 · SEVERE 4 · EXTREME 8
 *   age        halves every six hours (FEED_HALF_LIFE_HOURS)
 *
 * So an EXTREME entry outlasts a MINOR one issued up to eighteen hours after it, and a SEVERE
 * one outlasts a MINOR one from twelve hours later.
 */
export const FEED_SEVERITY_WEIGHT: Readonly<Record<SeverityClass, number>> = Object.freeze({
  INFO: 0.5,
  MINOR: 1,
  MODERATE: 2,
  SEVERE: 4,
  EXTREME: 8,
});

export const FEED_HALF_LIFE_HOURS = 6;

const HALF_LIFE_MS = FEED_HALF_LIFE_HOURS * 3_600_000;

export interface WeighedFeedEntry {
  id: string;
  /** ISO time the entry became news. */
  at: string;
  severity: SeverityClass;
}

/** The entry's weight on a log scale (higher is kept longer). An unreadable time weighs least. */
export function feedRetention(entry: Pick<WeighedFeedEntry, 'at' | 'severity'>): number {
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return Number.NEGATIVE_INFINITY;
  return Math.log2(FEED_SEVERITY_WEIGHT[entry.severity] ?? 1) + at / HALF_LIFE_MS;
}

/** Newest first, then id: the feed's time order. */
export function compareFeedTime(a: WeighedFeedEntry, b: WeighedFeedEntry): number {
  const ta = timeOrLeast(a.at),
    tb = timeOrLeast(b.at);
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function timeOrLeast(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * The `max` entries worth keeping, in time order (newest first). Ties in weight keep the
 * newer, then the lower id, so the result does not depend on the input's order.
 */
export function keepWeightiest<T extends WeighedFeedEntry>(entries: readonly T[], max: number): T[] {
  const n = Math.max(0, Math.floor(max));
  if (entries.length <= n) return [...entries].sort(compareFeedTime);
  const kept = entries
    .map((entry) => ({ entry, weight: feedRetention(entry) }))
    .sort((a, b) => (a.weight === b.weight ? compareFeedTime(a.entry, b.entry) : b.weight > a.weight ? 1 : -1))
    .slice(0, n)
    .map((x) => x.entry);
  return kept.sort(compareFeedTime);
}
