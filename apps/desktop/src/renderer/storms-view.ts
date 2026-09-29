import type { WorldObject } from '@worldview/world-model';
import { cycloneOf, cycloneRank, tornadoWarningRank } from '@worldview/render-core';
import { OVERVIEW_LAYERS, TYPE_LAYER_PREFIX, type OverviewLayer } from './overview-layers.js';

/**
 * The Storms quick view (command palette): the Overview reduced to its weather and hazard
 * layers, and the camera taken to the worst thing in them. Pure, for tests; the action in
 * store/actions.ts applies it with the same hidden-layers and select-and-fly machinery as
 * "Show only …" and a feed click.
 */

/** The Overview layers the view keeps: Weather (alerts, storms, stations) and Disasters (quakes, fires, storms). */
export const STORMS_VIEW_LAYERS: readonly string[] = Object.freeze(['weather', 'disasters']);

/**
 * The hidden list for the view: every other category off, the two on, and any single type
 * of theirs that was switched off on its own (`type.storm`) back on — a storm view without
 * storms would be no view at all. Other entries (other categories' types, the opt-in
 * children) are kept as they were.
 */
export function stormsViewHidden(
  hidden: readonly string[],
  layers: readonly OverviewLayer[] = OVERVIEW_LAYERS,
): string[] {
  const categories = new Set(layers.map((l) => l.id));
  const kept = new Set(STORMS_VIEW_LAYERS);
  const types = new Set(layers.filter((l) => kept.has(l.id)).flatMap((l) => l.objectTypes));
  const rest = hidden.filter(
    (h) => !categories.has(h) && !(h.startsWith(TYPE_LAYER_PREFIX) && types.has(h.slice(TYPE_LAYER_PREFIX.length))),
  );
  return [...rest, ...layers.filter((l) => !kept.has(l.id)).map((l) => l.id)];
}

/** Severity as the event engine reads it (event-engine severity.ts payloadSeverity): a CAP word or a GDACS score. */
export function severityRank(value: unknown): number {
  if (typeof value === 'number') return value >= 4 ? 4 : value >= 3 ? 3 : value >= 2 ? 2 : value >= 1 ? 1 : 0;
  if (typeof value !== 'string') return 0;
  return { EXTREME: 4, SEVERE: 3, MODERATE: 2, MINOR: 1 }[value.trim().toUpperCase()] ?? 0;
}

export interface StormsTarget {
  object: WorldObject;
  /** Why it was chosen: a major hurricane, a tornado warning, or the worst alert. */
  reason: 'major-cyclone' | 'tornado-warning' | 'alert';
}

const newer = (a: WorldObject, b: WorldObject) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0);
const byId = (a: WorldObject, b: WorldObject) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The item to fly to, in this order:
 *
 *   1. a Category 3 or stronger tropical cyclone (NHC's, or a GDACS equivalent) — the
 *      strongest by wind, NHC's before GDACS's at the same wind;
 *   2. else a tornado warning — an emergency before a PDS warning before a plain one, then
 *      the newest;
 *   3. else the alert of highest severity (a weaker cyclone counts at the severity the storm
 *      event gives it: a depression MINOR, a tropical storm MODERATE, a hurricane SEVERE),
 *      then the newest.
 *
 * Undefined when there is nothing: no storm and no alert with a severity. Deterministic: last
 * ties by id.
 */
export function stormsTarget(objects: Iterable<WorldObject>): StormsTarget | undefined {
  const cyclones: Array<{ o: WorldObject; kt: number; nhc: boolean }> = [];
  const tornadoes: Array<{ o: WorldObject; rank: number }> = [];
  const alerts: Array<{ o: WorldObject; rank: number }> = [];
  for (const o of objects) {
    const c = cycloneOf(o);
    if (c?.role === 'current' && !c.post && c.category) {
      if (cycloneRank(c.category) >= cycloneRank('cat3')) cyclones.push({ o, kt: c.kt ?? 0, nhc: o.type === 'storm' });
      else alerts.push({ o, rank: c.category === 'td' ? 1 : c.category === 'ts' ? 2 : 3 });
      continue;
    }
    const tornado = tornadoWarningRank(o);
    if (tornado) {
      tornadoes.push({ o, rank: tornado });
      continue;
    }
    if (o.type !== 'weather-alert' || c) continue;
    const rank = severityRank(o.properties['severity']);
    if (rank > 0) alerts.push({ o, rank });
  }
  cyclones.sort((a, b) => b.kt - a.kt || Number(b.nhc) - Number(a.nhc) || byId(a.o, b.o));
  if (cyclones[0]) return { object: cyclones[0].o, reason: 'major-cyclone' };
  tornadoes.sort((a, b) => b.rank - a.rank || newer(a.o, b.o) || byId(a.o, b.o));
  if (tornadoes[0]) return { object: tornadoes[0].o, reason: 'tornado-warning' };
  alerts.sort((a, b) => b.rank - a.rank || newer(a.o, b.o) || byId(a.o, b.o));
  return alerts[0] ? { object: alerts[0].o, reason: 'alert' } : undefined;
}
