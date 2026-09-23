import type { EventTypeInfo } from '@worldview/ipc-contract';

/** What a new watch zone listens for when nothing else is said. */
export const DEFAULT_ZONE_EVENT_TYPES: readonly string[] = ['earthquake', 'wildfire-cluster', 'weather-alert'];

/**
 * A new zone's event types: the wanted ones (the lens's, or the defaults) that this
 * installation can raise. A zone created from the Overview used to start with "launch"
 * ticked — no launch source is installed — so it sat there checked and inert. Before the
 * runtime has said what it can raise, the wanted list is kept as is.
 */
export function zoneEventTypes(
  wanted: readonly string[] | undefined,
  known: readonly EventTypeInfo[] | null | undefined,
): string[] {
  const base = wanted?.length ? wanted : DEFAULT_ZONE_EVENT_TYPES;
  if (!known?.length) return [...base];
  return base.filter((t) => known.some((k) => k.type === t && k.available));
}
