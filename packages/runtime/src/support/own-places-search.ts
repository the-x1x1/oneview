import type { Collection, SearchResult, WatchZone } from '@worldview/ipc-contract';
import { StaticGazetteer, normalizePlaceName, type GazetteerEntry } from '@worldview/query-engine';
import { regionBounds } from '@worldview/world-model';

/**
 * The operator's own places in search: the locations kept in collections (by their titles and
 * tags) and the watch zones (by their names). Offline, from what is saved on this computer.
 * A collected place reads "Collected · <collection>", a zone "Watch zone"; scored as a
 * gazetteer place of the same match is, a little ahead, since the operator named it.
 */
export function ownPlaceResults(
  collections: readonly Collection[],
  zones: readonly WatchZone[],
  text: string,
  limit: number,
): SearchResult[] {
  if (!normalizePlaceName(text)) return [];
  const entries: GazetteerEntry[] = [];
  const subtitle = new Map<string, string>();
  for (const c of collections)
    for (const item of c.items) {
      if (!item.position || (item.kind !== 'location' && item.kind !== 'note')) continue;
      const id = `collection:${c.id}:${item.id}`;
      entries.push({
        id,
        name: item.title,
        kind: 'poi',
        position: { latitude: item.position.latitude, longitude: item.position.longitude },
        ...(item.tags?.length ? { aliases: item.tags } : {}),
      });
      subtitle.set(id, `Collected · ${c.name}`);
    }
  const zoneBounds = new Map<string, NonNullable<ReturnType<typeof regionBounds>>>();
  for (const z of zones) {
    const b = regionBounds(z.geometry);
    if (!b) continue;
    const id = `watchzone:${z.id}`;
    entries.push({
      id,
      name: z.name,
      kind: 'poi',
      position: { latitude: (b.north + b.south) / 2, longitude: (b.east + b.west) / 2 },
      bounds: b,
    });
    subtitle.set(id, z.enabled ? 'Watch zone' : 'Watch zone · paused');
    zoneBounds.set(id, b);
  }
  if (!entries.length) return [];
  return new StaticGazetteer(entries, 'own').lookup(text, { limit }).map((hit) => ({
    kind: 'place' as const,
    id: hit.id,
    title: hit.name,
    subtitle: subtitle.get(hit.id) ?? 'Yours',
    position: hit.position,
    ...(zoneBounds.has(hit.id) ? { bounds: zoneBounds.get(hit.id)! } : { zoom: 13 }),
    source: 'local-index' as const,
    score: Math.min(1, 0.55 + 0.45 * hit.score),
  }));
}
