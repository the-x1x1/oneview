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

export function rankFeed(items: readonly FeedItem[], nowMs: number, center: GeoPosition | undefined): FeedItem[] {
  const scored = items.map((item) => ({ item, score: relevance(item, nowMs, center) }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.at.localeCompare(a.item.at) ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return scored.map((s) => s.item);
}
