import { BUILT_IN_LENSES, type LensDefinition } from '@worldview/render-core';
import type { SourceHealthEntry } from '@worldview/source-health';

/**
 * The Overview's layers: one per built-in category lens (Aviation, Maritime, Space, …),
 * each switched on or off in the lens rail.
 *
 * Switching one is instant because nothing is fetched: the Overview subscribes to every
 * type all the time, and a layer only decides which of the objects already on hand are
 * presented. A type no layer claims (search places, say) is always shown — hiding every
 * layer must not make something disappear that no switch can bring back — and a type two
 * layers share (airports: Aviation, Transportation, Infrastructure) stays while any of
 * them is on.
 */
export const OVERVIEW_LENS_ID = 'overview';

export interface OverviewLayer {
  id: string;
  name: string;
  objectTypes: readonly string[];
  eventTypes: readonly string[];
}

export const OVERVIEW_LAYERS: readonly OverviewLayer[] = BUILT_IN_LENSES.filter((l) => l.id !== OVERVIEW_LENS_ID).map(
  (l) => ({ id: l.id, name: l.name, objectTypes: l.objectTypes, eventTypes: l.eventTypes }),
);

export interface LensFilter {
  objectTypes: ReadonlySet<string>;
  eventTypes: ReadonlySet<string>;
}

/** What the map shows for `lens`: its own types, or for the Overview, its types less the hidden layers'. */
export function lensFilter(
  lens: LensDefinition,
  hiddenLayers: readonly string[],
  layers: readonly OverviewLayer[] = OVERVIEW_LAYERS,
): LensFilter {
  if (lens.id !== OVERVIEW_LENS_ID || hiddenLayers.length === 0)
    return { objectTypes: new Set(lens.objectTypes), eventTypes: new Set(lens.eventTypes) };
  const shown = layers.filter((l) => !hiddenLayers.includes(l.id));
  const claimed = (pick: (l: OverviewLayer) => readonly string[]) => new Set(layers.flatMap(pick));
  const allowed = (pick: (l: OverviewLayer) => readonly string[]) => new Set(shown.flatMap(pick));
  const keep = (types: readonly string[], pick: (l: OverviewLayer) => readonly string[]) => {
    const c = claimed(pick);
    const a = allowed(pick);
    return new Set(types.filter((t) => !c.has(t) || a.has(t)));
  };
  return {
    objectTypes: keep(lens.objectTypes, (l) => l.objectTypes),
    eventTypes: keep(lens.eventTypes, (l) => l.eventTypes),
  };
}

/** How many of `objects` each layer would show, for the counts beside the switches. */
export function layerCounts(
  objects: Iterable<{ type: string }>,
  layers: readonly OverviewLayer[] = OVERVIEW_LAYERS,
): Record<string, number> {
  const byType = new Map<string, number>();
  for (const o of objects) byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
  return Object.fromEntries(layers.map((l) => [l.id, l.objectTypes.reduce((n, t) => n + (byType.get(t) ?? 0), 0)]));
}

/** The hidden list after switching `id` on or off. */
export function withLayer(hidden: readonly string[], id: string, visible: boolean): string[] {
  const rest = hidden.filter((h) => h !== id);
  return visible ? rest : [...rest, id];
}

/**
 * What the layer's live sources say about what they are showing — adsb.lol covering only a
 * disc around the view centre, say — as `Source: note` lines for the switch beside it.
 * Faults are not notes: a source that is not LIVE is the Sources panel's to report.
 */
export function layerNotes(entries: readonly SourceHealthEntry[], layerId: string): string[] {
  return entries
    .filter((e) => e.enabled && e.categories.includes(layerId) && e.health.status === 'LIVE' && e.health.message)
    .map((e) => `${e.name}: ${e.health.message}`);
}
