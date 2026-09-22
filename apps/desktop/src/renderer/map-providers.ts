import type { MapProviderList } from '@worldview/ipc-contract';
import { defaultBasemapFor, type ResolvedMapProvider } from '@worldview/render-core';

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
export function selectBasemap(
  providers: MapProviderList | null,
  id: string | undefined,
): MapProviderChoice | undefined {
  const entry = providers?.basemaps.find((b) => b.id === id);
  return entry ? toChoice(entry) : undefined;
}

/**
 * The catalog entry for a configured id, descriptor included. `selectBasemap` /
 * `selectTerrain` deliberately narrow to what the UI shows; this is what the renderer
 * needs, and it returns nothing until the runtime's list has arrived so the shell never
 * invents a descriptor for an id it cannot resolve.
 */
export function resolveMapProvider(
  providers: MapProviderList | null,
  kind: 'basemap' | 'terrain',
  id: string | undefined,
): ResolvedMapProvider | undefined {
  if (!providers || !id) return undefined;
  return (kind === 'basemap' ? providers.basemaps : providers.terrains).find((e) => e.id === id);
}

/**
 * The basemap to hand the renderer for `mode`.
 *
 * Settings hold one `basemapId` while the catalog entries are per mode: Natural Earth II is
 * a Cesium imagery stack and 3D-only, the dark PMTiles style is 2D-only, Esri and the XYZ
 * sources serve both. Handing MapLibre a globe-only descriptor makes it fall back to a bare
 * dark canvas and raise an error, so an id the active renderer cannot show resolves to that
 * mode's default instead — the 3D choice is kept, 2D shows something, and neither setting is
 * silently rewritten.
 */
export function basemapForMode(
  providers: MapProviderList | null,
  configuredId: string | undefined,
  mode: '2D' | '3D',
): ResolvedMapProvider | undefined {
  const configured = resolveMapProvider(providers, 'basemap', configuredId);
  if (configured?.modes.includes(mode)) return configured;
  return resolveMapProvider(providers, 'basemap', defaultBasemapFor(mode));
}

export function selectTerrain(
  providers: MapProviderList | null,
  id: string | undefined,
): MapProviderChoice | undefined {
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
  return [
    {
      id: selectedId,
      name: `${selectedId} (configured by the runtime)`,
      attribution: '',
      available: true,
      offlineCapable: false,
    },
    ...choices,
  ];
}
