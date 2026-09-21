import type { MapProviderList } from '@worldview/ipc-contract';
import type { ResolvedMapProvider } from '@worldview/render-core';

/**
 * Selectors over `map.providers.list` (ADR-008). The shell holds no catalog of its own:
 * the runtime owns which basemaps and terrains this installation can actually serve, so
 * an entry that needs a credential or an offline pack arrives already marked unavailable
 * with the reason to show.
 *
 * Until the first response lands (`providers` is null) these return nothing and the
 * callers fall back to naming the configured id, rather than inventing a display name.
 */
export interface MapProviderChoice extends Pick<ResolvedMapProvider, 'id' | 'name' | 'attribution' | 'available'> {
  offlineCapable: boolean;
  unavailableReason?: string;
}

function toChoice(entry: ResolvedMapProvider): MapProviderChoice {
  return {
    id: entry.id,
    name: entry.name,
    attribution: entry.attribution,
    available: entry.available,
    offlineCapable: entry.offlineCapable,
    ...(entry.unavailableReason === undefined ? {} : { unavailableReason: entry.unavailableReason }),
  };
}

/** The entry currently selected, or undefined while the list is unknown or the id is not in it. */
export function selectBasemap(providers: MapProviderList | null, id: string | undefined): MapProviderChoice | undefined {
  const entry = providers?.basemaps.find((b) => b.id === id);
  return entry ? toChoice(entry) : undefined;
}

export function selectTerrain(providers: MapProviderList | null, id: string | undefined): MapProviderChoice | undefined {
  const entry = providers?.terrains.find((t) => t.id === id);
  return entry ? toChoice(entry) : undefined;
}

/**
 * Options for a picker. A configured id the runtime did not list is kept as the first
 * option so selecting something else is a deliberate act and the current value is never
 * silently rewritten.
 */
export function basemapChoices(providers: MapProviderList | null, selectedId: string): MapProviderChoice[] {
  return withSelected(providers?.basemaps.map(toChoice) ?? [], selectedId);
}

export function terrainChoices(providers: MapProviderList | null, selectedId: string): MapProviderChoice[] {
  return withSelected(providers?.terrains.map(toChoice) ?? [], selectedId);
}

function withSelected(choices: MapProviderChoice[], selectedId: string): MapProviderChoice[] {
  if (choices.some((c) => c.id === selectedId)) return choices;
  return [{ id: selectedId, name: `${selectedId} (configured by the runtime)`, attribution: '', available: true, offlineCapable: false }, ...choices];
}
