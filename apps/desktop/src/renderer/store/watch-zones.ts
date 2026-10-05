import type { EventTypeInfo } from '@worldview/ipc-contract';

/** What a new watch zone listens for when nothing else is said. */
export const DEFAULT_ZONE_EVENT_TYPES: readonly string[] = ['earthquake', 'wildfire-cluster', 'weather-alert'];

/**
 * A new zone's event types: the wanted ones (the lens's, or the defaults) that this
 * installation can raise. A zone created from the Overview used to start with "launch"
 * ticked — no launch source is installed — so it sat there checked and inert. Before the
 * runtime has said what it can raise, the wanted list is kept as is.
 *
 * None of the wanted ones available (the Maritime lens's distress beacons with no ship
 * source on), it falls back to the defaults that are: never to an empty list, which a zone
 * reads as every type there is.
 */
export function zoneEventTypes(
  wanted: readonly string[] | undefined,
  known: readonly EventTypeInfo[] | null | undefined,
): string[] {
  const base = wanted?.length ? wanted : DEFAULT_ZONE_EVENT_TYPES;
  if (!known?.length) return [...base];
  const available = (list: readonly string[]) => list.filter((t) => known.some((k) => k.type === t && k.available));
  const fromWanted = available(base);
  if (fromWanted.length) return fromWanted;
  const fromDefaults = available(DEFAULT_ZONE_EVENT_TYPES);
  return fromDefaults.length ? fromDefaults : [...base];
}
