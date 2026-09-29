import { haversineMeters, type GeoPosition, type SeverityClass } from '@worldview/world-model';
import type { FeedItem } from '@worldview/ipc-contract';

/**
 * The world feed ranked by relevance rather than recency (roadmap 0.4): how severe, how
 * recent, and how near the part of the world on screen. Newest-first put a minor advisory
 * three states away above a severe warning from an hour ago, and the feed at launch was
 * hundreds of US marine advisories deep whatever the map showed.
 *
 *   severity   INFO ½ · MINOR 1 · MODERATE 2 · SEVERE 4 · EXTREME 8
 *   recency    halves every six hours of age (an item dated ahead counts as now)
 *   proximity  up to ×3 within ~1,000 km of the view centre, fading with distance; an item
 *              with no position is neither favoured nor penalised
 *
 * A tornado warning (or emergency) comes before all of that: it is the one alert that asks
 * for shelter within minutes, and on a busy day it sat below a day-old hurricane warning of
 * the same EXTREME severity nearer the view. Among tornado warnings the score decides. It is
 * recognised by its title — the NWS event name the weather-alert rule titles it with ("Tornado
 * Warning"), since a feed item carries no properties — and a message that cancels one is not
 * one.
 *
 * Deterministic: equal scores fall back to newest first, then id.
 */
const SEVERITY_WEIGHT: Readonly<Record<SeverityClass, number>> = {
  INFO: 0.5,
  MINOR: 1,
  MODERATE: 2,
  SEVERE: 4,
  EXTREME: 8,
};
const HALF_LIFE_H = 6;
const PROXIMITY_KM = 1000;

export function relevance(item: FeedItem, nowMs: number, center: GeoPosition | undefined): number {
  const at = Date.parse(item.at);
  const ageH = Number.isFinite(at) ? Math.max(0, nowMs - at) / 3_600_000 : 24;
  const recency = 0.5 ** (ageH / HALF_LIFE_H);
  let proximity = 1;
  if (center && item.position) {
    const km = haversineMeters(center, item.position) / 1000;
    proximity = 1 + 2 * Math.exp(-km / PROXIMITY_KM);
  }
  return (SEVERITY_WEIGHT[item.severity] ?? 1) * recency * proximity;
}

const TORNADO_WARNING = /\btornado (warning|emergency)\b/i;

/** Whether a feed item is a tornado warning in force (not a watch, not its cancellation). */
export function isTornadoWarning(item: FeedItem): boolean {
  return item.type === 'weather-alert' && TORNADO_WARNING.test(item.title) && !/^cancels\b/i.test(item.subtitle ?? '');
}

export function rankFeed(items: readonly FeedItem[], nowMs: number, center: GeoPosition | undefined): FeedItem[] {
  const scored = items.map((item) => ({
    item,
    tier: isTornadoWarning(item) ? 1 : 0,
    score: relevance(item, nowMs, center),
  }));
  scored.sort(
    (a, b) =>
      b.tier - a.tier ||
      b.score - a.score ||
      b.item.at.localeCompare(a.item.at) ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return scored.map((s) => s.item);
}
