import type { RasterOverlay } from '@worldview/world-model';
import type { LensDefinition } from '@worldview/render-core';
import { OVERVIEW_LENS_ID } from './overview-layers.js';

/**
 * The weather pictures laid over the map — satellite clouds, precipitation, radar, lightning —
 * as switches inside the layer panel's Weather group, so turning Weather off takes them off
 * the map too. Before, they were drawn whatever the panel said: Weather off still left the
 * whole globe under infrared cloud and rain colours.
 *
 * An overlay belongs to one of these by its source's id (the shipped connector definitions
 * name what they are: `gibs-goes-east-infrared`, `gibs-imerg-precipitation`,
 * `nowcoast-radar`, `nowcoast-strike-density`). An overlay that matches none — a basemap
 * from a source, the true-colour imagery the comparison uses, an operator's own WMS — is not
 * weather and no weather switch touches it.
 *
 * The switches write the same hidden list as every other (layer-tree.ts); they are on until
 * switched off.
 */
export interface WeatherImageryLayer {
  /** `imagery.<kind>`, in the hidden list when off. */
  id: string;
  name: string;
  description: string;
  matches: (providerId: string) => boolean;
}

export const WEATHER_GROUP_ID = 'weather';

export const WEATHER_IMAGERY: readonly WeatherImageryLayer[] = Object.freeze([
  {
    id: 'imagery.infrared',
    name: 'Satellite clouds',
    description: 'Infrared cloud imagery from five geostationary satellites, clouds only, day and night',
    matches: (p: string) => /infrared/i.test(p),
  },
  {
    id: 'imagery.precipitation',
    name: 'Precipitation',
    description: 'Satellite-estimated rain and snow worldwide (IMERG); hidden close in',
    matches: (p: string) => /imerg|precipitation/i.test(p),
  },
  {
    id: 'imagery.radar',
    name: 'Radar',
    description: 'Weather radar over the US (NOAA MRMS)',
    matches: (p: string) => /radar/i.test(p),
  },
  {
    id: 'imagery.lightning',
    name: 'Lightning',
    description: 'Lightning strike density over the Americas',
    matches: (p: string) => /strike|lightning/i.test(p),
  },
]);

/** The weather switch an overlay answers to, or undefined when it is not weather imagery. */
export function weatherImageryFor(o: Pick<RasterOverlay, 'providerId'>): WeatherImageryLayer | undefined {
  return WEATHER_IMAGERY.find((l) => l.matches(o.providerId));
}

/**
 * Whether weather imagery may show at all under this lens: in the Overview, when its Weather
 * group is on; in another lens, when that lens is about weather (it shows storms or weather
 * alerts) — the Aviation lens is not a place for rain colours.
 */
export function weatherImageryAllowed(
  lens: Pick<LensDefinition, 'id' | 'objectTypes'> | undefined,
  hidden: readonly string[],
): boolean {
  if (!lens || lens.id === OVERVIEW_LENS_ID) return !hidden.includes(WEATHER_GROUP_ID);
  return lens.objectTypes.includes('storm') || lens.objectTypes.includes('weather-alert');
}

/** The overlays to draw: weather imagery only where its switches let it, everything else as it was. */
export function visibleOverlays<T extends Pick<RasterOverlay, 'providerId'>>(
  overlays: readonly T[],
  lens: Pick<LensDefinition, 'id' | 'objectTypes'> | undefined,
  hidden: readonly string[],
): T[] {
  const allowed = weatherImageryAllowed(lens, hidden);
  return overlays.filter((o) => {
    const layer = weatherImageryFor(o);
    return !layer || (allowed && !hidden.includes(layer.id));
  });
}
