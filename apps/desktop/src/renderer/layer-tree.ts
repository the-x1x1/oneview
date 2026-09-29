import type { GeoBounds, WorldObject } from '@worldview/world-model';
import type { SourceHealthEntry } from '@worldview/source-health';
import { OVERVIEW_LAYERS, typeLayerId, type OverviewLayer } from './overview-layers.js';

/**
 * The layer panel's tree: the Overview's categories (Aviation, Maritime, Space, …) as
 * groups, each object type they show as a layer inside, and under a few layers a child
 * that narrows or adds to it — Aircraft → Military only, Cameras → Live previews.
 *
 * Everything is one list in the settings, `hiddenLayers`, as it always was: a category by
 * its lens id, a type as `type.<objectType>`, a child by its own id. The list says what is
 * hidden, so something added in a later build is on by default. A child that costs
 * something or narrows what is shown is the exception — it has to be off until the
 * operator turns it on — so its id is in the list by default (settings defaults, and
 * migration 007 for a settings file written before it existed) and "on" means taken out.
 * Those are `OPT_IN_LAYER_IDS`, and the "show every layer" switch leaves them as they are.
 *
 * A type that two categories show (airports: Aviation, Transportation, Infrastructure)
 * appears under each with the same switch, because it is the same layer.
 */
export interface LayerChild {
  id: string;
  name: string;
  description: string;
  /** Off until switched on (see above). */
  optIn: boolean;
  /** The objects of the parent's type this child is about, for its count; absent = no count. */
  counts?: (o: WorldObject) => boolean;
}

export interface LayerRow {
  /** `type.<objectType>`. */
  id: string;
  objectType: string;
  name: string;
  children: readonly LayerChild[];
}

export interface LayerGroup {
  id: string;
  name: string;
  layers: readonly LayerRow[];
}

export const MILITARY_ONLY_LAYER_ID = 'aircraft.military-only';
export const CAMERA_PREVIEWS_LAYER_ID = 'camera.previews';
export const OPT_IN_LAYER_IDS: readonly string[] = Object.freeze([MILITARY_ONLY_LAYER_ID, CAMERA_PREVIEWS_LAYER_ID]);

/** Whether an aircraft is flagged military by its source (adsb.lol's database flag). */
export function isMilitary(o: WorldObject): boolean {
  const v = o.properties['military'];
  return v === true || v === 'true';
}

const TYPE_NAMES: Readonly<Record<string, string>> = {
  aircraft: 'Aircraft',
  airport: 'Airports',
  vessel: 'Ships',
  port: 'Ports',
  satellite: 'Satellites',
  launch: 'Launches',
  'imagery-scene': 'Imagery scenes',
  'weather-alert': 'Weather alerts',
  storm: 'Tropical storms',
  'weather-station': 'Weather stations',
  earthquake: 'Earthquakes',
  'fire-detection': 'Fire detections',
  'transit-vehicle': 'Transit vehicles',
  'traffic-segment': 'Road traffic',
  infrastructure: 'Facilities',
  camera: 'Public cameras',
  sensor: 'Sensors',
  place: 'Places',
};

const CHILDREN: Readonly<Record<string, readonly LayerChild[]>> = {
  aircraft: [
    {
      id: MILITARY_ONLY_LAYER_ID,
      name: 'Military only',
      description: 'Only aircraft their source flags as military',
      optIn: true,
      counts: isMilitary,
    },
  ],
  camera: [
    {
      id: CAMERA_PREVIEWS_LAYER_ID,
      name: 'Live previews',
      description: 'Small live pictures above the nearest cameras when zoomed in close',
      optIn: true,
    },
  ],
};

export function typeName(objectType: string): string {
  return TYPE_NAMES[objectType] ?? objectType.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function buildLayerGroups(categories: readonly OverviewLayer[] = OVERVIEW_LAYERS): LayerGroup[] {
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    layers: c.objectTypes.map((t) => ({
      id: typeLayerId(t),
      objectType: t,
      name: typeName(t),
      children: CHILDREN[t] ?? [],
    })),
  }));
}

export const LAYER_GROUPS: readonly LayerGroup[] = buildLayerGroups();

/** Whether a switch is on, given the hidden list (every kind of id reads the same way). */
export function layerOn(hidden: readonly string[], id: string): boolean {
  return !hidden.includes(id);
}

/**
 * Which objects the switches that act on single objects let through, or undefined when
 * none is on — so the map's presentation pass pays nothing for them in the usual case.
 */
export function objectFilter(hidden: readonly string[]): ((o: WorldObject) => boolean) | undefined {
  if (!layerOn(hidden, MILITARY_ONLY_LAYER_ID)) return undefined;
  return (o) => o.type !== 'aircraft' || isMilitary(o);
}

/** The hidden list for "show every layer" / "hide every layer": categories and types, never the opt-in children. */
export function allLayersHidden(hidden: readonly string[], visible: boolean): string[] {
  const optIn = hidden.filter((h) => OPT_IN_LAYER_IDS.includes(h));
  if (visible) return optIn;
  const rest = hidden.filter((h) => !optIn.includes(h));
  return [...new Set([...rest, ...OVERVIEW_LAYERS.map((l) => l.id), ...optIn])];
}

/** The hidden list for "show only this category": every other category off; types and children as they were. */
export function onlyLayerHidden(hidden: readonly string[], id: string): string[] {
  const categories = new Set(OVERVIEW_LAYERS.map((l) => l.id));
  const rest = hidden.filter((h) => !categories.has(h));
  return [...rest, ...OVERVIEW_LAYERS.filter((l) => l.id !== id).map((l) => l.id)];
}

export interface LayerCount {
  /** Objects on hand — the subscription, which reaches past the edges of the view. */
  total: number;
  /** Of those, the ones inside the view's bounds. */
  inView: number;
}

/** Whether a position is inside `bounds`, including bounds that cross the antimeridian (west > east). */
export function inBounds(p: { latitude: number; longitude: number }, b: GeoBounds): boolean {
  if (p.latitude < b.south || p.latitude > b.north) return false;
  const lon = ((((p.longitude + 180) % 360) + 360) % 360) - 180;
  return b.west <= b.east ? lon >= b.west && lon <= b.east : lon >= b.west || lon <= b.east;
}

/**
 * Counts for every row of the tree, by row id: each type, each child that counts, and
 * each group (the types it shows, each object once). Without `bounds` (the whole world in
 * view) everything on hand is in view. One pass over the objects.
 */
export function layerTreeCounts(
  objects: Iterable<WorldObject>,
  bounds: GeoBounds | undefined,
  groups: readonly LayerGroup[] = LAYER_GROUPS,
): Map<string, LayerCount> {
  const byType = new Map<string, LayerCount>();
  const childTests: Array<{ type: string; id: string; test: (o: WorldObject) => boolean }> = [];
  const seen = new Set<string>();
  for (const g of groups)
    for (const l of g.layers)
      for (const c of l.children)
        if (c.counts && !seen.has(c.id)) {
          seen.add(c.id);
          childTests.push({ type: l.objectType, id: c.id, test: c.counts });
        }
  const byChild = new Map<string, LayerCount>(childTests.map((c) => [c.id, { total: 0, inView: 0 }]));
  for (const o of objects) {
    let t = byType.get(o.type);
    if (!t) {
      t = { total: 0, inView: 0 };
      byType.set(o.type, t);
    }
    const visible = !bounds || (o.position ? inBounds(o.position, bounds) : false);
    t.total++;
    if (visible) t.inView++;
    for (const c of childTests) {
      if (c.type !== o.type || !c.test(o)) continue;
      const n = byChild.get(c.id)!;
      n.total++;
      if (visible) n.inView++;
    }
  }
  const out = new Map<string, LayerCount>(byChild);
  for (const g of groups) {
    const sum: LayerCount = { total: 0, inView: 0 };
    for (const l of g.layers) {
      const n = byType.get(l.objectType) ?? { total: 0, inView: 0 };
      out.set(l.id, n);
      sum.total += n.total;
      sum.inView += n.inView;
    }
    out.set(g.id, sum);
  }
  return out;
}

/** 1234 → "1.2k", 1_234_567 → "1.2M": counts that fit a narrow rail. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Sources of a category that cannot run without a key the operator has not given — shown
 * in the panel as "needs key" with a way to the setting, rather than left out, so an
 * empty layer says why it is empty. Whether the source is switched on does not matter:
 * one that is off for want of a key is exactly the one to point at.
 */
export function sourcesNeedingKey(entries: readonly SourceHealthEntry[], categoryId: string): SourceHealthEntry[] {
  return entries.filter(
    (e) =>
      e.categories.includes(categoryId) &&
      e.meta.credentialsRequired.length > 0 &&
      (e.health.status === 'AUTH_REQUIRED' ||
        e.health.credentialState === 'missing' ||
        e.health.credentialState === 'invalid'),
  );
}
