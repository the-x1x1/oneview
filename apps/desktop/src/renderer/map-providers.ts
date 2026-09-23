import type { MapProviderList } from '@worldview/ipc-contract';
import { DEFAULT_TERRAIN_ID, defaultBasemapFor, type ResolvedMapProvider } from '@worldview/render-core';

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
  /** Available with a limit worth saying (offline: only cached tiles). */
  availableNote?: string;
  /** What the disk tile cache may do with it; Settings offers the world preload from this. */
  tileCache?: ResolvedMapProvider['tileCache'];
}

function toChoice(entry: ResolvedMapProvider): MapProviderChoice {
  return {
    id: entry.id,
    name: entry.name,
    attribution: entry.attribution,
    available: entry.available,
    offlineCapable: entry.offlineCapable,
    ...(entry.unavailableReason === undefined ? {} : { unavailableReason: entry.unavailableReason }),
    ...(entry.availableNote === undefined ? {} : { availableNote: entry.availableNote }),
    ...(entry.tileCache === undefined ? {} : { tileCache: entry.tileCache }),
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
 * The basemap to hand the renderer for `mode`, or nothing at all.
 *
 * Settings hold one `basemapId` while catalog entries are per mode: Natural Earth II is a
 * Cesium imagery stack and 3D-only, the dark PMTiles style is 2D-only, Esri and the XYZ
 * sources serve both. And an entry can be listed but unavailable — no credential, no
 * installed pack, no network — with the reason already attached.
 *
 * So: the configured entry if the active renderer can show it and it is available; else
 * that mode's default, on the same conditions; else nothing. "Nothing" matters. The default
 * 2D basemap is a PMTiles pack that a fresh installation does not have, and pushing it
 * anyway costs a ten-second `style.load` timeout and an error toast every time 2D opens,
 * where leaving MapLibre on its own empty dark style costs nothing. The reason stays
 * visible where it belongs, on the entry in Settings.
 *
 * Neither setting is rewritten by any of this. Going offline with Esri selected shows
 * Natural Earth II, and coming back online shows Esri again.
 */
export function basemapForMode(
  providers: MapProviderList | null,
  configuredId: string | undefined,
  mode: '2D' | '3D',
): ResolvedMapProvider | undefined {
  const usable = (e: ResolvedMapProvider | undefined) => (e && e.available && e.modes.includes(mode) ? e : undefined);
  return (
    usable(resolveMapProvider(providers, 'basemap', configuredId)) ??
    usable(resolveMapProvider(providers, 'basemap', defaultBasemapFor(mode)))
  );
}

/**
 * The terrain to hand the 3D renderer: the configured one when it is available, otherwise
 * the ellipsoid. Unlike the basemap there is always a safe answer — the ellipsoid needs no
 * network and no asset — so an unavailable terrain is replaced rather than skipped, which
 * is what lets a network terrain be selected (or one day be the default) without breaking
 * the globe for someone who opens the app offline.
 */
export function terrainFor(
  providers: MapProviderList | null,
  configuredId: string | undefined,
): ResolvedMapProvider | undefined {
  const configured = resolveMapProvider(providers, 'terrain', configuredId);
  if (configured?.available) return configured;
  return resolveMapProvider(providers, 'terrain', DEFAULT_TERRAIN_ID);
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
